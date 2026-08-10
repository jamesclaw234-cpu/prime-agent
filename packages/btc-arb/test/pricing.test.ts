import { describe, expect, it } from "vitest";
import { BookStore, bookFromStream, makeBook } from "../src/core/book.js";
import {
	aggressivePrice,
	edgeRate,
	edgeRateNum,
	makeFeeModel,
	quoteCycle,
	quoteCycleExact,
} from "../src/core/pricing.js";
import { decToNumber, decToString, ZERO } from "../src/util/decimal.js";
import { BTCUSDT, d, FEE_10BPS, FEE_ZERO, FLAT, makeStore, PROFITABLE, TRIANGLE } from "./fixtures.js";

describe("edge rates", () => {
	it("prices a SELL off the bid and a BUY off the ask", () => {
		const book = makeBook("BTCUSDT", d("99"), d("10"), d("100"), d("10"), 1, 0);
		expect(decToString(edgeRate(book, "SELL", FEE_ZERO))).toBe("99");
		expect(decToString(edgeRate(book, "BUY", FEE_ZERO))).toBe("0.01");
	});

	it("applies the taker fee to the received asset", () => {
		const book = makeBook("BTCUSDT", d("100"), d("10"), d("100"), d("10"), 1, 0);
		// 10bps taker leaves 0.999 of every unit received.
		expect(decToString(edgeRate(book, "SELL", FEE_10BPS))).toBe("99.9");
		expect(decToString(edgeRate(book, "BUY", FEE_10BPS))).toBe("0.00999");
	});

	it("never uses the mid, which would manufacture arbitrage that does not exist", () => {
		const book = makeBook("BTCUSDT", d("90"), d("10"), d("110"), d("10"), 1, 0);
		const sell = decToNumber(edgeRate(book, "SELL", FEE_ZERO));
		const buy = decToNumber(edgeRate(book, "BUY", FEE_ZERO));
		// Round-tripping across the spread must lose money even with zero fees.
		expect(sell * buy).toBeLessThan(1);
	});

	it("agrees between the float screen and exact arithmetic", () => {
		const book = makeBook("ETHBTC", d("0.05123456"), d("10"), d("0.05123999"), d("10"), 1, 0);
		for (const side of ["BUY", "SELL"] as const) {
			const exact = decToNumber(edgeRate(book, side, FEE_10BPS));
			const fast = edgeRateNum(book, side, FEE_10BPS.takerMultiplierNum);
			expect(fast).toBeCloseTo(exact, 12);
		}
	});
});

describe("cycle quoting", () => {
	it("finds the planted 1.2x loop", () => {
		const store = makeStore(PROFITABLE);
		const quote = quoteCycle(TRIANGLE, store, FEE_ZERO, 1_000_000, 5000);
		expect(quote).toBeDefined();
		expect(quote?.grossMultiple).toBeCloseTo(1.2, 12);
		expect(quote?.edgeBps).toBeCloseTo(2000, 6);
	});

	it("charges three taker fees across three legs", () => {
		const store = makeStore(PROFITABLE);
		const quote = quoteCycle(TRIANGLE, store, FEE_10BPS, 1_000_000, 5000);
		expect(quote?.grossMultiple).toBeCloseTo(1.2 * 0.999 ** 3, 12);
	});

	it("reports no edge on a flat book", () => {
		const store = makeStore(FLAT);
		const quote = quoteCycle(TRIANGLE, store, FEE_10BPS, 1_000_000, 5000);
		expect(quote?.edgeBps).toBeLessThan(0);
	});

	it("refuses to price a cycle with a stale leg", () => {
		const store = makeStore(PROFITABLE, 1_000_000);
		expect(quoteCycle(TRIANGLE, store, FEE_10BPS, 1_000_000 + 6000, 5000)).toBeUndefined();
	});

	it("refuses to price a cycle with a missing leg", () => {
		const store = new BookStore(() => 0);
		expect(quoteCycle(TRIANGLE, store, FEE_10BPS, 0, 5000)).toBeUndefined();
	});

	it("matches exact arithmetic to well past basis-point resolution", () => {
		const store = makeStore(PROFITABLE);
		const fast = quoteCycle(TRIANGLE, store, FEE_10BPS, 1_000_000, 5000);
		const exact = quoteCycleExact(TRIANGLE, store, FEE_10BPS);
		expect(exact).toBeDefined();
		expect(fast?.grossMultiple).toBeCloseTo(decToNumber(exact ?? ZERO), 12);
	});
});

