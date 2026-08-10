import { describe, expect, it } from "vitest";
import { planOpportunity } from "../src/core/sizing.js";
import { Valuation } from "../src/core/valuation.js";
import type { SymbolRules } from "../src/types.js";
import { decToNumber, decToString } from "../src/util/decimal.js";
import {
	BTCUSDT,
	budget,
	d,
	ETHBTC,
	ETHUSDT,
	FEE_10BPS,
	FEE_ZERO,
	FLAT,
	GRAPH,
	makeStore,
	PROFITABLE,
	TRIANGLE,
} from "./fixtures.js";

const NOW = 1_000_000;

function plan(
	overrides: Partial<Parameters<typeof planOpportunity>[0]> = {},
	quotes = PROFITABLE,
	rules: ReadonlyMap<string, SymbolRules> = new Map([
		["BTCUSDT", BTCUSDT],
		["ETHBTC", ETHBTC],
		["ETHUSDT", ETHUSDT],
	]),
) {
	const store = makeStore(quotes, NOW);
	return planOpportunity({
		cycle: TRIANGLE,
		store,
		rules,
		fee: FEE_10BPS,
		depthUtilization: 1,
		aggressionTicks: 0,
		maxInput: budget("1000").max,
		minInput: budget("1000").min,
		minNetEdgeBps: 8,
		requireNonNegativeWorstCase: true,
		now: NOW,
		maxBookAgeMs: 5000,
		...overrides,
	});
}

describe("happy path", () => {
	it("sizes the planted 1.2x loop and reports the post-rounding edge", () => {
		const result = plan();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { opportunity } = result;
		expect(opportunity.legs).toHaveLength(3);
		// 1.2 gross, three 10bps taker fees: 1.2 * 0.999^3 - 1 = 19.64%.
		expect(opportunity.netEdgeBps).toBeCloseTo((1.2 * 0.999 ** 3 - 1) * 10_000, 0);
		expect(decToNumber(opportunity.expectedProfit)).toBeGreaterThan(0);
	});

	it("derives each leg from the previous leg's output, not from the signal", () => {
		const result = plan();
		if (!result.ok) throw new Error("expected a plan");
		const [first, second, third] = result.opportunity.legs;
		expect(first.leg.symbol).toBe("BTCUSDT");
		expect(second.leg.symbol).toBe("ETHBTC");
		expect(third.leg.symbol).toBe("ETHUSDT");
		// Leg 2 spends what leg 1 produced, net of the fee.
		expect(decToNumber(second.amountIn)).toBeLessThanOrEqual(decToNumber(first.expectedOut));
		expect(decToNumber(third.amountIn)).toBeLessThanOrEqual(decToNumber(second.expectedOut));
	});

	it("prices orders at the touch when aggression is zero", () => {
		const result = plan({ aggressionTicks: 0 });
		if (!result.ok) throw new Error("expected a plan");
		expect(decToString(result.opportunity.legs[0].price)).toBe("100");
		expect(decToString(result.opportunity.legs[2].price)).toBe("12");
	});

	it("pays through the touch when aggression is set, and still clears the worst case", () => {
		const result = plan({ aggressionTicks: 2 });
		if (!result.ok) throw new Error("expected a plan");
		expect(decToString(result.opportunity.legs[0].price)).toBe("100.02");
		expect(decToString(result.opportunity.legs[2].price)).toBe("11.98");
		expect(result.worstCaseEdgeBps).toBeGreaterThan(0);
		expect(result.worstCaseEdgeBps).toBeLessThan(result.opportunity.netEdgeBps);
	});
});

describe("depth constraints", () => {
	it("caps the input at the tightest leg's displayed size", () => {
		// BTCUSDT shows 10 BTC on the ask at 100 USDT, so leg 1 can spend at most 1000 USDT.
		const result = plan({ maxInput: d("100000") });
		if (!result.ok) throw new Error("expected a plan");
		expect(decToNumber(result.opportunity.amountIn)).toBeCloseTo(1000, 6);
	});

	it("honours depthUtilization", () => {
		const result = plan({ maxInput: d("100000"), depthUtilization: 0.25 });
		if (!result.ok) throw new Error("expected a plan");
		expect(decToNumber(result.opportunity.amountIn)).toBeCloseTo(250, 6);
	});

	it("respects a budget below the depth cap", () => {
		const result = plan({ maxInput: d("137") });
		if (!result.ok) throw new Error("expected a plan");
		expect(decToNumber(result.opportunity.amountIn)).toBeLessThanOrEqual(137);
		expect(decToNumber(result.opportunity.amountIn)).toBeGreaterThan(136);
	});

	it("rejects when the tightest leg cannot support the minimum cycle size", () => {
		const thin = {
			...PROFITABLE,
			BTCUSDT: { ...PROFITABLE.BTCUSDT, askQty: "0.00002" },
		};
		const result = plan({ minInput: d("100") }, thin);
		expect(result.ok).toBe(false);
	});
});

