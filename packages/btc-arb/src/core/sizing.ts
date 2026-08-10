import { maxCompliantQty, roundPriceDown, roundPriceUp, roundQtyDown, validateLimitOrder } from "../binance/filters.js";
import type { Asset, Cycle, LegPlan, MarketSymbol, Opportunity, SymbolRules, TopOfBook } from "../types.js";
import {
	type Dec,
	decDiv,
	decGt,
	decIsPositive,
	decLt,
	decMin,
	decMul,
	decSub,
	decToNumber,
	ONE,
	ZERO,
} from "../util/decimal.js";
import type { BookStore } from "./book.js";
import { aggressivePrice, type FeeModel, quoteCycle } from "./pricing.js";

export interface SizingInputs {
	readonly cycle: Cycle;
	readonly store: BookStore;
	readonly rules: ReadonlyMap<MarketSymbol, SymbolRules>;
	readonly fee: FeeModel;
	/** Fraction of displayed top-of-book size a single leg may consume, 0 to 1. */
	readonly depthUtilization: number;
	readonly aggressionTicks: number;
	/** Upper bound on leg 1's spend, in start-asset units. */
	readonly maxInput: Dec;
	/** Lower bound on leg 1's spend, in start-asset units. Below this the cycle is not worth doing. */
	readonly minInput: Dec;
	readonly minNetEdgeBps: number;
	/** Reject cycles that lose money if every leg fills at the limit price instead of the touch. */
	readonly requireNonNegativeWorstCase: boolean;
	readonly now: number;
	readonly maxBookAgeMs: number;
	/** Converts leg 1's spend into the accounting asset so risk limits can be applied to it. */
	readonly valuation?: { convert(amount: Dec, asset: Asset): Dec | undefined };
}

export type SizingResult =
	| { readonly ok: true; readonly opportunity: Opportunity; readonly worstCaseEdgeBps: number }
	| { readonly ok: false; readonly reason: string; readonly leg?: number };

interface LegContext {
	readonly book: TopOfBook;
	readonly rules: SymbolRules;
	/** Price a marketable order is expected to fill at: the resting touch. */
	readonly touchPrice: Dec;
	/** Price actually sent, `aggressionTicks` through the touch. Bounds the worst case. */
	readonly limitPrice: Dec;
	/** Displayed size at the touch, scaled by `depthUtilization`. */
	readonly capacity: Dec;
}

interface ForwardPass {
	readonly plans: LegPlan[];
	readonly amountIn: Dec;
	readonly amountOut: Dec;
	/** Residual left behind by lot rounding at each leg, keyed by the asset it is stranded in. */
	readonly dust: Map<Asset, Dec>;
}

function fail(reason: string, leg?: number): SizingResult {
	return { ok: false, reason, leg };
}

/**
 * Turns a screened cycle into a concrete, filter-compliant, exactly-priced plan - or rejects it.
 *
 * The screening pass in `pricing.ts` answers "does an edge appear to exist". This answers the only
 * question that matters: "after depth caps, lot rounding, minimum notionals and the worst fill
 * price we are willing to accept, is there still money in it". Most screened cycles die here, and
 * that is the function working correctly.
 */
