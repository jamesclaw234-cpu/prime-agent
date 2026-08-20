import { describe, expect, it } from "vitest";
import { BinanceApiError } from "../src/binance/rest-client.js";
import { BINANCE_ERROR, EXPIRY_REASON } from "../src/binance/types.js";
import { BookStore, makeBook } from "../src/core/book.js";
import { planOpportunity } from "../src/core/sizing.js";
import { type ExecutionEngine, NOT_PLACED, type OrderOutcome, type OrderRequest } from "../src/exec/engine.js";
import { CycleExecutor, reverseLeg } from "../src/exec/executor.js";
import { PaperEngine } from "../src/exec/paper-engine.js";
import type { Asset, Opportunity } from "../src/types.js";
import { type Dec, decMul, decSub, decToNumber, decToString, ZERO } from "../src/util/decimal.js";
import { Logger } from "../src/util/logger.js";
import { BTCUSDT, d, ETHBTC, ETHUSDT, FEE_10BPS, makeStore, PROFITABLE, TRIANGLE } from "./fixtures.js";

const NOW = 1_000_000;

const RULES = new Map([
	["BTCUSDT", BTCUSDT],
	["ETHBTC", ETHBTC],
	["ETHUSDT", ETHUSDT],
]);

const UNWIND = { enabled: true, maxAttempts: 3, aggressionTicks: 10 };

function buildOpportunity(store = makeStore(PROFITABLE, NOW)): Opportunity {
	const result = planOpportunity({
		cycle: TRIANGLE,
		store,
		rules: RULES,
		fee: FEE_10BPS,
		depthUtilization: 1,
		aggressionTicks: 0,
		maxInput: d("100"),
		minInput: d("10"),
		minNetEdgeBps: 8,
		requireNonNegativeWorstCase: true,
		now: NOW,
		maxBookAgeMs: 5000,
	});
	if (!result.ok) throw new Error(`fixture is not tradable: ${result.reason}`);
	return result.opportunity;
}

/** Programmable engine: one scripted behaviour per call, in order. */
class ScriptedEngine implements ExecutionEngine {
	readonly mode = "paper" as const;
	readonly requests: OrderRequest[] = [];
	readonly resolved: { symbol: string; clientOrderId: string }[] = [];
	private index = 0;

	constructor(
		private readonly script: ((request: OrderRequest) => OrderOutcome | Error)[],
		/** What a resolveOrder lookup reports: absent, found, or unanswerable. */
		private readonly resolution?: "not_placed" | "filled" | "unknown",
	) {}

	async resolveOrder(symbol: string, clientOrderId: string): Promise<OrderOutcome | undefined> {
		this.resolved.push({ symbol, clientOrderId });
		if (this.resolution === "unknown" || this.resolution === undefined) return undefined;
		return {
			orderId: this.resolution === "filled" ? "found" : "",
			clientOrderId,
			status: this.resolution === "filled" ? "FILLED" : NOT_PLACED,
			executedQty: ZERO,
			quoteQty: ZERO,
			fills: [],
			latencyMs: 1,
		};
	}

	async placeIoc(request: OrderRequest): Promise<OrderOutcome> {
		this.requests.push(request);
		const step = this.script[Math.min(this.index, this.script.length - 1)];
		this.index++;
		const result = step(request);
		if (result instanceof Error) throw result;
		return result;
	}

	async balances(): Promise<ReadonlyMap<Asset, Dec>> {
		return new Map();
	}
}

/** A complete fill at the requested price, net of a 10bps commission on the received asset. */
function fullFill(request: OrderRequest): OrderOutcome {
	const quoteQty = decMul(request.price, request.quantity);
	const received = request.side === "BUY" ? request.quantity : quoteQty;
	const receivedAsset = request.side === "BUY" ? request.rules.baseAsset : request.rules.quoteAsset;
	return {
		orderId: `o${request.clientOrderId}`,
		clientOrderId: request.clientOrderId,
		status: "FILLED",
		executedQty: request.quantity,
		quoteQty,
		fills: [
			{
				price: request.price,
				qty: request.quantity,
				commission: decMul(received, FEE_10BPS.takerRate),
				commissionAsset: receivedAsset,
			},
		],
		latencyMs: 5,
	};
}