describe("filters and rounding", () => {
	it("rounds every leg down to its lot grid", () => {
		const result = plan({ maxInput: d("777.7777") });
		if (!result.ok) throw new Error("expected a plan");
		for (const leg of result.opportunity.legs) {
			const rules = leg.leg.symbol === "BTCUSDT" ? BTCUSDT : leg.leg.symbol === "ETHBTC" ? ETHBTC : ETHUSDT;
			expect(leg.quantity % rules.stepSize).toBe(0n);
			expect(leg.price % rules.tickSize).toBe(0n);
		}
	});

	it("never spends more than the previous leg produced", () => {
		const result = plan({ maxInput: d("333.333333") });
		if (!result.ok) throw new Error("expected a plan");
		const legs = result.opportunity.legs;
		for (let i = 1; i < legs.length; i++) {
			expect(legs[i].amountIn <= legs[i - 1].expectedOut).toBe(true);
		}
	});

	it("rejects a cycle whose legs cannot clear the exchange minimum notional", () => {
		const chunky = new Map([
			["BTCUSDT", { ...BTCUSDT, minNotional: d("500000") }],
			["ETHBTC", ETHBTC],
			["ETHUSDT", ETHUSDT],
		]);
		const result = plan({}, PROFITABLE, chunky);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("notional");
	});

	it("rejects a cycle whose coarse lot grid rounds the size away entirely", () => {
		const coarse = new Map([
			["BTCUSDT", { ...BTCUSDT, stepSize: d("1000"), minQty: d("1000") }],
			["ETHBTC", ETHBTC],
			["ETHUSDT", ETHUSDT],
		]);
		const result = plan({}, PROFITABLE, coarse);
		expect(result.ok).toBe(false);
	});

	it("reports which leg failed", () => {
		const broken = new Map([
			["BTCUSDT", BTCUSDT],
			["ETHBTC", { ...ETHBTC, minQty: d("100000") }],
			["ETHUSDT", ETHUSDT],
		]);
		const result = plan({}, PROFITABLE, broken);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("leg 2");
	});

	it("rejects when a leg's rules are missing rather than guessing", () => {
		const partial = new Map([
			["BTCUSDT", BTCUSDT],
			["ETHBTC", ETHBTC],
		]);
		const result = plan({}, PROFITABLE, partial);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("rules missing");
	});
});

describe("edge thresholds", () => {
	it("rejects a flat book", () => {
		const result = plan({}, FLAT);
		expect(result.ok).toBe(false);
	});

	it("rejects an edge below the configured threshold", () => {
		const result = plan({ minNetEdgeBps: 100_000 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("below");
	});

	it("rejects a cycle that loses money at the limit price when the worst case is required", () => {
		// Ten ticks of aggression on a thin edge turns the worst case negative.
		const marginal = {
			BTCUSDT: { bid: "99.9", bidQty: "10", ask: "100", askQty: "10" },
			ETHBTC: { bid: "0.0999", bidQty: "100", ask: "0.1", askQty: "100" },
			ETHUSDT: { bid: "10.06", bidQty: "100", ask: "10.07", askQty: "100" },
		};
		const strict = plan({ aggressionTicks: 10, minNetEdgeBps: 1 }, marginal);
		const loose = plan({ aggressionTicks: 10, minNetEdgeBps: 1, requireNonNegativeWorstCase: false }, marginal);
		expect(loose.ok).toBe(true);
		expect(strict.ok).toBe(false);
		if (strict.ok) return;
		expect(strict.reason).toContain("worst-case");
	});

	it("rejects a stale book before doing any sizing work", () => {
		const result = plan({ now: NOW + 10_000 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("stale");
	});
});

describe("accounting", () => {
	it("converts leg 1's spend into the accounting asset", () => {
		const store = makeStore(PROFITABLE, NOW);
		const valuation = new Valuation(store, GRAPH, "USDT");
		const result = planOpportunity({
			cycle: TRIANGLE,
			store,
			rules: new Map([
				["BTCUSDT", BTCUSDT],
				["ETHBTC", ETHBTC],
				["ETHUSDT", ETHUSDT],
			]),
			fee: FEE_ZERO,
			depthUtilization: 1,
			aggressionTicks: 0,
			maxInput: d("500"),
			minInput: d("10"),
			minNetEdgeBps: 8,
			requireNonNegativeWorstCase: true,
			now: NOW,
			maxBookAgeMs: 5000,
			valuation,
		});
		if (!result.ok) throw new Error("expected a plan");
		// The start asset is the accounting asset, so the notional passes through unchanged.
		expect(decToString(result.opportunity.notionalInAccountingAsset)).toBe(decToString(result.opportunity.amountIn));
	});
});