export function planOpportunity(inputs: SizingInputs): SizingResult {
	const { cycle, store, rules, fee, now, maxBookAgeMs } = inputs;

	const quote = quoteCycle(cycle, store, fee, now, maxBookAgeMs);
	if (!quote) return fail("book missing or stale");

	const contexts: LegContext[] = [];
	const depthScale = fractionToDec(inputs.depthUtilization);

	for (let index = 0; index < cycle.legs.length; index++) {
		const leg = cycle.legs[index];
		const book = store.get(leg.symbol);
		if (!book) return fail("book missing", index);
		const rule = rules.get(leg.symbol);
		if (!rule) return fail("symbol rules missing", index);

		const touchPrice = leg.side === "BUY" ? book.ask : book.bid;
		const rawLimit = aggressivePrice(book, leg, rule.tickSize, inputs.aggressionTicks);
		const limitPrice = leg.side === "BUY" ? roundPriceUp(rule, rawLimit) : roundPriceDown(rule, rawLimit);
		if (!decIsPositive(limitPrice)) return fail("limit price collapsed to zero", index);

		const displayed = leg.side === "BUY" ? book.askQty : book.bidQty;
		contexts.push({
			book,
			rules: rule,
			touchPrice,
			limitPrice,
			capacity: decMul(displayed, depthScale),
		});
	}

	const maxInput = capacityBoundedInput(cycle, contexts, fee, inputs.maxInput);
	if (!decIsPositive(maxInput)) return fail("no capacity at the touch");
	if (decLt(maxInput, inputs.minInput)) return fail("capacity below the minimum cycle size");

	const expected = simulateForward(cycle, contexts, fee, maxInput, "touch");
	if (typeof expected === "string") return fail(expected);

	if (!decIsPositive(expected.amountIn)) return fail("leg 1 rounded down to nothing");
	if (decLt(expected.amountIn, inputs.minInput)) return fail("post-rounding size below the minimum cycle size");

	// Validate the orders we would actually send, at the prices we would actually send them.
	for (let index = 0; index < expected.plans.length; index++) {
		const plan = expected.plans[index];
		const context = contexts[index];
		const check = validateLimitOrder(context.rules, plan.leg.side, plan.price, plan.quantity, context.touchPrice);
		if (!check.ok) return fail(`${check.filter}: ${check.detail}`, index);
	}

	const profit = decSub(expected.amountOut, expected.amountIn);
	const netEdgeBps = decToNumber(decDiv(profit, expected.amountIn)) * 10_000;
	if (netEdgeBps < inputs.minNetEdgeBps) {
		return fail(`net edge ${netEdgeBps.toFixed(2)}bps below the ${inputs.minNetEdgeBps}bps threshold`);
	}

	const worst = simulateForward(cycle, contexts, fee, maxInput, "limit");
	let worstCaseEdgeBps = Number.NEGATIVE_INFINITY;
	if (typeof worst !== "string" && decIsPositive(worst.amountIn)) {
		worstCaseEdgeBps = decToNumber(decDiv(decSub(worst.amountOut, worst.amountIn), worst.amountIn)) * 10_000;
	}
	if (inputs.requireNonNegativeWorstCase && !(worstCaseEdgeBps >= 0)) {
		return fail(`worst-case edge ${formatBps(worstCaseEdgeBps)} is negative at the limit price`);
	}

	const opportunity: Opportunity = {
		id: `${cycle.id}@${now}`,
		cycle,
		quote,
		legs: expected.plans,
		amountIn: expected.amountIn,
		expectedOut: expected.amountOut,
		expectedProfit: profit,
		netEdgeBps,
		notionalInAccountingAsset: inputs.valuation?.convert(expected.amountIn, cycle.startAsset) ?? expected.amountIn,
		detectedAt: now,
	};

	return { ok: true, opportunity, worstCaseEdgeBps };
}

/**
 * Largest leg-1 spend for which no leg exceeds the size displayed at its touch.
 *
 * Each leg's order quantity is a fixed multiple of the input amount, so the displayed-size cap on
 * leg `i` back-propagates to a cap on the input. The binding constraint is the smallest of them.
 * Sizing past the touch would mean walking the book, and the second price level is exactly where a
 * few-basis-point edge stops existing.
 */
function capacityBoundedInput(cycle: Cycle, contexts: readonly LegContext[], fee: FeeModel, requestedMax: Dec): Dec {
	let bound = requestedMax;
	// `flow` is the amount of the current leg's input asset produced by one unit of start asset.
	let flow: Dec = ONE;

	for (let index = 0; index < cycle.legs.length; index++) {
		const leg = cycle.legs[index];
		const context = contexts[index];
		if (!decIsPositive(context.capacity)) return ZERO;

		// Base-asset quantity traded on this leg per unit of start asset.
		const qtyPerUnit = leg.side === "SELL" ? flow : decDiv(flow, context.touchPrice);
		if (!decIsPositive(qtyPerUnit)) return ZERO;

		const legBound = decDiv(context.capacity, qtyPerUnit);
		bound = decMin(bound, legBound);

		flow =
			leg.side === "SELL"
				? decMul(decMul(flow, context.touchPrice), fee.takerMultiplier)
				: decMul(qtyPerUnit, fee.takerMultiplier);
	}

	return bound;
}

