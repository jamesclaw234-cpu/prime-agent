import type { Cycle, CycleLeg, CycleQuote, OrderSide, TopOfBook } from "../types.js";
import { type Dec, decDiv, decFromBps, decMul, decSub, decToNumber, ONE } from "../util/decimal.js";
import type { BookStore } from "./book.js";

/**
 * Taker fee model.
 *
 * Commission is modelled as an in-kind deduction from the asset received on each leg, which is how
 * Binance settles a spot taker fill when the BNB discount is not in play. With the discount active
 * the commission is instead debited in BNB at the same percentage; charging it in kind at the
 * discounted rate is economically equivalent to within the BNB conversion spread, and errs by
 * sizing the next leg fractionally small rather than fractionally large.
 */
export interface FeeModel {
	/** Taker rate as a fraction, e.g. 0.001 for 10bps. */
	readonly takerRate: Dec;
	/** `1 - takerRate`, the fraction of a fill that survives commission. */
	readonly takerMultiplier: Dec;
	readonly takerMultiplierNum: number;
	readonly takerBps: number;
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
): CycleQuote | undefined {
	let multiple = 1;
	let oldest = 0;

	for (const leg of cycle.legs) {
		const book = store.get(leg.symbol);
		if (!book) return undefined;
		const age = now - book.receivedAt;
		if (age > maxBookAgeMs) return undefined;
		if (age > oldest) oldest = age;
		multiple *= edgeRateNum(book, leg.side, fee.takerMultiplierNum);
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
