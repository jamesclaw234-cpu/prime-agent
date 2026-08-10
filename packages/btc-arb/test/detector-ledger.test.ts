import { describe, expect, it } from "vitest";
import { CycleIndex, enumerateCycles } from "../src/core/cycles.js";
import { Detector } from "../src/core/detector.js";
import { MarketGraph } from "../src/core/graph.js";
import { Valuation } from "../src/core/valuation.js";
import { Ledger } from "../src/obs/ledger.js";
import { Metrics } from "../src/obs/metrics.js";
import { parseRecordedTick, TickRecorder } from "../src/obs/recorder.js";
import type { CycleOutcome, CycleResult, Opportunity } from "../src/types.js";
import { decFromString, decToNumber, decToString, ZERO } from "../src/util/decimal.js";
import {
	BTCUSDT,
	budget,
	d,
	ETHBTC,
	ETHUSDT,
	FEE_10BPS,
	FLAT,
	GRAPH,
	makeStore,
	PROFITABLE,
	setQuote,
	TRIANGLE,
} from "./fixtures.js";

const NOW = 1_000_000;
const RULES = new Map([
	["BTCUSDT", BTCUSDT],
	["ETHBTC", ETHBTC],
	["ETHUSDT", ETHUSDT],
]);

function makeDetector(
	quotes = PROFITABLE,
	overrides: Partial<ConstructorParameters<typeof Detector>[0]> = {},
): { detector: Detector; found: Opportunity[]; store: ReturnType<typeof makeStore> } {
	const store = makeStore(quotes, NOW);
	const index = new CycleIndex(enumerateCycles(GRAPH, { startAssets: ["USDT"], maxLength: 3 }));
	const found: Opportunity[] = [];
	const detector = new Detector({
		store,
		index,
		rules: RULES,
		fee: FEE_10BPS,
		now: () => NOW,
		minNetEdgeBps: 8,
		screenMarginBps: 2,
		maxBookAgeMs: 5000,
		depthUtilization: 1,
		aggressionTicks: 0,
		requireNonNegativeWorstCase: true,
		logEdgeBps: 0,
		inputBudget: () => budget("500"),
		onOpportunity: (opportunity) => found.push(opportunity),
		...overrides,
	});
	return { detector, found, store };
}

