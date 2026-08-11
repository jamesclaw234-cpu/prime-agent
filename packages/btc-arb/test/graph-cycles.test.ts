import { describe, expect, it } from "vitest";
import { findNegativeCycles } from "../src/core/bellman-ford.js";
import { CycleIndex, enumerateCycles } from "../src/core/cycles.js";
import { MarketGraph, pruneDeadEnds, selectUniverse } from "../src/core/graph.js";
import type { SymbolRules } from "../src/types.js";
import { BTCUSDT, ETHBTC, ETHUSDT, FEE_10BPS, FEE_ZERO, FLAT, makeRules, makeStore, PROFITABLE } from "./fixtures.js";

const THREE = [BTCUSDT, ETHBTC, ETHUSDT];

describe("market graph", () => {
	it("builds both directions for every market", () => {
		const graph = new MarketGraph(THREE);
		expect(graph.symbolCount).toBe(3);
		expect(graph.assets.sort()).toEqual(["BTC", "ETH", "USDT"]);
		expect(
			graph
				.edgesFrom("USDT")
				.map((e) => e.symbol)
				.sort(),
		).toEqual(["BTCUSDT", "ETHUSDT"]);
		expect(graph.edgesFrom("USDT").every((e) => e.side === "BUY")).toBe(true);
		expect(graph.edgesFrom("BTC").some((e) => e.symbol === "BTCUSDT" && e.side === "SELL")).toBe(true);
	});
});