function partialFill(fraction: string): (request: OrderRequest) => OrderOutcome {
	return (request) => {
		const quantity = decMul(request.quantity, d(fraction));
		return fullFill({ ...request, quantity });
	};
}

function noFill(request: OrderRequest): OrderOutcome {
	return {
		orderId: "",
		clientOrderId: request.clientOrderId,
		status: "EXPIRED",
		executedQty: ZERO,
		quoteQty: ZERO,
		fills: [],
		latencyMs: 3,
	};
}

function makeExecutor(engine: ExecutionEngine, store = makeStore(PROFITABLE, NOW)): CycleExecutor {
	return new CycleExecutor({
		engine,
		store,
		rules: RULES,
		fee: FEE_10BPS,
		cycleDeadlineMs: 3000,
		aggressionTicks: 0,
		unwind: UNWIND,
		maxBookAgeMs: 5000,
		now: () => NOW,
	});
}

describe("leg reversal", () => {
	it("flips side and direction", () => {
		expect(reverseLeg(TRIANGLE.legs[0])).toEqual({
			symbol: "BTCUSDT",
			side: "SELL",
			fromAsset: "BTC",
			toAsset: "USDT",
		});
	});
});

describe("complete cycle", () => {
	it("runs all three legs and books a profit", async () => {
		const engine = new ScriptedEngine([fullFill, fullFill, fullFill]);
		const opportunity = buildOpportunity();
		const result = await makeExecutor(engine).execute(opportunity);

		expect(result.outcome).toBe("completed");
		expect(result.fills).toHaveLength(3);
		expect(result.unwindFills).toHaveLength(0);
		expect(decToNumber(result.realizedPnl)).toBeGreaterThan(0);
		expect(result.strandedAsset).toBeUndefined();
		expect(engine.requests.map((r) => r.symbol)).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
	});

	it("matches the plan closely when the book does not move", async () => {
		const engine = new ScriptedEngine([fullFill, fullFill, fullFill]);
		const opportunity = buildOpportunity();
		const result = await makeExecutor(engine).execute(opportunity);
		// Slippage here is only lot rounding on the intermediate legs.
		expect(Math.abs(decToNumber(result.slippage))).toBeLessThan(decToNumber(opportunity.expectedProfit));
	});

	it("sizes each leg from the previous fill, net of commission", async () => {
		const engine = new ScriptedEngine([fullFill, fullFill, fullFill]);
		await makeExecutor(engine).execute(buildOpportunity());
		const [first, second] = engine.requests;
		// Leg 1 buys BTC; leg 2 can only spend the 99.9% that survived the commission.
		const received = decMul(first.quantity, decSub(d("1"), FEE_10BPS.takerRate));
		expect(decToNumber(second.quantity)).toBeLessThanOrEqual(decToNumber(received) / decToNumber(second.price));
	});
});