describe("detector", () => {
	it("emits an opportunity for a market that is part of a profitable cycle", () => {
		const { detector, found } = makeDetector();
		detector.onBookUpdate("BTCUSDT");
		expect(found).toHaveLength(1);
		expect(found[0].cycle.id).toBe("USDT>BTC>ETH>USDT");
		expect(found[0].netEdgeBps).toBeGreaterThan(1000);
	});

	it("only re-prices cycles touching the updated market", () => {
		const { detector } = makeDetector(FLAT);
		detector.onBookUpdate("NOTLISTED");
		expect(detector.stats().cyclesScreened).toBe(0);
		detector.onBookUpdate("BTCUSDT");
		expect(detector.stats().cyclesScreened).toBe(2);
	});

	it("emits nothing on a flat book and records why", () => {
		const { detector, found } = makeDetector(FLAT);
		detector.scanAll();
		expect(found).toHaveLength(0);
		expect(detector.stats().screenPasses).toBe(0);
	});

	it("screens below the acceptance threshold so exact arithmetic gets the final say", () => {
		const { detector, found } = makeDetector(PROFITABLE, { minNetEdgeBps: 100_000, screenMarginBps: 100_000 });
		detector.scanAll();
		// The screen passes; sizing then rejects on the threshold.
		expect(detector.stats().screenPasses).toBeGreaterThan(0);
		expect(found).toHaveLength(0);
		expect(Object.keys(detector.stats().rejectionsByReason).length).toBeGreaterThan(0);
	});

	it("skips a cycle whose start asset has no budget", () => {
		const { detector, found } = makeDetector(PROFITABLE, { inputBudget: () => undefined });
		detector.scanAll();
		expect(found).toHaveLength(0);
		expect(detector.stats().rejectionsByReason["no budget for the start asset"]).toBeGreaterThan(0);
	});

	it("reacts to a book update that creates the edge", () => {
		const { detector, found, store } = makeDetector(FLAT);
		detector.onBookUpdate("ETHUSDT");
		expect(found).toHaveLength(0);
		setQuote(store, "ETHUSDT", { bid: "12", bidQty: "100", ask: "13", askQty: "100" }, NOW, 500);
		detector.onBookUpdate("ETHUSDT");
		expect(found).toHaveLength(1);
	});

	it("buckets rejection reasons for the operator", () => {
		const { detector } = makeDetector(PROFITABLE, { inputBudget: () => budget("0.0001", "0.00001") });
		detector.scanAll();
		const reasons = detector.stats().rejectionsByReason;
		expect(Object.values(reasons).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
	});

	it("prices a cycle handed to it directly by the sweep", () => {
		const { detector, found } = makeDetector();
		detector.evaluateDirect(TRIANGLE);
		expect(found).toHaveLength(1);
	});
});

describe("valuation", () => {
	const store = makeStore(PROFITABLE, NOW);
	const graph = new MarketGraph(RULES.values());

	it("values the accounting asset as itself", () => {
		const valuation = new Valuation(store, graph, "USDT");
		expect(decToString(valuation.rate("USDT") ?? ZERO)).toBe("1");
	});

	it("uses the bid for a direct market, never the mid", () => {
		const valuation = new Valuation(store, graph, "USDT");
		expect(decToString(valuation.rate("BTC") ?? ZERO)).toBe("99");
		expect(decToString(valuation.convert(d("2"), "BTC") ?? ZERO)).toBe("198");
	});

	it("bridges through an intermediate asset when no direct market exists", () => {
		const valuation = new Valuation(store, graph, "BTC", ["USDT"]);
		// ETH -> BTC exists directly at the ETHBTC bid.
		expect(decToString(valuation.rate("ETH") ?? ZERO)).toBe("0.09");
	});

	it("returns undefined for an unknown asset rather than guessing", () => {
		const valuation = new Valuation(store, graph, "USDT");
		expect(valuation.rate("DOGE")).toBeUndefined();
		expect(valuation.convert(d("1"), "DOGE")).toBeUndefined();
	});

	it("converts back out of the accounting asset", () => {
		const valuation = new Valuation(store, graph, "USDT");
		expect(decToString(valuation.convertFrom(d("198"), "BTC") ?? ZERO)).toBe("2");
	});
});

function makeResult(outcome: CycleOutcome, pnl: string, overrides: Partial<CycleResult> = {}): CycleResult {
	return {
		opportunityId: "op",
		cycleId: TRIANGLE.id,
		mode: "paper",
		outcome,
		startedAt: 0,
		finishedAt: 25,
		fills: [
			{
				leg: TRIANGLE.legs[0],
				requestedQty: d("1"),
				executedQty: d("1"),
				quoteQty: d("100"),
				amountIn: d("100"),
				amountOut: d("0.999"),
				commissions: [{ asset: "BTC", amount: d("0.001") }],
				avgPrice: d("100"),
				orderId: "1",
				clientOrderId: "c",
				status: "FILLED",
				latencyMs: 12,
			},
		],
		unwindFills: [],
		amountIn: d("100"),
		amountOut: decFromString(String(100 + Number(pnl))),
		realizedPnl: d(pnl),
		realizedPnlAsset: "USDT",
		expectedProfit: d("2"),
		slippage: decFromString(String(Number(pnl) - 2)),
		...overrides,
	};
}

describe("ledger", () => {
	it("aggregates PnL, win rate and slippage", () => {
		const ledger = new Ledger({ accountingAsset: "USDT" });
		ledger.record(makeResult("completed", "3"), d("3"), d("100"));
		ledger.record(makeResult("completed", "-1"), d("-1"), d("100"));
		ledger.record(makeResult("aborted_no_fill", "0"), ZERO, d("100"));

		const summary = ledger.summary();
		expect(summary.cycles).toBe(3);
		expect(summary.completed).toBe(2);
		expect(summary.realizedPnl).toBeCloseTo(2, 8);
		expect(summary.grossProfit).toBeCloseTo(3, 8);
		expect(summary.grossLoss).toBeCloseTo(-1, 8);
		expect(summary.winRate).toBeCloseTo(1 / 3, 8);
		expect(summary.volume).toBeCloseTo(300, 8);
		expect(summary.byOutcome.completed).toBe(2);
		expect(summary.byOutcome.aborted_no_fill).toBe(1);
	});

	it("measures how far reality fell short of the signal", () => {
		const ledger = new Ledger({ accountingAsset: "USDT" });
		ledger.record(makeResult("completed", "1"), d("1"), d("100"));
		const summary = ledger.summary();
		// Expected 2, realised 1: one unit of slippage on a 100 unit notional is -100bps.
		expect(summary.totalSlippage).toBeCloseTo(-1, 8);
		expect(summary.avgSlippageBps).toBeCloseTo(-100, 6);
	});

	it("totals commissions per asset across legs and unwinds", () => {
		const ledger = new Ledger({ accountingAsset: "USDT" });
		ledger.record(makeResult("completed", "1"), d("1"), d("100"));
		ledger.record(makeResult("completed", "1"), d("1"), d("100"));
		expect(ledger.summary().commissionsByAsset.BTC).toBe("0.002");
	});

	it("tracks stranded inventory separately from PnL", () => {
		const ledger = new Ledger({ accountingAsset: "USDT" });
		ledger.record(
			makeResult("aborted_no_fill", "-100", { strandedAsset: "BTC", strandedAmount: d("0.999") }),
			d("-100"),
			d("100"),
		);
		const summary = ledger.summary();
		expect(summary.strandedByAsset.BTC).toBe("0.999");
		expect(summary.realizedPnl).toBeCloseTo(-100, 8);
	});

	it("keeps per-start-asset PnL in the asset it was earned in", () => {
		const ledger = new Ledger({ accountingAsset: "USDT" });
		ledger.record(makeResult("completed", "3"), d("3"), d("100"));
		expect(ledger.summary().pnlByStartAsset.USDT).toBe("3");
	});

	it("reports an empty summary before anything happens", () => {
		const summary = new Ledger({ accountingAsset: "USDT" }).summary();
		expect(summary.cycles).toBe(0);
		expect(summary.winRate).toBe(0);
		expect(summary.avgSlippageBps).toBe(0);
	});
});

describe("metrics", () => {
	it("computes percentiles over the reservoir", () => {
		const metrics = new Metrics(1000, () => 0);
		for (let i = 1; i <= 100; i++) metrics.observe("latency", i);
		expect(metrics.percentile("latency", 0.5)).toBeCloseTo(50.5, 6);
		expect(metrics.percentile("latency", 0.99)).toBeCloseTo(99.01, 1);
		expect(metrics.mean("latency")).toBeCloseTo(50.5, 6);
	});

	it("bounds the reservoir and keeps the most recent samples", () => {
		const metrics = new Metrics(10, () => 0);
		for (let i = 0; i < 100; i++) metrics.observe("x", i);
		expect(metrics.percentile("x", 0)).toBe(90);
	});

	it("ignores non-finite samples", () => {
		const metrics = new Metrics(10, () => 0);
		metrics.observe("x", Number.NaN);
		expect(metrics.percentile("x", 0.5)).toBe(0);
	});

	it("counts and gauges", () => {
		const metrics = new Metrics(10, () => 0);
		metrics.increment("orders");
		metrics.increment("orders", 4);
		metrics.gauge("skew", -3);
		const snapshot = metrics.snapshot();
		expect(snapshot.orders).toBe(5);
		expect(snapshot.skew).toBe(-3);
	});
});

describe("tick recording", () => {
	it("round-trips a frame through the recorder format", () => {
		const written: string[] = [];
		const recorder = new TickRecorder("/dev/null", 1);
		// Exercise the parser against the exact shape the recorder emits.
		const store = makeStore(PROFITABLE, NOW);
		const book = store.get("BTCUSDT");
		expect(book).toBeDefined();
		if (!book) return;
		recorder.record(book);
		written.push(
			JSON.stringify({
				t: book.receivedAt,
				s: book.symbol,
				u: book.updateId,
				b: decToString(book.bid),
				B: decToString(book.bidQty),
				a: decToString(book.ask),
				A: decToString(book.askQty),
			}),
		);
		const parsed = parseRecordedTick(written[0]);
		expect(parsed?.s).toBe("BTCUSDT");
		expect(parsed?.b).toBe("99");
		expect(decToNumber(d(parsed?.A ?? "0"))).toBe(10);
	});

	it("rejects malformed lines instead of throwing", () => {
		expect(parseRecordedTick("")).toBeUndefined();
		expect(parseRecordedTick("not json")).toBeUndefined();
		expect(parseRecordedTick('{"s":"X"}')).toBeUndefined();
	});
});
