import type { Cycle, CycleLeg, CycleQuote, OrderSide, TopOfBook } from "../types.js";
import {
	type Dec,
	decAdd,
	decDiv,
	decFromBps,
	decFromString,
	decIsPositive,
	decMax,
	decMul,
	decSub,
	decToBps,
	decToNumber,
	ONE,
	ZERO,
} from "../util/decimal.js";
import type { BookStore } from "./book.js";

/**
 * Taker fee model: one scalar rate, applied in kind to the asset received on each leg.
 *
 * That matches how Binance settles a spot taker fill when the BNB discount is not in play. With
 * the discount active the commission is debited in BNB instead; charging it in kind at the same
 * percentage is economically equivalent to within the BNB conversion spread, and errs by sizing
 * the next leg fractionally small rather than fractionally large.
 *
 * The rate itself comes from `effectiveTakerBps`, not from a guess: the fee is what every cycle
 * has to clear, so it is the one input where being wrong low turns losses into apparent profits.
 */
export interface FeeModel {
	/** Taker rate as a fraction, e.g. 0.001 for 10bps. */
	readonly takerRate: Dec;
	/** `1 - takerRate`, the fraction of a fill that survives commission. */
	readonly takerMultiplier: Dec;
	readonly takerMultiplierNum: number;
	readonly takerBps: number;
}

/**
 * Effective taker rate for one symbol, in basis points, from a commission-rates response.
 *
 * Three components are charged and summed: standard, tax and special. Within each, the side rate
 * (`buyer` on a BUY, `seller` on a SELL) is ADDED to the `taker` rate rather than replacing it.
 * The worse of the two sides is taken, because the model carries a single scalar rate and a
 * cycle's legs run in both directions - over-stating the fee costs missed trades, under-stating it
 * books losses as profits.
 *
 * The BNB discount is deliberately not modelled: it applies only to the standard component, and
 * the published examples disagree on whether the `discount` field is the multiplier or the
 * reduction. Ignoring it over-states the fee, which is the safe direction.
 */
export function effectiveTakerBps(commission: {
	standardCommission?: { taker: string; buyer: string; seller: string };
	taxCommission?: { taker: string; buyer: string; seller: string };
	specialCommission?: { taker: string; buyer: string; seller: string };
}): number {
	let total = ZERO;
	for (const part of [commission.standardCommission, commission.taxCommission, commission.specialCommission]) {
		if (!part) continue;
		const taker = decFromString(part.taker);
		const worseSide = decMax(decFromString(part.buyer), decFromString(part.seller));
		total = decAdd(total, decAdd(taker, worseSide));
	}
	return decToBps(total);
}

/** True when anything beyond the standard component is charged, which varies per symbol. */
export function hasNonStandardCommission(commission: {
	standardCommission?: { taker: string; buyer: string; seller: string };
	taxCommission?: { taker: string; buyer: string; seller: string };
	specialCommission?: { taker: string; buyer: string; seller: string };
}): boolean {
	for (const part of [commission.taxCommission, commission.specialCommission]) {
		if (!part) continue;
		for (const value of [part.taker, part.buyer, part.seller]) {
			if (decIsPositive(decFromString(value))) return true;
		}
	}
	return false;
}

export function makeFeeModel(takerBps: number): FeeModel {
	const takerRate = decFromBps(takerBps);
	const takerMultiplier = decSub(ONE, takerRate);
	return {
		takerRate,
		takerMultiplier,
		takerMultiplierNum: decToNumber(takerMultiplier),
		takerBps,
	};
}

/**
 * Fee-adjusted conversion rate of one leg, in float.
 *
 * `SELL` hands over one unit of the base asset and receives `bid` of the quote asset; `BUY` hands
 * over one unit of the quote asset and receives `1 / ask` of the base asset. Both use the side of
 * the book that a marketable order actually consumes - never the mid, which is the classic way to
 * manufacture arbitrage that does not exist.
 */
export function edgeRateNum(book: TopOfBook, side: OrderSide, takerMultiplierNum: number): number {
	return side === "SELL" ? book.bidNum * takerMultiplierNum : takerMultiplierNum / book.askNum;
}

