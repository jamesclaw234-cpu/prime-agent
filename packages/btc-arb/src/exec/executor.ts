import { roundPriceDown, roundPriceUp, roundQtyDown, validateLimitOrder } from "../binance/filters.js";
import type { UnwindConfig } from "../config.js";
import type { BookStore } from "../core/book.js";
import { aggressivePrice, edgeRateNum, type FeeModel } from "../core/pricing.js";
import type { CycleLeg, CycleOutcome, CycleResult, LegFill, MarketSymbol, Opportunity, SymbolRules } from "../types.js";
import { type Dec, decDiv, decIsPositive, decLt, decMul, decSub, decToNumber, ZERO } from "../util/decimal.js";
import { type Logger, silentLogger } from "../util/logger.js";
import { type ExecutionEngine, newClientOrderId, settleLeg } from "./engine.js";

export interface ExecutorOptions {
	readonly engine: ExecutionEngine;
	readonly store: BookStore;
	readonly rules: ReadonlyMap<MarketSymbol, SymbolRules>;
	readonly fee: FeeModel;
	readonly cycleDeadlineMs: number;
	readonly aggressionTicks: number;
	readonly unwind: UnwindConfig;
	readonly maxBookAgeMs: number;
	readonly logger?: Logger;
	readonly now?: () => number;
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

		for (let index = 0; index < legs.length; index++) {
			const leg = legs[index].leg;

			// Checked between legs rather than as an abort signal on the request itself: aborting an
			// in-flight order leaves us unable to tell whether it executed.
			if (this.now() > deadline) {
				outcome = "aborted_deadline";
				break;
			}

			let attempt: LegAttempt | undefined;
			try {
				attempt = await this.runLeg(leg, index === 0 ? legs[index].quantity : undefined, heldAmount, signal);
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
				outcome = "error";
				this.logger.error("leg failed", { cycle: opportunity.cycle.id, leg: index + 1, error });
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

			if (index === 0) actualAmountIn = attempt.fill.amountIn;
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
		if (!completedAllLegs && executedLegs > 0 && this.options.unwind.enabled) {
			const result = await this.unwind(legs, executedLegs, heldAsset, heldAmount, unwindFills, signal);
			heldAsset = result.asset;
			heldAmount = result.amount;
		}

		// Nothing is recovered unless a leg actually executed. `heldAmount` starts at the *intended*
		// spend, so counting it when leg 1 never filled would book a phantom profit.
		const recovered = executedLegs > 0 && heldAsset === startAsset ? heldAmount : ZERO;
		const strandedAsset = executedLegs > 0 && heldAsset !== startAsset ? heldAsset : undefined;

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
			error,
		};

		this.logger.info("cycle finished", {
			cycle: opportunity.cycle.id,
			outcome,
			legs: executedLegs,
			pnl: decToNumber(realizedPnl),
			expected: decToNumber(opportunity.expectedProfit),
			durationMs: result.finishedAt - startedAt,
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
		signal?: AbortSignal,
	): Promise<LegAttempt | undefined> {
		const rules = this.options.rules.get(leg.symbol);
		if (!rules) return undefined;
		const book = this.options.store.get(leg.symbol);
		if (!book) return undefined;
		if (this.now() - book.receivedAt > this.options.maxBookAgeMs) return undefined;

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

		const outcome = await this.options.engine.placeIoc(
			{ symbol: leg.symbol, side: leg.side, price, quantity, rules, clientOrderId: newClientOrderId() },
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
			latencyMs: outcome.latencyMs,
		};

		return {
			fill,
			filled: decIsPositive(outcome.executedQty) && decIsPositive(settled.amountOut),
			amountOut: settled.amountOut,
		};
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
	): Promise<{ asset: string; amount: Dec }> {
		let asset = startingAsset;
		let amount = startingAmount;

		for (let index = executedLegs - 1; index >= 0; index--) {
			const leg = reverseLeg(legs[index].leg);
			if (leg.fromAsset !== asset) break;
			if (!decIsPositive(amount)) break;

			let filled = false;
			for (let attempt = 0; attempt < Math.max(1, this.options.unwind.maxAttempts); attempt++) {
				let result: LegAttempt | undefined;
				try {
					result = await this.runUnwindLeg(leg, amount, signal);
				} catch (error) {
					// An unwind that throws must not escape: the caller needs the cycle result so it
					// can see, and act on, the inventory that is now stranded.
					this.logger.error("unwind attempt threw", {
						symbol: leg.symbol,
						attempt: attempt + 1,
						error: error instanceof Error ? error.message : String(error),
					});
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

	private async runUnwindLeg(leg: CycleLeg, available: Dec, signal?: AbortSignal): Promise<LegAttempt | undefined> {
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

		const outcome = await this.options.engine.placeIoc(
			{ symbol: leg.symbol, side: leg.side, price, quantity, rules, clientOrderId: newClientOrderId("arbu") },
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
				latencyMs: outcome.latencyMs,
			},
			filled: decIsPositive(outcome.executedQty) && decIsPositive(settled.amountOut),
			amountOut: settled.amountOut,
		};
	}
}