/**
 * Walks the cycle forward, applying lot rounding and filter minimums at every leg.
 *
 * Rounding is always down. That is what makes this pass necessary rather than cosmetic: a cycle
 * whose gross edge is 12bps can round to a loss when a leg's step size is coarse relative to the
 * size being traded, and the only way to know is to re-derive the whole chain from the rounded
 * quantities.
 *
 * The residual each rounding leaves behind is real inventory in an intermediate asset. It is
 * recorded as dust and valued at zero in the profit figure, which is the conservative treatment:
 * it usually sits below the minimum notional needed to trade it back.
 */
function simulateForward(
	cycle: Cycle,
	contexts: readonly LegContext[],
	fee: FeeModel,
	startAmount: Dec,
	priceMode: "touch" | "limit",
): ForwardPass | string {
	const plans: LegPlan[] = [];
	const dust = new Map<Asset, Dec>();
	let amount = startAmount;
	let amountIn = ZERO;

	for (let index = 0; index < cycle.legs.length; index++) {
		const leg = cycle.legs[index];
		const context = contexts[index];
		const price = priceMode === "touch" ? context.touchPrice : context.limitPrice;
		if (!decIsPositive(price)) return `leg ${index + 1}: non-positive price`;
		if (!decIsPositive(amount)) return `leg ${index + 1}: nothing left to trade`;

		const rawQty = leg.side === "SELL" ? amount : decDiv(amount, price);
		let quantity = roundQtyDown(context.rules, rawQty);
		quantity = maxCompliantQty(context.rules, price, quantity);
		if (!decIsPositive(quantity)) return `leg ${index + 1}: quantity rounds to zero at this size`;
		if (decIsPositive(context.rules.minQty) && decLt(quantity, context.rules.minQty)) {
			return `leg ${index + 1}: quantity below LOT_SIZE minQty`;
		}

		const notional = decMul(price, quantity);
		if (decIsPositive(context.rules.minNotional) && decLt(notional, context.rules.minNotional)) {
			return `leg ${index + 1}: notional below the exchange minimum`;
		}

		const spent = leg.side === "SELL" ? quantity : notional;
		if (decGt(spent, amount)) return `leg ${index + 1}: rounding produced an overspend`;

		const received =
			leg.side === "SELL" ? decMul(notional, fee.takerMultiplier) : decMul(quantity, fee.takerMultiplier);
		if (!decIsPositive(received)) return `leg ${index + 1}: received amount rounds to zero`;

		const residual = decSub(amount, spent);
		if (index > 0 && decIsPositive(residual)) {
			dust.set(leg.fromAsset, ((dust.get(leg.fromAsset) ?? ZERO) + residual) as Dec);
		}

		plans.push({
			leg,
			price: context.limitPrice,
			quantity,
			notional,
			amountIn: spent,
			expectedOut: received,
			referencePrice: context.touchPrice,
		});

		if (index === 0) amountIn = spent;
		amount = received;
	}

	return { plans, amountIn, amountOut: amount, dust };
}

/** Converts a 0-to-1 fraction into a `Dec` at nine significant digits, which is ample for a cap. */
function fractionToDec(fraction: number): Dec {
	const clamped = Math.min(1, Math.max(0, fraction));
	return (BigInt(Math.round(clamped * 1e9)) * 1_000_000_000n) as Dec;
}

function formatBps(value: number): string {
	return Number.isFinite(value) ? `${value.toFixed(2)}bps` : "unavailable";
}