/** Exact fee-adjusted conversion rate of one leg. */
export function edgeRate(book: TopOfBook, side: OrderSide, fee: FeeModel): Dec {
	return side === "SELL" ? decMul(book.bid, fee.takerMultiplier) : decDiv(fee.takerMultiplier, book.ask);
}

/**
 * Prices a whole cycle in float.
 *
 * This is the screening pass that runs on every book update. Float is used deliberately: it is
 * roughly an order of magnitude faster than BigInt and carries ~15 significant digits, far more
 * than the basis-point resolution the screen needs. Nothing here can send an order - a candidate
 * that clears the screen is always re-derived exactly in `sizing.ts` before execution.
 */
export function quoteCycle(
	cycle: Cycle,
	store: BookStore,
	fee: FeeModel,
	now: number,
	maxBookAgeMs: number,
	/** Upper bound for the per-symbol window. Equal to or below `maxBookAgeMs` disables widening. */
	ageCeilingMs = 0,
	/** Maximum spread between the freshest and stalest quote in the cycle. Zero disables the check. */
	maxSkewMs = 0,
): CycleQuote | undefined {
	let multiple = 1;
	let oldest = 0;
	// Skew is tracked only over ACTIVE legs - those within the base window. An active symbol's
	// receivedAt tracks market time, so a wide spread between two active quotes really does mean
	// the cycle was assembled from different moments. A thin symbol's receivedAt tracks nothing but
	// its own last change; measuring it against an active leg's would reject every mixed cycle the
	// widened window exists to admit, which is exactly what an earlier version of this check did.
	// Thin legs are vouched for by their own cadence-derived window instead.
	let activeOldest = 0;
	let activeNewest = Number.POSITIVE_INFINITY;

	for (const leg of cycle.legs) {
		const book = store.get(leg.symbol);
		if (!book) return undefined;
		const age = now - book.receivedAt;
		if (age > store.ageLimitFor(leg.symbol, maxBookAgeMs, ageCeilingMs)) return undefined;
		if (age > oldest) oldest = age;
		if (age <= maxBookAgeMs) {
			if (age > activeOldest) activeOldest = age;
			if (age < activeNewest) activeNewest = age;
		}
		multiple *= edgeRateNum(book, leg.side, fee.takerMultiplierNum);
	}

	// Two active quotes far apart in receivedAt describe a market that existed at no single
	// instant, and the apparent edge is usually just the newer leg having moved. Age alone cannot
	// catch it: both quotes pass any window wide enough to admit the older one.
	if (maxSkewMs > 0 && activeNewest < Number.POSITIVE_INFINITY && activeOldest - activeNewest > maxSkewMs) {
		return undefined;
	}

	return {
		cycle,
		grossMultiple: multiple,
		edgeBps: (multiple - 1) * 10_000,
		maxBookAgeMs: oldest,
	};
}

/**
 * Prices a cycle in exact decimal arithmetic.
 *
 * Used to confirm a screened candidate before any sizing work, and by tests as the reference
 * implementation the float screen is checked against.
 */
export function quoteCycleExact(cycle: Cycle, store: BookStore, fee: FeeModel): Dec | undefined {
	let multiple = ONE;
	for (const leg of cycle.legs) {
		const book = store.get(leg.symbol);
		if (!book) return undefined;
		multiple = decMul(multiple, edgeRate(book, leg.side, fee));
	}
	return multiple;
}

/**
 * Marketable limit price for one leg.
 *
 * A `BUY` pays up by `aggressionTicks` above the ask and a `SELL` sells down below the bid, so the
 * order crosses even if the touch moves a tick between the decision and the arrival. The price
 * bound is what separates this from a market order: it caps how far the fill can slip, and an
 * unfilled IOC costs nothing but the opportunity.
 */
export function aggressivePrice(book: TopOfBook, leg: CycleLeg, tickSize: Dec, aggressionTicks: number): Dec {
	// Scaling a fixed-point value by a plain integer count is exact; no decMul round trip needed.
	const ticks = BigInt(Math.max(0, Math.trunc(aggressionTicks)));
	const offset = (tickSize * ticks) as Dec;
	if (leg.side === "BUY") return (book.ask + offset) as Dec;
	// A tick offset wider than the bid itself would price the sell at or below zero.
	const bid = (book.bid - offset) as Dec;
	return bid > 0n ? bid : tickSize;
}