describe("failure handling", () => {
	it("aborts cleanly when leg 1 does not fill, with nothing to unwind", async () => {
		const engine = new ScriptedEngine([noFill]);
		const result = await makeExecutor(engine).execute(buildOpportunity());
		expect(result.outcome).toBe("aborted_no_fill");
		expect(result.fills).toHaveLength(1);
		expect(result.unwindFills).toHaveLength(0);
		expect(decToString(result.realizedPnl)).toBe("0");
		expect(engine.requests).toHaveLength(1);
	});

	it("unwinds when a later leg does not fill", async () => {
		const engine = new ScriptedEngine([fullFill, noFill, fullFill]);
		const result = await makeExecutor(engine).execute(buildOpportunity());
		expect(result.unwindFills.length).toBeGreaterThan(0);
		// The unwind sells the BTC that leg 1 bought.
		expect(result.unwindFills[0].leg.symbol).toBe("BTCUSDT");
		expect(result.unwindFills[0].leg.side).toBe("SELL");
		expect(result.strandedAsset).toBeUndefined();
		expect(decToNumber(result.realizedPnl)).toBeLessThan(0);
	});

	it("continues from a partial fill using the quantity actually received", async () => {
		const engine = new ScriptedEngine([partialFill("0.4"), fullFill, fullFill]);
		const result = await makeExecutor(engine).execute(buildOpportunity());
		expect(result.outcome).toBe("completed");
		const [first, second] = engine.requests;
		expect(decToNumber(second.quantity)).toBeLessThan(
			(decToNumber(first.quantity) * 0.45) / decToNumber(second.price) + 1,
		);
		expect(decToNumber(result.realizedPnl)).toBeGreaterThan(0);
	});

	it("reports stranded inventory when the unwind cannot fill either", async () => {
		const engine = new ScriptedEngine([fullFill, noFill, noFill, noFill, noFill, noFill]);
		const result = await makeExecutor(engine).execute(buildOpportunity());
		// The outcome keeps the cause; stranding is reported through the structured field.
		expect(result.outcome).toBe("aborted_no_fill");
		expect(result.strandedAsset).toBe("BTC");
		expect(decToNumber(result.strandedAmount ?? ZERO)).toBeGreaterThan(0);
		// A stranded cycle books the full input as a loss until the inventory is dealt with.
		expect(decToNumber(result.realizedPnl)).toBeLessThan(0);
	});

	it("bounds unwind retries", async () => {
		const engine = new ScriptedEngine([fullFill, noFill, noFill, noFill, noFill, noFill, noFill, noFill]);
		await makeExecutor(engine).execute(buildOpportunity());
		// One failed leg 2, then at most maxAttempts unwind attempts on leg 1.
		expect(engine.requests.length).toBeLessThanOrEqual(2 + UNWIND.maxAttempts);
	});

	it("retries an unwind leg that fails definitively", async () => {
		let unwindCall = 0;
		const engine = new ScriptedEngine([
			fullFill,
			noFill,
			(request) => {
				unwindCall++;
				// A filter rejection is a definite non-fill: retrying is safe and correct.
				if (unwindCall === 1) return new BinanceApiError(-1013, "Filter failure: LOT_SIZE", 400, "/api/v3/order");
				return fullFill(request);
			},
		]);
		const result = await makeExecutor(engine).execute(buildOpportunity());
		expect(engine.requests.length).toBeGreaterThanOrEqual(4);
		expect(result.strandedAsset).toBeUndefined();
	});

	it("does not re-send an unwind order that failed ambiguously", async () => {
		// A timeout may have executed. Re-sending would flatten the same inventory twice and leave
		// the account short, which is strictly worse than the position we are trying to escape.
		const engine = new ScriptedEngine([
			fullFill,
			noFill,
			() => new BinanceApiError(BINANCE_ERROR.TIMEOUT, "Timeout waiting for response", 504, "/api/v3/order"),
		]);
		const result = await makeExecutor(engine).execute(buildOpportunity());

		const unwindRequests = engine.requests.slice(2);
		expect(unwindRequests).toHaveLength(1);
		expect(result.strandedAsset).toBe("BTC");
		expect(result.error).toContain("reconcile manually");
	});

	it("surfaces a thrown error without pretending the cycle completed", async () => {
		const engine = new ScriptedEngine([fullFill, () => new Error("connection reset")]);
		const result = await makeExecutor(engine).execute(buildOpportunity());
		expect(result.error).toContain("connection reset");
		expect(result.outcome).not.toBe("completed");
	});

	it("stops before sending a leg whose book has gone stale", async () => {
		const store = makeStore(PROFITABLE, NOW);
		const engine = new ScriptedEngine([fullFill, fullFill, fullFill]);
		const opportunity = buildOpportunity(store);
		const executor = new CycleExecutor({
			engine,
			store,
			rules: RULES,
			fee: FEE_10BPS,
			cycleDeadlineMs: 3000,
			aggressionTicks: 0,
			unwind: { ...UNWIND, enabled: false },
			maxBookAgeMs: 1,
			now: () => NOW + 5000,
		});
		const result = await executor.execute(opportunity);
		expect(result.outcome).toBe("aborted_edge_gone");
		expect(engine.requests).toHaveLength(0);
	});

	it("respects the cycle deadline", async () => {
		let clock = NOW;
		const store = makeStore(PROFITABLE, NOW, () => clock);
		const engine = new ScriptedEngine([
			(request) => {
				clock += 10_000;
				return fullFill(request);
			},
			fullFill,
			fullFill,
		]);
		const executor = new CycleExecutor({
			engine,
			store,
			rules: RULES,
			fee: FEE_10BPS,
			cycleDeadlineMs: 500,
			aggressionTicks: 0,
			unwind: { ...UNWIND, enabled: false },
			maxBookAgeMs: 1_000_000,
			now: () => clock,
		});
		const result = await executor.execute(buildOpportunity(store));
		expect(result.outcome).toBe("aborted_deadline");
		expect(engine.requests).toHaveLength(1);
		// Unwind is off in this executor, so the leg-1 inventory is reported as stranded.
		expect(result.strandedAsset).toBe("BTC");
	});

	it("unwinds after a deadline abort and still records the deadline as the cause", async () => {
		let clock = NOW;
		const store = makeStore(PROFITABLE, NOW, () => clock);
		const engine = new ScriptedEngine([
			(request) => {
				clock += 10_000;
				return fullFill(request);
			},
			fullFill,
		]);
		const executor = new CycleExecutor({
			engine,
			store,
			rules: RULES,
			fee: FEE_10BPS,
			cycleDeadlineMs: 500,
			aggressionTicks: 0,
			unwind: UNWIND,
			maxBookAgeMs: 1_000_000,
			now: () => clock,
		});
		const result = await executor.execute(buildOpportunity(store));
		expect(result.outcome).toBe("aborted_deadline");
		expect(result.strandedAsset).toBeUndefined();
		expect(result.unwindFills).toHaveLength(1);
		expect(decToNumber(result.realizedPnl)).toBeLessThan(0);
	});
});

