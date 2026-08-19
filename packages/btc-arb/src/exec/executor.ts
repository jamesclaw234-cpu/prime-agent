import { roundPriceDown, roundPriceUp, roundQtyDown, validateLimitOrder } from "../binance/filters.js";
import { BinanceApiError } from "../binance/rest-client.js";
import type { UnwindConfig } from "../config.js";
import type { BookStore } from "../core/book.js";
import { aggressivePrice, edgeRateNum, type FeeModel } from "../core/pricing.js";
import type { CycleLeg, CycleOutcome, CycleResult, LegFill, MarketSymbol, Opportunity, SymbolRules } from "../types.js";
import { type Dec, decAdd, decDiv, decIsPositive, decLt, decMul, decSub, decToNumber, ZERO } from "../util/decimal.js";
import { type Logger, silentLogger } from "../util/logger.js";
import { type ExecutionEngine, NOT_PLACED, newClientOrderId, settleLeg } from "./engine.js";

export interface ExecutorOptions {
	readonly engine: ExecutionEngine;
	readonly store: BookStore;
	readonly rules: ReadonlyMap<MarketSymbol, SymbolRules>;
	readonly fee: FeeModel;
	readonly cycleDeadlineMs: number;
	readonly aggressionTicks: number;
	readonly unwind: UnwindConfig;
	readonly maxBookAgeMs: number;
	/**
	 * Upper bound for the per-symbol freshness window, matching the detector's.
	 *
	 * This MUST be the same window the detector plans with. An earlier version kept the executor
	 * on the strict base window "to be safe", which meant the detector deliberately planned
	 * thin-venue cycles whose later legs the executor was guaranteed to refuse - and a refusal on
	 * leg 2 or 3 lands after leg 1 has committed funds, forcing an unwind that pays fees and
	 * spread twice for nothing. The strictness fired exactly one leg too late to protect anything.
	 * The IOC limit price is what actually bounds a moved book: if the quote is gone, the order
	 * simply does not fill.
	 */
	readonly maxBookAgeCeilingMs?: number;
	readonly logger?: Logger;
	readonly now?: () => number;
	/** Called immediately before every outbound order, including unwind retries. */
	readonly onOrderSent?: () => void;
}

interface LegAttempt {
	readonly fill: LegFill;
	readonly filled: boolean;
	readonly amountOut: Dec;
}

/** Flips a leg so it converts back the way it came. */
export function reverseLeg(leg: CycleLeg): CycleLeg {
	return {
		symbol: leg.symbol,
		side: leg.side === "BUY" ? "SELL" : "BUY",
		fromAsset: leg.toAsset,
		toAsset: leg.fromAsset,
	};
}

/**
 * Runs one arbitrage cycle leg by leg.
 *
 * A three-leg cycle is not atomic, and pretending otherwise is how these bots lose money. Every
 * leg after the first is re-sized from the quantity the previous leg *actually* produced, net of
 * commission, and re-priced against the *current* book rather than the book that triggered the
 * signal. Between legs the executor asks whether finishing the cycle is still better than
 * reversing out of it, and takes whichever is worth more.
 */
export class CycleExecutor {
	private readonly logger: Logger;
	private readonly now: () => number;

	constructor(private readonly options: ExecutorOptions) {
		this.logger = options.logger ?? silentLogger();
		this.now = options.now ?? Date.now;
	}

