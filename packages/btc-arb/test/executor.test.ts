import { describe, expect, it } from "vitest";
import { planOpportunity } from "../src/core/sizing.js";
import type { ExecutionEngine, OrderOutcome, OrderRequest } from "../src/exec/engine.js";
import { CycleExecutor, reverseLeg } from "../src/exec/executor.js";
import { PaperEngine } from "../src/exec/paper-engine.js";
import type { Asset, Opportunity } from "../src/types.js";
import { type Dec, decMul, decSub, decToNumber, decToString, ZERO } from "../src/util/decimal.js";
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
	private index = 0;

	constructor(private readonly script: ((request: OrderRequest) => OrderOutcome | Error)[]) {}

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