describe("against the paper engine", () => {
	it("completes end to end and moves balances consistently", async () => {
		const store = makeStore(PROFITABLE, NOW);
		const paper = new PaperEngine({
			store,
			fee: FEE_10BPS,
			startingBalances: { USDT: 1000 },
			latencyMs: 0,
			fillProbability: 1,
			adverseSelectionBps: 0,
			depthConsumptionRatio: 1,
			seed: 3,
			now: () => NOW,
			sleepFn: async () => {},
		});
		const executor = new CycleExecutor({
			engine: paper,
			store,
			rules: RULES,
			fee: FEE_10BPS,
			cycleDeadlineMs: 3000,
			aggressionTicks: 0,
			unwind: UNWIND,
			maxBookAgeMs: 5000,
			now: () => NOW,
		});

		const result = await executor.execute(buildOpportunity(store));
		expect(result.outcome).toBe("completed");
		// The 1.2x loop nets roughly 19.6% after three taker fees.
		expect(decToNumber(paper.balanceOf("USDT"))).toBeGreaterThan(1000);
		expect(decToNumber(result.realizedPnl)).toBeGreaterThan(0);
	});
});

describe("partial fill on a middle leg", () => {
	/**
	 * Regression: leg 2 under-consuming what leg 1 produced used to abandon the remainder.
	 *
	 * The cycle then reported a large loss it had not taken, while the unconverted inventory sat
	 * in the account invisibly. Both halves of that matter: the PnL was wrong and the position
	 * was unknown.
	 */
	it("retraces the unconverted remainder back to the start asset", async () => {
		const engine = new ScriptedEngine([fullFill, partialFill("0.4"), fullFill, fullFill]);
		const result = await makeExecutor(engine).execute(buildOpportunity());

		expect(result.outcome).toBe("completed");
		expect(result.strandedAsset).toBeUndefined();

		// The 60% of leg 1's BTC that leg 2 could not absorb is sold back to USDT.
		expect(result.unwindFills).toHaveLength(1);
		expect(result.unwindFills[0].leg.symbol).toBe("BTCUSDT");
		expect(result.unwindFills[0].leg.side).toBe("SELL");

		// Recovered output is the converted path plus the retraced remainder, so the cycle does not
		// book the whole input as a loss.
		expect(decToNumber(result.amountOut)).toBeGreaterThan(decToNumber(result.amountIn) * 0.9);
	});

	/**
	 * Regression: a remainder too small to sell used to be reported as stranded inventory.
	 *
	 * Commission comes out of the asset received, so a sliver below the next symbol's `minQty` is
	 * the normal end state of a healthy cycle - it was being retried three times and then logged at
	 * `error` on every single one. On a bot meant to run unattended for weeks that is worse than
	 * cosmetic: it makes the log line that means "a real position is sitting unhedged" invisible.
	 */
	it("leaves an untradeable remainder as dust without retrying or crying wolf", async () => {
		const logged: string[] = [];
		const engine = new ScriptedEngine([fullFill, fullFill, partialFill("0.999995")]);
		const executor = new CycleExecutor({
			engine,
			store: makeStore(PROFITABLE, NOW),
			rules: RULES,
			fee: FEE_10BPS,
			cycleDeadlineMs: 3000,
			aggressionTicks: 0,
			unwind: UNWIND,
			maxBookAgeMs: 5000,
			now: () => NOW,
			logger: new Logger({ level: "debug", pretty: false, sink: (line) => logged.push(line) }),
		});

		const result = await executor.execute(buildOpportunity());

		expect(result.outcome).toBe("completed");
		expect(result.strandedAsset).toBeUndefined();
		// Three legs and nothing else: the remainder is below ETHBTC's minQty, so not one unwind
		// order is sent, let alone the three the retry bound would have allowed.
		expect(engine.requests).toHaveLength(3);
		expect(result.unwindFills).toHaveLength(0);
		const entries = logged.map((line) => JSON.parse(line) as { level: string; msg: string });
		expect(entries.filter((entry) => entry.level === "error")).toHaveLength(0);
		expect(entries.filter((entry) => entry.level === "warn")).toHaveLength(0);
		expect(entries.some((entry) => entry.level === "debug" && /dust/.test(entry.msg))).toBe(true);
	});

	it("still reports a remainder that was large enough to sell but did not", async () => {
		// The other side of the same coin: a genuinely failed retrace must keep its warning.
		const logged: string[] = [];
		const engine = new ScriptedEngine([fullFill, partialFill("0.4"), fullFill, noFill, noFill, noFill]);
		const executor = new CycleExecutor({
			engine,
			store: makeStore(PROFITABLE, NOW),
			rules: RULES,
			fee: FEE_10BPS,
			cycleDeadlineMs: 3000,
			aggressionTicks: 0,
			unwind: UNWIND,
			maxBookAgeMs: 5000,
			now: () => NOW,
			logger: new Logger({ level: "warn", pretty: false, sink: (line) => logged.push(line) }),
		});

		await executor.execute(buildOpportunity());
		expect(logged.some((message) => /stranded|could not be retraced/.test(message))).toBe(true);
	});

	it("books a phantom loss if the remainder is ignored", async () => {
		// Guards the assertion above: with the retrace disabled, the same cycle reports a loss of
		// roughly the unconverted share of the input.
		const engine = new ScriptedEngine([fullFill, partialFill("0.4"), fullFill]);
		const executor = new CycleExecutor({
			engine,
			store: makeStore(PROFITABLE, NOW),
			rules: RULES,
			fee: FEE_10BPS,
			cycleDeadlineMs: 3000,
			aggressionTicks: 0,
			unwind: { ...UNWIND, enabled: false },
			maxBookAgeMs: 5000,
			now: () => NOW,
		});
		const result = await executor.execute(buildOpportunity());
		expect(result.unwindFills).toHaveLength(0);
		expect(decToNumber(result.amountOut)).toBeLessThan(decToNumber(result.amountIn) * 0.9);
	});
});