	async execute(opportunity: Opportunity, signal?: AbortSignal): Promise<CycleResult> {
		const startedAt = this.now();
		const deadline = startedAt + this.options.cycleDeadlineMs;
		const legs = opportunity.legs;
		const fills: LegFill[] = [];
		const unwindFills: LegFill[] = [];

		let heldAsset = opportunity.cycle.startAsset;
		let heldAmount = opportunity.amountIn;
		let actualAmountIn = ZERO;
		let executedLegs = 0;
		let outcome: CycleOutcome = "completed";
		let error: string | undefined;
		let needsReconciliation = false;
		/** Amount left behind in a leg's input asset when that leg only partially consumed it. */
		const residuals: { legIndex: number; asset: string; amount: Dec }[] = [];

		for (let index = 0; index < legs.length; index++) {
			const leg = legs[index].leg;

			// Checked between legs rather than as an abort signal on the request itself: aborting an
			// in-flight order leaves us unable to tell whether it executed.
			if (this.now() > deadline) {
				outcome = "aborted_deadline";
				break;
			}

			// Generated up front so an ambiguous failure can still be looked up by client id.
			const clientOrderId = newClientOrderId();
			let attempt: LegAttempt | undefined;
			try {
				attempt = await this.runLeg(
					leg,
					index === 0 ? legs[index].quantity : undefined,
					heldAmount,
					clientOrderId,
					signal,
				);
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
				outcome = "error";
				const ambiguous = caught instanceof BinanceApiError && caught.ambiguous;
				// An ambiguous failure may have executed. Asking the exchange what happened is safe
				// where re-sending is not, and in the common case it proves the order never landed,
				// which turns a halt back into an ordinary missed leg.
				needsReconciliation = ambiguous && !(await this.provenNotPlaced(leg, clientOrderId, signal));
				this.logger.error("leg failed", {
					cycle: opportunity.cycle.id,
					leg: index + 1,
					ambiguous,
					resolved: ambiguous && !needsReconciliation,
					error,
				});
				break;
			}

			if (!attempt) {
				// The leg could not be sent: the book moved, went stale, or the size stopped
				// clearing the exchange minimums between detection and dispatch.
				outcome = "aborted_edge_gone";
				break;
			}

			fills.push(attempt.fill);
			if (!attempt.filled) {
				outcome = "aborted_no_fill";
				break;
			}

			if (index === 0) {
				actualAmountIn = attempt.fill.amountIn;
			} else {
				// A partial fill leaves the unconsumed part of the previous leg's output sitting in
				// an intermediate asset. Left unrecorded it becomes an invisible position and the
				// cycle books a loss that never happened, so it is retraced back to the start asset
				// once the main path is done.
				const residual = decSub(heldAmount, attempt.fill.amountIn);
				if (decIsPositive(residual)) residuals.push({ legIndex: index, asset: leg.fromAsset, amount: residual });
			}
			heldAsset = leg.toAsset;
			heldAmount = attempt.amountOut;
			executedLegs = index + 1;

			if (index < legs.length - 1 && this.shouldUnwind(legs, index)) {
				outcome = "unwound";
				break;
			}
		}

		const startAsset = opportunity.cycle.startAsset;
		const completedAllLegs = executedLegs === legs.length && outcome === "completed";

		// Unwinding after an ambiguous failure would trade against a position we cannot confirm.
		// Freezing and handing it to the operator is the only safe response.
		const canUnwind = this.options.unwind.enabled && !needsReconciliation;
		// Retrace each partial-fill residual back to the start asset. Each one sits in the input
		// asset of the leg that under-consumed it, so the path back is that leg's predecessors.
		let recoveredResidual = ZERO;
		const dust = new Map<string, Dec>();
		// A leftover too small to form a legal order is dust wherever it arises. The residual path
		// below has always classified it that way; the MAIN unwind path used to ignore the flag, so
		// the identical unsellable sliver reached via a failed later leg was reported as stranded
		// inventory and - with haltOnStranded on - stopped the whole bot over an amount that no
		// order can sell and no operator can reconcile.
		let mainPathDust = false;
		if (!completedAllLegs && executedLegs > 0 && canUnwind) {
			const result = await this.unwind(legs, executedLegs, heldAsset, heldAmount, unwindFills, signal);
			heldAsset = result.asset;
			heldAmount = result.amount;
			if (result.ambiguous) needsReconciliation = true;
			if (result.dust && result.asset !== startAsset && decIsPositive(result.amount)) {
				dust.set(result.asset, decAdd(dust.get(result.asset) ?? ZERO, result.amount));
				mainPathDust = true;
			}
		}

		if (canUnwind && !needsReconciliation) {
			for (const residual of residuals) {
				const result = await this.unwind(
					legs,
					residual.legIndex,
					residual.asset,
					residual.amount,
					unwindFills,
					signal,
				);
				if (result.ambiguous) {
					needsReconciliation = true;
					break;
				}
				if (result.asset === startAsset) {
					recoveredResidual = (recoveredResidual + result.amount) as Dec;
				} else if (result.dust) {
					// Untradeable by construction. Left in the account, and left out of the PnL, which
					// understates the result by the value of the dust - the safe direction to be wrong.
					dust.set(result.asset, decAdd(dust.get(result.asset) ?? ZERO, result.amount));
				} else {
					this.logger.warn("partial-fill residual could not be retraced", {
						asset: result.asset,
						amount: decToNumber(result.amount),
					});
				}
			}
		}

		if (needsReconciliation) {
			// Keep the underlying cause and append the instruction: the operator needs both the
			// exchange's own message and to know that the recorded position cannot be trusted.
			const note = "position may be inconsistent, reconcile manually";
			error = error ? `${error} (${note})` : `an order failed ambiguously; ${note}`;
		}

		// Nothing is recovered unless a leg actually executed. `heldAmount` starts at the *intended*
		// spend, so counting it when leg 1 never filled would book a phantom profit.
		const recovered =
			executedLegs > 0 && heldAsset === startAsset ? ((heldAmount + recoveredResidual) as Dec) : recoveredResidual;
		// Dust is not stranded: stranded means "a position is sitting there that should be flattened",
		// and a below-minimum sliver cannot be flattened by anyone. It is already recorded in the
		// dust map and excluded from the recovered amount, which understates PnL - the safe side.
		const strandedAsset = executedLegs > 0 && heldAsset !== startAsset && !mainPathDust ? heldAsset : undefined;

		if (completedAllLegs) {
			outcome = "completed";
		} else if (outcome === "completed") {
			// The loop exited without recording a reason; classify by what actually happened.
			outcome = executedLegs === 0 ? "aborted_no_fill" : strandedAsset ? "stranded" : "unwound";
		}

		const amountIn = decIsPositive(actualAmountIn) ? actualAmountIn : ZERO;
		const realizedPnl = decSub(recovered, amountIn);

		const result: CycleResult = {
			opportunityId: opportunity.id,
			cycleId: opportunity.cycle.id,
			mode: this.options.engine.mode,
			outcome,
			startedAt,
			finishedAt: this.now(),
			fills,
			unwindFills,
			amountIn,
			amountOut: recovered,
			realizedPnl,
			realizedPnlAsset: opportunity.cycle.startAsset,
			strandedAsset,
			strandedAmount: strandedAsset ? heldAmount : undefined,
			expectedProfit: opportunity.expectedProfit,
			slippage: decSub(realizedPnl, opportunity.expectedProfit),
			needsReconciliation,
			error,
		};

		this.logger.info("cycle finished", {
			cycle: opportunity.cycle.id,
			outcome,
			legs: executedLegs,
			pnl: decToNumber(realizedPnl),
			expected: decToNumber(opportunity.expectedProfit),
			durationMs: result.finishedAt - startedAt,
			// Small by definition, but it accumulates across a 24/7 run, so it is reported rather
			// than dropped. Anything here is sitting in the account, not lost.
			...(dust.size > 0
				? { dust: Object.fromEntries([...dust].map(([asset, amount]) => [asset, decToNumber(amount)])) }
				: {}),
		});

		return result;
	}

