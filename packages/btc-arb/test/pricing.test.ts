import { describe, expect, it } from "vitest";
import { BookStore, bookFromStream, makeBook } from "../src/core/book.js";
import {
	aggressivePrice,
	edgeRate,
	edgeRateNum,
	effectiveTakerBps,
	hasNonStandardCommission,
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

describe("commission rates", () => {
	// Rates taken verbatim from the worked example in Binance's Commission FAQ.
	const COMMISSION = {
		standardCommission: { maker: "0.00000010", taker: "0.00000020", buyer: "0.00000030", seller: "0.00000040" },
		specialCommission: { maker: "0.01000000", taker: "0.02000000", buyer: "0.03000000", seller: "0.04000000" },
		taxCommission: { maker: "0.00000112", taker: "0.00000114", buyer: "0.00000118", seller: "0.00000116" },
	};

	it("sums all three components, adding the side rate to the taker rate", () => {
		// Each component contributes taker + the worse of buyer/seller:
		//   standard 0.00000020 + 0.00000040 (seller)  = 0.00000060
		//   tax      0.00000114 + 0.00000118 (buyer)   = 0.00000232
		//   special  0.02000000 + 0.04000000 (seller)  = 0.06000000
		// Note the tax component takes `buyer`, which is the larger side there.
		expect(effectiveTakerBps(COMMISSION)).toBeCloseTo(600.0292, 6);
	});

	it("takes the worse side, because a cycle trades in both directions", () => {
		const buyHeavy = {
			standardCommission: { maker: "0", taker: "0.001", buyer: "0.0005", seller: "0" },
		};
		// taker 0.001 + worse side 0.0005 = 0.0015 -> 15bps, not 10bps.
		expect(effectiveTakerBps(buyHeavy)).toBeCloseTo(15, 9);
	});

	it("matches the ordinary retail case exactly", () => {
		// A standard account: 10bps taker, no side or non-standard components.
		const plain = { standardCommission: { maker: "0.001", taker: "0.001", buyer: "0", seller: "0" } };
		expect(effectiveTakerBps(plain)).toBeCloseTo(10, 9);
		expect(hasNonStandardCommission(plain)).toBe(false);
	});

	it("flags an account charged beyond the standard component", () => {
		expect(hasNonStandardCommission(COMMISSION)).toBe(true);
		expect(
			hasNonStandardCommission({
				taxCommission: { taker: "0", buyer: "0", seller: "0" },
				specialCommission: { taker: "0", buyer: "0", seller: "0" },
			}),
		).toBe(false);
	});

	it("never under-states the fee, which is the direction that loses money", () => {
		// Using only the standard taker rate would report 10bps for an account that actually pays
		// far more, making losing cycles look profitable.
		const standardOnly = decToNumber(makeFeeModel(10).takerRate) * 10_000;
		expect(effectiveTakerBps(COMMISSION)).toBeGreaterThan(standardOnly);
	});
});

describe("adaptive book freshness", () => {
	/**
	 * `bookTicker` pushes only when the book changes, so on a thin market an untouched quote is
	 * current rather than stale — the exchange has nothing new to say about it. A single global
	 * window judges a symbol that ticks twice a minute by the standards of one that ticks ten times
	 * a second, and a measured Binance.US scan discarded 85% of its evaluations that way.
	 */
	it("widens the window for a symbol that genuinely updates slowly", () => {
		const store = new BookStore();
		// Three updates twenty seconds apart: this market simply does not move often.
		for (let i = 0; i < 4; i++) {
			store.apply(makeBook("ETHBTC", d("0.09"), d("100"), d("0.1"), d("100"), i + 1, i * 20_000));
		}
		expect(store.cadenceOf("ETHBTC")).toBeGreaterThan(15_000);
		// Held to the base window it would be discarded; allowed its own rhythm it is usable.
		expect(store.ageLimitFor("ETHBTC", 1500, 30_000)).toBeGreaterThan(30_000 - 1);
		expect(store.ageLimitFor("ETHBTC", 1500, 0)).toBe(1500);
	});

	it("keeps a fast symbol on the tight window rather than relaxing everything", () => {
		const store = new BookStore();
		for (let i = 0; i < 20; i++) {
			store.apply(makeBook("BTCUSDT", d("99"), d("10"), d("100"), d("10"), i + 1, i * 50));
		}
		// 50ms cadence: four times that is still far under the base, so the base wins.
		expect(store.ageLimitFor("BTCUSDT", 1500, 30_000)).toBe(1500);
	});

	it("never widens past the ceiling, however quiet the market is", () => {
		const store = new BookStore();
		for (let i = 0; i < 4; i++) {
			store.apply(makeBook("ADABTC", d("0.09"), d("100"), d("0.1"), d("100"), i + 1, i * 600_000));
		}
		expect(store.ageLimitFor("ADABTC", 1500, 30_000)).toBe(30_000);
	});

	it("prices a slow-but-healthy cycle that a single global window would discard", () => {
		const now = 1_000_000;
		const store = new BookStore(() => now);
		// Seed twice per symbol so a cadence exists, with the last update 8s ago.
		for (const [symbol, quote] of Object.entries(PROFITABLE)) {
			store.apply(makeBook(symbol, d(quote.bid), d(quote.bidQty), d(quote.ask), d(quote.askQty), 1, now - 28_000));
			store.apply(makeBook(symbol, d(quote.bid), d(quote.bidQty), d(quote.ask), d(quote.askQty), 2, now - 8_000));
		}

		// Base window alone: every book is 8s old against a 1.5s limit, so nothing prices.
		expect(quoteCycle(TRIANGLE, store, FEE_10BPS, now, 1500)).toBeUndefined();
		// With a ceiling, each symbol's own 20s cadence makes 8s ordinary and the cycle prices.
		const quote = quoteCycle(TRIANGLE, store, FEE_10BPS, now, 1500, 30_000);
		expect(quote).toBeDefined();
		expect(quote?.edgeBps).toBeGreaterThan(0);
	});
});

describe("quote skew", () => {
	/**
	 * Adopted from another implementation of this strategy, which had it and this one did not.
	 *
	 * Age alone cannot catch an incoherent cycle: a window wide enough to admit a 4s-old quote also
	 * admits a 10ms-old one, and the pair describes a market that never existed at any single
	 * instant. The apparent edge is usually just the newer leg having moved.
	 */
	const now = 1_000_000;

	function skewedStore(ages: Record<string, number>): BookStore {
		const store = new BookStore(() => now);
		let updateId = 1;
		for (const [symbol, age] of Object.entries(ages)) {
			const quote = PROFITABLE[symbol];
			store.apply(
				makeBook(symbol, d(quote.bid), d(quote.bidQty), d(quote.ask), d(quote.askQty), updateId++, now - age),
			);
		}
		return store;
	}

	it("rejects a cycle assembled from quotes taken at very different moments", () => {
		const store = skewedStore({ BTCUSDT: 10, ETHBTC: 4000, ETHUSDT: 20 });
		// Every leg is individually inside a 5s window, so the age check passes it.
		expect(quoteCycle(TRIANGLE, store, FEE_10BPS, now, 5000)).toBeDefined();
		// The 3.99s spread between freshest and stalest is what makes it meaningless.
		expect(quoteCycle(TRIANGLE, store, FEE_10BPS, now, 5000, 0, 1000)).toBeUndefined();
	});

	it("accepts a cycle whose quotes are old but arrived together", () => {
		// Uniformly stale is coherent: the whole market simply has not moved.
		const store = skewedStore({ BTCUSDT: 3800, ETHBTC: 4000, ETHUSDT: 3900 });
		expect(quoteCycle(TRIANGLE, store, FEE_10BPS, now, 5000, 0, 1000)).toBeDefined();
	});

	it("treats zero as disabled", () => {
		const store = skewedStore({ BTCUSDT: 10, ETHBTC: 4000, ETHUSDT: 20 });
		expect(quoteCycle(TRIANGLE, store, FEE_10BPS, now, 5000, 0, 0)).toBeDefined();
	});
});

describe("skew and the widened window together", () => {
	/**
	 * Regression: the skew check used to measure receivedAt spread across ALL legs, which cancelled
	 * the adaptive window for any cycle mixing an active leg with a thin one - i.e. almost every
	 * cycle the widening exists to admit. A thin symbol's receivedAt tracks nothing but its own last
	 * change, so comparing it against an active leg's timestamp measures thinness, not incoherence.
	 * Skew now applies only among legs inside the base window, whose timestamps do track market time.
	 */
	const now = 1_000_000;

	function seeded(ages: Record<string, { age: number; cadence?: number }>): BookStore {
		const store = new BookStore(() => now);
		let updateId = 1;
		for (const [symbol, spec] of Object.entries(ages)) {
			const quote = PROFITABLE[symbol];
			if (spec.cadence) {
				// Two updates one cadence apart seed the EWMA.
				store.apply(
					makeBook(
						symbol,
						d(quote.bid),
						d(quote.bidQty),
						d(quote.ask),
						d(quote.askQty),
						updateId++,
						now - spec.age - spec.cadence,
					),
				);
			}
			store.apply(
				makeBook(symbol, d(quote.bid), d(quote.bidQty), d(quote.ask), d(quote.askQty), updateId++, now - spec.age),
			);
		}
		return store;
	}

	it("exempts a thin leg admitted by its own cadence window from the skew check", () => {
		// ETHBTC ticks every ~20s; its 5s-old quote is current by that market's standards. The other
		// legs are milliseconds old. Base 1500, ceiling 30s, skew 1500.
		const store = seeded({
			BTCUSDT: { age: 10 },
			ETHBTC: { age: 5000, cadence: 20_000 },
			ETHUSDT: { age: 20 },
		});
		const quote = quoteCycle(TRIANGLE, store, FEE_10BPS, now, 1500, 30_000, 1500);
		expect(quote).toBeDefined();
		expect(quote?.edgeBps).toBeGreaterThan(0);
	});

	it("still rejects incoherence among ACTIVE legs under a wide base window", () => {
		// A 5s-old quote on a fast market inside a 6s base window is genuinely suspect, and the
		// widened window cannot vouch for it - its own cadence is milliseconds.
		const store = seeded({
			BTCUSDT: { age: 10, cadence: 50 },
			ETHBTC: { age: 5000, cadence: 50 },
			ETHUSDT: { age: 20, cadence: 50 },
		});
		expect(quoteCycle(TRIANGLE, store, FEE_10BPS, now, 6000, 30_000, 1500)).toBeUndefined();
	});
});