describe("ambiguous order failures", () => {
	/**
	 * Regression: an ambiguous leg failure used to be treated as a definite non-fill, after which
	 * the executor immediately traded against inventory it might no longer hold.
	 */
	it("does not unwind after a leg fails ambiguously", async () => {
		const engine = new ScriptedEngine([
			fullFill,
			() => new BinanceApiError(BINANCE_ERROR.TIMEOUT, "Timeout waiting for response", 504, "/api/v3/order"),
		]);
		const result = await makeExecutor(engine).execute(buildOpportunity());

		expect(result.outcome).toBe("error");
		expect(result.needsReconciliation).toBe(true);
		// Only leg 1 and the failed leg 2 were sent; no reversing order followed.
		expect(engine.requests).toHaveLength(2);
		expect(result.unwindFills).toHaveLength(0);
		expect(result.error).toContain("reconcile manually");
	});

	it("still unwinds after a leg fails definitively", async () => {
		const engine = new ScriptedEngine([
			fullFill,
			() => new BinanceApiError(BINANCE_ERROR.FILTER_FAILURE, "Filter failure: LOT_SIZE", 400, "/api/v3/order"),
			fullFill,
		]);
		const result = await makeExecutor(engine).execute(buildOpportunity());

		expect(result.needsReconciliation).toBe(false);
		expect(result.unwindFills.length).toBeGreaterThan(0);
		expect(result.strandedAsset).toBeUndefined();
	});

	it("reports no reconciliation need on a clean cycle", async () => {
		const engine = new ScriptedEngine([fullFill, fullFill, fullFill]);
		const result = await makeExecutor(engine).execute(buildOpportunity());
		expect(result.needsReconciliation).toBe(false);
	});
});