	/**
	 * Sends one leg, sized from what we actually hold and priced off the current book.
	 *
	 * Returns `undefined` when the leg cannot be sent at all - a stale book, a quantity that no
	 * longer clears the exchange minimums, or a price that would not cross. Not sending is always
	 * cheaper than sending an order that is rejected.
	 */
	private async runLeg(
		leg: CycleLeg,
		fixedQuantity: Dec | undefined,
		available: Dec,
		clientOrderId: string,
		signal?: AbortSignal,
	): Promise<LegAttempt | undefined> {
		const rules = this.options.rules.get(leg.symbol);
		if (!rules) return undefined;
		const book = this.options.store.get(leg.symbol);
		if (!book) return undefined;
		const ageLimit = this.options.store.ageLimitFor(
			leg.symbol,
			this.options.maxBookAgeMs,
			this.options.maxBookAgeCeilingMs ?? 0,
		);
		if (this.now() - book.receivedAt > ageLimit) return undefined;

		const raw = aggressivePrice(book, leg, rules.tickSize, this.options.aggressionTicks);
		const price = leg.side === "BUY" ? roundPriceUp(rules, raw) : roundPriceDown(rules, raw);
		if (!decIsPositive(price)) return undefined;

		const desired = fixedQuantity ?? this.quantityFor(leg, rules, price, available);
		const quantity = roundQtyDown(rules, desired);
		if (!decIsPositive(quantity)) return undefined;

		// Leg 1's quantity was sized against a budget; later legs are capped by real inventory.
		const spend = leg.side === "SELL" ? quantity : decMul(price, quantity);
		if (fixedQuantity === undefined && decLt(available, spend)) return undefined;

		const check = validateLimitOrder(rules, leg.side, price, quantity, leg.side === "BUY" ? book.ask : book.bid);
		if (!check.ok) {
			this.logger.debug("leg failed local validation", {
				symbol: leg.symbol,
				side: leg.side,
				filter: check.filter,
				detail: check.detail,
			});
			return undefined;
		}

		this.options.onOrderSent?.();
		const outcome = await this.options.engine.placeIoc(
			{ symbol: leg.symbol, side: leg.side, price, quantity, rules, clientOrderId },
			signal,
		);
		const settled = settleLeg(leg, outcome);

		const fill: LegFill = {
			leg,
			requestedQty: quantity,
			executedQty: outcome.executedQty,
			quoteQty: outcome.quoteQty,
			amountIn: settled.amountIn,
			amountOut: settled.amountOut,
			commissions: settled.commissions,
			avgPrice: settled.avgPrice,
			orderId: outcome.orderId,
			clientOrderId: outcome.clientOrderId,
			status: outcome.status,
			expiryReason: outcome.expiryReason,
			latencyMs: outcome.latencyMs,
		};

		return {
			fill,
			filled: decIsPositive(outcome.executedQty) && decIsPositive(settled.amountOut),
			amountOut: settled.amountOut,
		};
	}