describe("aggressive pricing", () => {
	it("pays up to buy and sells down, by whole ticks", () => {
		const book = makeBook("BTCUSDT", d("99"), d("10"), d("100"), d("10"), 1, 0);
		const buy = aggressivePrice(book, TRIANGLE.legs[0], BTCUSDT.tickSize, 2);
		const sell = aggressivePrice(book, { ...TRIANGLE.legs[0], side: "SELL" }, BTCUSDT.tickSize, 2);
		expect(decToString(buy)).toBe("100.02");
		expect(decToString(sell)).toBe("98.98");
	});

	it("prices at the touch when aggression is zero", () => {
		const book = makeBook("BTCUSDT", d("99"), d("10"), d("100"), d("10"), 1, 0);
		expect(decToString(aggressivePrice(book, TRIANGLE.legs[0], BTCUSDT.tickSize, 0))).toBe("100");
	});

	it("never prices a sell at or below zero", () => {
		const book = makeBook("BTCUSDT", d("0.02"), d("10"), d("0.03"), d("10"), 1, 0);
		const sell = aggressivePrice(book, { ...TRIANGLE.legs[0], side: "SELL" }, d("0.01"), 500);
		expect(decToString(sell)).toBe("0.01");
	});
});

describe("book frames", () => {
	it("builds a book from a bookTicker payload", () => {
		const book = bookFromStream({ u: 7, s: "BTCUSDT", b: "99", B: "1", a: "100", A: "2" }, 123);
		expect(book?.symbol).toBe("BTCUSDT");
		expect(book?.updateId).toBe(7);
		expect(book?.receivedAt).toBe(123);
		expect(book?.askQtyNum).toBe(2);
	});

	it("discards a crossed or empty book", () => {
		expect(bookFromStream({ u: 1, s: "X", b: "100", B: "1", a: "99", A: "1" }, 0)).toBeUndefined();
		expect(bookFromStream({ u: 1, s: "X", b: "0", B: "1", a: "99", A: "1" }, 0)).toBeUndefined();
		expect(bookFromStream({ u: 1, s: "X", b: "98", B: "0", a: "99", A: "1" }, 0)).toBeUndefined();
	});

	it("rejects an out-of-order frame", () => {
		const store = new BookStore(() => 0);
		expect(store.apply(makeBook("BTCUSDT", d("99"), d("1"), d("100"), d("1"), 10, 0))).toBe(true);
		expect(store.apply(makeBook("BTCUSDT", d("98"), d("1"), d("101"), d("1"), 9, 0))).toBe(false);
		expect(store.get("BTCUSDT")?.updateId).toBe(10);
		expect(store.staleCount).toBe(1);
	});

	it("lets a streamed frame supersede the REST snapshot", () => {
		const store = new BookStore(() => 0);
		store.apply(makeBook("BTCUSDT", d("99"), d("1"), d("100"), d("1"), 0, 0));
		expect(store.apply(makeBook("BTCUSDT", d("98"), d("1"), d("101"), d("1"), 5, 0))).toBe(true);
	});

	it("reports staleness per symbol", () => {
		let now = 1000;
		const store = new BookStore(() => now);
		store.apply(makeBook("BTCUSDT", d("99"), d("1"), d("100"), d("1"), 1, 1000));
		now = 3500;
		expect(store.ageOf("BTCUSDT")).toBe(2500);
		expect(store.ageOf("NOPE")).toBe(Number.POSITIVE_INFINITY);
		expect(store.staleSymbols(1000)).toEqual(["BTCUSDT"]);
	});
});

describe("fee model", () => {
	it("derives the multiplier from basis points", () => {
		expect(decToString(makeFeeModel(10).takerMultiplier)).toBe("0.999");
		expect(decToString(makeFeeModel(7.5).takerMultiplier)).toBe("0.99925");
		expect(makeFeeModel(0).takerMultiplierNum).toBe(1);
	});
});