describe("resolving an ambiguous failure", () => {
	const timeout = () =>
		new BinanceApiError(BINANCE_ERROR.TIMEOUT, "Timeout waiting for response", 504, "/api/v3/order");

	it("treats a provably unplaced order as an ordinary missed leg", async () => {
		// The common case: the request never reached the matching engine. Querying proves it, so
		// the cycle can unwind normally instead of freezing for a human.
		const engine = new ScriptedEngine([fullFill, timeout, fullFill], "not_placed");
		const result = await makeExecutor(engine).execute(buildOpportunity());

		expect(engine.resolved).toHaveLength(1);
		expect(result.needsReconciliation).toBe(false);
		expect(result.unwindFills.length).toBeGreaterThan(0);
		expect(result.strandedAsset).toBeUndefined();
	});

	it("freezes when the order is found on the exchange", async () => {
		const engine = new ScriptedEngine([fullFill, timeout, fullFill], "filled");
		const result = await makeExecutor(engine).execute(buildOpportunity());

		expect(engine.resolved).toHaveLength(1);
		expect(result.needsReconciliation).toBe(true);
		expect(result.unwindFills).toHaveLength(0);
	});

	it("freezes when the lookup itself cannot answer", async () => {
		const engine = new ScriptedEngine([fullFill, timeout, fullFill], "unknown");
		const result = await makeExecutor(engine).execute(buildOpportunity());

		expect(result.needsReconciliation).toBe(true);
		expect(result.unwindFills).toHaveLength(0);
	});

	it("looks the order up by the id it was sent with", async () => {
		const engine = new ScriptedEngine([fullFill, timeout], "not_placed");
		await makeExecutor(engine).execute(buildOpportunity());
		// The id queried is the one generated for the failed leg, which is the whole point of
		// generating it before dispatch rather than inside the request.
		expect(engine.resolved[0].symbol).toBe("ETHBTC");
		expect(engine.resolved[0].clientOrderId).toMatch(/^arb-/);
		expect(engine.requests.map((r) => r.clientOrderId)).toContain(engine.resolved[0].clientOrderId);
	});
});

describe("expiry reasons", () => {
	it("records why the exchange expired a leg", () => {
		// A zero-fill IOC has several very different causes. UNFILLED_IOC_QUANTITY_EXPIRED is an
		// ordinary lost race; EXECUTION_RULE_PRICE_RANGE_EXCEEDED means the exchange refused the
		// price outright, which would otherwise look identical in the ledger.
		const expired =
			(reason: string) =>
			(request: OrderRequest): OrderOutcome => ({
				orderId: "",
				clientOrderId: request.clientOrderId,
				status: "EXPIRED",
				executedQty: ZERO,
				quoteQty: ZERO,
				fills: [],
				expiryReason: reason,
				latencyMs: 2,
			});

		return (async () => {
			const engine = new ScriptedEngine([expired(EXPIRY_REASON.PRICE_RANGE_EXCEEDED)]);
			const result = await makeExecutor(engine).execute(buildOpportunity());
			expect(result.outcome).toBe("aborted_no_fill");
			expect(result.fills[0].expiryReason).toBe("EXECUTION_RULE_PRICE_RANGE_EXCEEDED");
		})();
	});

	it("leaves the reason undefined on a normal fill", async () => {
		const engine = new ScriptedEngine([fullFill, fullFill, fullFill]);
		const result = await makeExecutor(engine).execute(buildOpportunity());
		expect(result.fills[0].expiryReason).toBeUndefined();
	});
});