	/**
	 * Asks the exchange whether an order that failed ambiguously actually reached the book.
	 *
	 * Only a definite "it never existed" is treated as an answer. A found order, an engine with no
	 * resolver, or a query that itself fails all leave the position uncertain, which is exactly the
	 * situation a human is supposed to look at.
	 */
	private async provenNotPlaced(leg: CycleLeg, clientOrderId: string, signal?: AbortSignal): Promise<boolean> {
		const resolve = this.options.engine.resolveOrder?.bind(this.options.engine);
		if (!resolve) return false;
		try {
			const outcome = await resolve(leg.symbol, clientOrderId, signal);
			return outcome?.status === NOT_PLACED;
		} catch {
			return false;
		}
	}

	/**
	 * True when the amount is too small to form a legal order on this leg, at any price we would use.
	 *
	 * This is the ordinary end state of a triangular cycle, not a fault. Commission is deducted from
	 * the asset received, so each leg's output lands off the next symbol's lot grid and a sliver is
	 * always left behind. It cannot be sold - it is below `minQty` or `minNotional` - so retrying it
	 * and then logging "inventory stranded" reports a failure on every healthy cycle, which teaches
	 * the operator to ignore the one line that means a real position is sitting there unhedged.
	 *
	 * A missing book is deliberately not dust: it means we cannot tell, and the caller should keep
	 * treating it as a failed unwind.
	 */
	private belowExchangeMinimum(leg: CycleLeg, amount: Dec): boolean {
		const rules = this.options.rules.get(leg.symbol);
		const book = this.options.store.get(leg.symbol);
		if (!rules || !book) return false;

		const raw = aggressivePrice(book, leg, rules.tickSize, this.options.unwind.aggressionTicks);
		const price = leg.side === "BUY" ? roundPriceUp(rules, raw) : roundPriceDown(rules, raw);
		if (!decIsPositive(price)) return false;

		const quantity = this.quantityFor(leg, rules, price, amount);
		if (!decIsPositive(quantity)) return true;
		if (decIsPositive(rules.minQty) && decLt(quantity, rules.minQty)) return true;
		return decIsPositive(rules.minNotional) && decLt(decMul(price, quantity), rules.minNotional);
	}

	/** Base-asset quantity implied by holding `available` of the leg's input asset. */
	private quantityFor(leg: CycleLeg, rules: SymbolRules, price: Dec, available: Dec): Dec {
		const raw = leg.side === "SELL" ? available : decDiv(available, price);
		return roundQtyDown(rules, raw);
	}

	/**
	 * Decides whether reversing out is worth more than finishing the cycle.
	 *
	 * Both paths cost the same number of taker fees, so this is purely about which set of prices
	 * has moved. When the remaining legs have gone against us far enough that retracing the
	 * executed legs returns more, retracing is the cheaper way back to the start asset.
	 */
	private shouldUnwind(legs: Opportunity["legs"], completedIndex: number): boolean {
		if (!this.options.unwind.enabled) return false;
		const forward = this.pathMultiple(legs.slice(completedIndex + 1).map((plan) => plan.leg));
		const backward = this.pathMultiple(
			legs
				.slice(0, completedIndex + 1)
				.map((plan) => reverseLeg(plan.leg))
				.reverse(),
		);
		if (forward === undefined) return backward !== undefined;
		if (backward === undefined) return false;
		return backward > forward;
	}

	/** Product of the current fee-adjusted rates along a path, or `undefined` if any book is missing. */
	private pathMultiple(legs: readonly CycleLeg[]): number | undefined {
		let multiple = 1;
		for (const leg of legs) {
			const book = this.options.store.get(leg.symbol);
			if (!book) return undefined;
			multiple *= edgeRateNum(book, leg.side, this.options.fee.takerMultiplierNum);
		}
		return multiple;
	}