describe("universe selection", () => {
	it("keeps only markets quoted in the configured assets", () => {
		const extra = makeRules({ symbol: "DOGEBRL", baseAsset: "DOGE", quoteAsset: "BRL" });
		const { selected, rejected } = selectUniverse([...THREE, extra], { quoteAssets: ["USDT", "BTC"] });
		expect(selected.map((r) => r.symbol).sort()).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
		expect(rejected.get("DOGEBRL")).toContain("quote asset");
	});

	it("honours explicit exclusions", () => {
		const { selected } = selectUniverse(THREE, { quoteAssets: ["USDT", "BTC"], excludeSymbols: ["ETHBTC"] });
		expect(selected.map((r) => r.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
		const byAsset = selectUniverse(THREE, { quoteAssets: ["USDT", "BTC"], excludeAssets: ["ETH"] });
		expect(byAsset.selected.map((r) => r.symbol)).toEqual(["BTCUSDT"]);
	});

	it("caps the universe deterministically", () => {
		const { selected, rejected } = selectUniverse(THREE, { quoteAssets: ["USDT", "BTC"], maxSymbols: 2 });
		expect(selected.map((r) => r.symbol)).toEqual(["BTCUSDT", "ETHBTC"]);
		expect(rejected.get("ETHUSDT")).toContain("maxSymbols");
	});

	it("drops markets whose asset cannot be left except by reversing the same trade", () => {
		const deadEnd = makeRules({ symbol: "XYZUSDT", baseAsset: "XYZ", quoteAsset: "USDT" });
		const pruned = pruneDeadEnds([...THREE, deadEnd]);
		expect(pruned.map((r) => r.symbol).sort()).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
	});

	it("prunes repeatedly until the graph stops shrinking", () => {
		// ABC and DEF only connect to each other, so removing one strands the other.
		const chainA = makeRules({ symbol: "ABCDEF", baseAsset: "ABC", quoteAsset: "DEF" });
		const chainB = makeRules({ symbol: "DEFUSDT", baseAsset: "DEF", quoteAsset: "USDT" });
		const pruned = pruneDeadEnds([...THREE, chainA, chainB]);
		expect(pruned.map((r) => r.symbol).sort()).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
	});
});

describe("cycle enumeration", () => {
	it("finds both directions of the triangle from one start asset", () => {
		const graph = new MarketGraph(THREE);
		const cycles = enumerateCycles(graph, { startAssets: ["USDT"], maxLength: 3 });
		expect(cycles.map((c) => c.id).sort()).toEqual(["USDT>BTC>ETH>USDT", "USDT>ETH>BTC>USDT"]);
	});

	it("never emits a two-leg round trip on a single market", () => {
		const graph = new MarketGraph(THREE);
		const cycles = enumerateCycles(graph, { startAssets: ["USDT"], maxLength: 3 });
		for (const cycle of cycles) {
			expect(cycle.legs.length).toBe(3);
			expect(new Set(cycle.legs.map((l) => l.symbol)).size).toBe(3);
		}
	});

	it("enumerates from every requested start asset", () => {
		const graph = new MarketGraph(THREE);
		const cycles = enumerateCycles(graph, { startAssets: ["USDT", "BTC"], maxLength: 3 });
		expect(cycles.filter((c) => c.startAsset === "BTC")).toHaveLength(2);
		expect(cycles).toHaveLength(4);
	});

	it("filters to cycles touching a required asset", () => {
		const graph = new MarketGraph(THREE);
		const withBtc = enumerateCycles(graph, { startAssets: ["USDT"], maxLength: 3, requireAsset: "BTC" });
		const withNothing = enumerateCycles(graph, { startAssets: ["USDT"], maxLength: 3, requireAsset: "SOL" });
		expect(withBtc).toHaveLength(2);
		expect(withNothing).toHaveLength(0);
	});

	it("stops at the safety cap", () => {
		const graph = new MarketGraph(THREE);
		expect(enumerateCycles(graph, { startAssets: ["USDT"], maxLength: 3, maxCycles: 1 })).toHaveLength(1);
	});

	it("finds four-leg loops when asked", () => {
		const bnbUsdt = makeRules({ symbol: "BNBUSDT", baseAsset: "BNB", quoteAsset: "USDT" });
		const bnbBtc = makeRules({ symbol: "BNBBTC", baseAsset: "BNB", quoteAsset: "BTC" });
		const graph = new MarketGraph([...THREE, bnbUsdt, bnbBtc]);
		const three = enumerateCycles(graph, { startAssets: ["USDT"], maxLength: 3 });
		const four = enumerateCycles(graph, { startAssets: ["USDT"], maxLength: 4 });
		expect(four.length).toBeGreaterThan(three.length);
		expect(four.some((c) => c.legs.length === 4)).toBe(true);
	});
});

describe("cycle index", () => {
	it("maps each market to the cycles that touch it", () => {
		const graph = new MarketGraph(THREE);
		const index = new CycleIndex(enumerateCycles(graph, { startAssets: ["USDT"], maxLength: 3 }));
		expect(index.size).toBe(2);
		expect(index.cyclesFor("BTCUSDT")).toHaveLength(2);
		expect(index.cyclesFor("NOPE")).toHaveLength(0);
		expect(index.usedSymbols().sort()).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
		expect(index.maxFanout()).toBe(2);
	});
});

describe("negative cycle sweep", () => {
	const graph = new MarketGraph(THREE);

	it("finds the planted loop", () => {
		const store = makeStore(PROFITABLE, 1000, () => 1000);
		const found = findNegativeCycles(graph, store, FEE_10BPS, {
			now: 1000,
			maxBookAgeMs: 5000,
			maxLength: 4,
			maxResults: 5,
			minEdgeBps: 10,
		});
		expect(found.length).toBeGreaterThan(0);
		expect(found[0].legs.length).toBe(3);
		expect(found[0].edgeBps).toBeGreaterThan(1000);
		// The cycle must actually close.
		const legs = found[0].legs;
		expect(legs[legs.length - 1].toAsset).toBe(legs[0].fromAsset);
	});

	it("finds nothing on a flat book", () => {
		const store = makeStore(FLAT, 1000, () => 1000);
		const found = findNegativeCycles(graph, store, FEE_10BPS, {
			now: 1000,
			maxBookAgeMs: 5000,
			maxLength: 4,
			maxResults: 5,
			minEdgeBps: 1,
		});
		expect(found).toHaveLength(0);
	});

	it("ignores stale books entirely", () => {
		const store = makeStore(PROFITABLE, 1000, () => 1000);
		const found = findNegativeCycles(graph, store, FEE_ZERO, {
			now: 20_000,
			maxBookAgeMs: 1000,
			maxLength: 4,
			maxResults: 5,
			minEdgeBps: 1,
		});
		expect(found).toHaveLength(0);
	});
});

describe("universe cap", () => {
	/**
	 * Regression: the cap truncated alphabetically and deleted the bridge markets.
	 *
	 * On a USD/USDT venue the markets that make stablecoin cycles possible are `USDCUSD`,
	 * `USDCUSDT` and `USDTUSD` — which sort to the very end of the alphabet. A binding cap removed
	 * exactly those and left a table of leaf pairs, so a real Binance.US scan saw 12 cycles where
	 * 60 existed. The cap has to drop something; it must not be the hubs.
	 */
	function venue(): SymbolRules[] {
		const rules: SymbolRules[] = [
			makeRules({ symbol: "USDTUSD", baseAsset: "USDT", quoteAsset: "USD" }),
			makeRules({ symbol: "USDCUSD", baseAsset: "USDC", quoteAsset: "USD" }),
			makeRules({ symbol: "USDCUSDT", baseAsset: "USDC", quoteAsset: "USDT" }),
		];
		// Leaf markets, alphabetically early, quoted only in USD. Each touches one asset once.
		for (const base of ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"]) {
			rules.push(makeRules({ symbol: `${base}USD`, baseAsset: base, quoteAsset: "USD" }));
		}
		return rules;
	}

	it("keeps the bridge markets when the cap binds, not the alphabet", () => {
		const { selected, rejected, capped } = selectUniverse(venue(), {
			quoteAssets: ["USD", "USDT"],
			maxSymbols: 5,
		});
		expect(capped).toBe(true);
		expect(selected).toHaveLength(5);
		const kept = new Set(selected.map((rule) => rule.symbol));
		for (const bridge of ["USDTUSD", "USDCUSD", "USDCUSDT"]) {
			expect(kept.has(bridge)).toBe(true);
		}
		// Something had to go, and it was a leaf rather than a hub.
		expect(rejected.size).toBeGreaterThan(0);
	});

	it("still enumerates the stablecoin cycle that the cap used to delete", () => {
		const { selected } = selectUniverse(venue(), { quoteAssets: ["USD", "USDT"], maxSymbols: 5 });
		const cycles = enumerateCycles(new MarketGraph(pruneDeadEnds(selected)), {
			startAssets: ["USDT"],
			maxLength: 3,
		});
		expect(cycles.length).toBeGreaterThan(0);
		expect(cycles.some((cycle) => cycle.id.includes("USDC"))).toBe(true);
	});

	it("reports whether the cap actually bound", () => {
		// Silent truncation reads as "this venue only has these markets", which is a different and
		// much more discouraging statement than "you asked me to look at 5 of them".
		expect(selectUniverse(venue(), { quoteAssets: ["USD", "USDT"], maxSymbols: 500 }).capped).toBe(false);
	});
});