describe("freshness window parity with the detector", () => {
	/**
	 * Regression: the executor kept the strict base window while the detector planned with the
	 * widened per-symbol one, so the detector deliberately admitted thin-venue cycles whose later
	 * legs the executor was guaranteed to refuse. A leg-2 refusal lands after leg 1 has committed
	 * funds - a forced unwind that pays fees and spread twice for a planned trade that could never
	 * complete. The strictness fired exactly one leg too late to protect anything.
	 */
	function thinStore(): BookStore {
		const store = new BookStore(() => NOW);
		let updateId = 1;
		for (const [symbol, quote] of Object.entries(PROFITABLE)) {
			// ETHBTC is a thin market: two updates ~20s apart seed its cadence, and its latest quote
			// is 5s old. The active legs are milliseconds old.
			const age = symbol === "ETHBTC" ? 5000 : 20;
			store.apply(
				makeBook(
					symbol,
					d(quote.bid),
					d(quote.bidQty),
					d(quote.ask),
					d(quote.askQty),
					updateId++,
					NOW - age - 20_000,
				),
			);
			store.apply(
				makeBook(symbol, d(quote.bid), d(quote.bidQty), d(quote.ask), d(quote.askQty), updateId++, NOW - age),
			);
		}
		return store;
	}

	function opportunityFrom(store: BookStore): Opportunity {
		const result = planOpportunity({
			cycle: TRIANGLE,
			store,
			rules: RULES,
			fee: FEE_10BPS,
			depthUtilization: 1,
			aggressionTicks: 0,
			maxInput: d("100"),
			minInput: d("10"),
			minNetEdgeBps: 8,
			requireNonNegativeWorstCase: true,
			now: NOW,
			maxBookAgeMs: 1500,
			maxBookAgeCeilingMs: 30_000,
			maxQuoteSkewMs: 1500,
		});
		if (!result.ok) throw new Error(`fixture is not tradable: ${result.reason}`);
		return result.opportunity;
	}

	it("executes the thin leg the detector planned instead of refusing it and unwinding", async () => {
		const store = thinStore();
		const opportunity = opportunityFrom(store);
		const engine = new ScriptedEngine([fullFill, fullFill, fullFill]);
		const executor = new CycleExecutor({
			engine,
			store,
			rules: RULES,
			fee: FEE_10BPS,
			cycleDeadlineMs: 3000,
			aggressionTicks: 0,
			unwind: UNWIND,
			maxBookAgeMs: 1500,
			maxBookAgeCeilingMs: 30_000,
			now: () => NOW,
		});
		const result = await executor.execute(opportunity);
		expect(result.outcome).toBe("completed");
		expect(result.fills).toHaveLength(3);
		expect(result.unwindFills).toHaveLength(0);
	});

	it("demonstrates the forced unwind the old strict window caused", async () => {
		// Same plan, but an executor still on the strict-only window: leg 1 fills, leg 2's 5s-old
		// book is refused, and the cycle unwinds leg 1 for nothing. This is the money-losing shape
		// the parity fix removes.
		const store = thinStore();
		const opportunity = opportunityFrom(store);
		const engine = new ScriptedEngine([fullFill, fullFill, fullFill]);
		const executor = new CycleExecutor({
			engine,
			store,
			rules: RULES,
			fee: FEE_10BPS,
			cycleDeadlineMs: 3000,
			aggressionTicks: 0,
			unwind: UNWIND,
			maxBookAgeMs: 1500,
			now: () => NOW,
		});
		const result = await executor.execute(opportunity);
		expect(result.outcome).not.toBe("completed");
		expect(result.unwindFills.length).toBeGreaterThan(0);
		expect(decToNumber(result.realizedPnl)).toBeLessThan(0);
	});
});

describe("dust on the main unwind path", () => {
	/**
	 * Regression: unwind() classified a below-minimum leftover as dust, but only the residual
	 * retrace consumed the flag. The main path (failed later leg) reported the identical unsellable
	 * sliver as stranded inventory, and haltOnStranded then stopped the whole bot over an amount no
	 * order can sell and no operator can reconcile.
	 */
	it("classifies an unsellable sliver from a failed later leg as dust, not stranded", async () => {
		// Leg 2 fills one lot step (0.0001 ETH ~ 0.00001 BTC of spend), leg 3 never fills. The tiny
		// ETH holding is below ETHUSDT's minNotional, and the unwind correctly refuses to sell it.
		const engine = new ScriptedEngine([fullFill, partialFill("0.0001"), noFill]);
		const result = await makeExecutor(engine).execute(buildOpportunity());
		// The outcome keeps the abort CAUSE (an earlier fix made sure of that); the structured
		// stranded signal is what must not fire, because haltOnStranded stops the whole bot on it.
		expect(result.strandedAsset).toBeUndefined();
		expect(result.strandedAmount).toBeUndefined();
		expect(result.outcome).not.toBe("stranded");
	});
});