	/**
	 * Flattens residual inventory back to the start asset.
	 *
	 * Retraces the executed legs in reverse with extra price aggression, because an unwind that
	 * does not fill is worse than an unwind that fills badly: the alternative is holding an
	 * unhedged position in an asset we never wanted. Attempts are bounded so a market that has
	 * gapped away cannot trap the bot in a retry loop.
	 */
	private async unwind(
		legs: Opportunity["legs"],
		executedLegs: number,
		startingAsset: string,
		startingAmount: Dec,
		record: LegFill[],
		signal?: AbortSignal,
	): Promise<{ asset: string; amount: Dec; ambiguous?: boolean; dust?: boolean }> {
		let asset = startingAsset;
		let amount = startingAmount;

		for (let index = executedLegs - 1; index >= 0; index--) {
			const leg = reverseLeg(legs[index].leg);
			if (leg.fromAsset !== asset) break;
			if (!decIsPositive(amount)) break;

			// Checked before the attempts, not after three of them: nothing about an amount below the
			// exchange minimum changes on a retry, and the retries sit inside the cycle deadline.
			if (this.belowExchangeMinimum(leg, amount)) {
				this.logger.debug("residual is below the exchange minimum, left as dust", {
					symbol: leg.symbol,
					asset,
					amount: decToNumber(amount),
				});
				return { asset, amount, dust: true };
			}

			let filled = false;
			for (let attempt = 0; attempt < Math.max(1, this.options.unwind.maxAttempts); attempt++) {
				const clientOrderId = newClientOrderId("arbu");
				let result: LegAttempt | undefined;
				try {
					result = await this.runUnwindLeg(leg, amount, clientOrderId, signal);
				} catch (error) {
					// An unwind that throws must not escape: the caller needs the cycle result so it
					// can see, and act on, the inventory that is now stranded.
					const ambiguous = error instanceof BinanceApiError && error.ambiguous;
					// A timeout or 5xx may still have executed. Re-sending would flatten the same
					// inventory twice and leave the account short, which is worse than the position
					// we are trying to escape - unless the exchange confirms nothing was placed.
					const retryable = !ambiguous || (await this.provenNotPlaced(leg, clientOrderId, signal));
					this.logger.error("unwind attempt threw", {
						symbol: leg.symbol,
						attempt: attempt + 1,
						ambiguous,
						retryable,
						error: error instanceof Error ? error.message : String(error),
					});
					if (!retryable) return { asset, amount, ambiguous: true };
					continue;
				}
				if (!result) continue;
				record.push(result.fill);
				if (result.filled) {
					asset = leg.toAsset;
					amount = result.amountOut;
					filled = true;
					break;
				}
			}

			if (!filled) {
				this.logger.error("unwind leg failed, inventory stranded", {
					symbol: leg.symbol,
					side: leg.side,
					asset,
					amount: decToNumber(amount),
				});
				break;
			}
		}

		return { asset, amount };
	}

	private async runUnwindLeg(
		leg: CycleLeg,
		available: Dec,
		clientOrderId: string,
		signal?: AbortSignal,
	): Promise<LegAttempt | undefined> {
		const rules = this.options.rules.get(leg.symbol);
		const book = this.options.store.get(leg.symbol);
		if (!rules || !book) return undefined;

		const raw = aggressivePrice(book, leg, rules.tickSize, this.options.unwind.aggressionTicks);
		const price = leg.side === "BUY" ? roundPriceUp(rules, raw) : roundPriceDown(rules, raw);
		if (!decIsPositive(price)) return undefined;

		const quantity = this.quantityFor(leg, rules, price, available);
		if (!decIsPositive(quantity)) return undefined;
		const check = validateLimitOrder(rules, leg.side, price, quantity, leg.side === "BUY" ? book.ask : book.bid);
		if (!check.ok) return undefined;

		this.options.onOrderSent?.();
		const outcome = await this.options.engine.placeIoc(
			{ symbol: leg.symbol, side: leg.side, price, quantity, rules, clientOrderId },
			signal,
		);
		const settled = settleLeg(leg, outcome);

		return {
			fill: {
				leg,
				requestedQty: quantity,
				executedQty: outcome.executedQty,
				quoteQty: outcome.quoteQty,
				amountIn: settled.amountIn,
				amountOut: settled.amountOut,
				commissions: settled.commissions,
				avgPrice: settled.avgPrice,
				orderId: outcome.orderId,
				clientOrderId: outcome.clientOrderId,
				status: outcome.status,
				expiryReason: outcome.expiryReason,
				latencyMs: outcome.latencyMs,
			},
			filled: decIsPositive(outcome.executedQty) && decIsPositive(settled.amountOut),
			amountOut: settled.amountOut,
		};
	}
}
