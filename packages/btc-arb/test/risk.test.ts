import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { RiskManager } from "../src/risk/limits.js";
import type { CycleOutcome, CycleResult, Opportunity } from "../src/types.js";
import { decFromString, ZERO } from "../src/util/decimal.js";
import { d, TRIANGLE } from "./fixtures.js";

const OPPORTUNITY = {
	id: "op-1",
	cycle: TRIANGLE,
	quote: { cycle: TRIANGLE, grossMultiple: 1.02, edgeBps: 200, maxBookAgeMs: 5 },
	legs: TRIANGLE.legs.map((leg) => ({
		leg,
		price: d("100"),
		quantity: d("1"),
		notional: d("100"),
		amountIn: d("100"),
		expectedOut: d("100"),
		referencePrice: d("100"),
	})),
	amountIn: d("100"),
	expectedOut: d("102"),
	expectedProfit: d("2"),
	netEdgeBps: 200,
	notionalInAccountingAsset: d("100"),
	detectedAt: 0,
} as unknown as Opportunity;

function makeResult(outcome: CycleOutcome, overrides: Partial<CycleResult> = {}): CycleResult {
	return {
		opportunityId: "op-1",
		cycleId: TRIANGLE.id,
		mode: "paper",
		outcome,
		startedAt: 0,
		finishedAt: 10,
		fills: [
			{
				leg: TRIANGLE.legs[0],
				requestedQty: d("1"),
				executedQty: d("1"),
				quoteQty: d("100"),
				amountIn: d("100"),
				amountOut: d("1"),
				commissions: [],
				avgPrice: d("100"),
				orderId: "1",
				clientOrderId: "c1",
				status: "FILLED",
				latencyMs: 5,
			},
		],
		unwindFills: [],
		amountIn: d("100"),
		amountOut: d("100"),
		realizedPnl: ZERO,
		realizedPnlAsset: "USDT",
		expectedProfit: d("2"),
		slippage: d("-2"),
		needsReconciliation: false,
		...overrides,
	};
}

function makeManager(overrides: Partial<typeof DEFAULT_CONFIG.risk> = {}, now = () => 1_000_000): RiskManager {
	return new RiskManager({
		config: { ...DEFAULT_CONFIG.risk, killSwitchFile: "", ...overrides },
		now,
		fileExists: () => false,
	});
}

describe("baseline", () => {
	it("allows a healthy cycle", () => {
		const risk = makeManager();
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
	});
});

describe("guards", () => {
	it("blocks while the feed is unhealthy", () => {
		const risk = makeManager();
		risk.setDataHealthy(false);
		const decision = risk.canStartCycle(OPPORTUNITY);
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.reason).toContain("unhealthy");
	});

	it("blocks when the clock has drifted past the limit", () => {
		const risk = makeManager({ maxClockSkewMs: 500 });
		risk.setClockSkew(1200);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
		risk.setClockSkew(-1200);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
		risk.setClockSkew(100);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
	});

	it("enforces the concurrency cap", () => {
		const risk = makeManager({ minTimeBetweenCyclesMs: 0 });
		risk.setMaxConcurrentCycles(1);
		risk.onCycleStart(OPPORTUNITY);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
	});

	it("enforces the minimum interval between cycles", () => {
		let now = 1_000_000;
		const risk = makeManager({ minTimeBetweenCyclesMs: 1000 }, () => now);
		risk.setMaxConcurrentCycles(4);
		risk.onCycleStart(OPPORTUNITY);
		risk.onCycleResult(makeResult("completed"), ZERO);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
		now += 1500;
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
	});

	it("halts after the daily loss limit", () => {
		const risk = makeManager({ maxDailyLoss: 10, minTimeBetweenCyclesMs: 0 });
		risk.onCycleStart(OPPORTUNITY);
		risk.onCycleResult(makeResult("completed"), decFromString("-11"));
		expect(risk.isHalted).toBe(true);
		expect(risk.reason).toContain("daily loss");
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
	});

	it("halts after consecutive failures and resets the streak on a win", () => {
		const risk = makeManager({ maxConsecutiveFailures: 3, minTimeBetweenCyclesMs: 0, symbolCooldownMs: 0 });
		risk.setMaxConcurrentCycles(4);
		for (let i = 0; i < 2; i++) {
			risk.onCycleStart(OPPORTUNITY);
			risk.onCycleResult(makeResult("aborted_no_fill"), ZERO);
		}
		expect(risk.isHalted).toBe(false);
		risk.onCycleStart(OPPORTUNITY);
		risk.onCycleResult(makeResult("completed"), ZERO);
		expect(risk.snapshot().consecutiveFailures).toBe(0);

		for (let i = 0; i < 3; i++) {
			risk.onCycleStart(OPPORTUNITY);
			risk.onCycleResult(makeResult("aborted_no_fill"), ZERO);
		}
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
		expect(risk.isHalted).toBe(true);
	});

	it("cools down the symbols of a failed cycle", () => {
		let now = 1_000_000;
		const risk = makeManager({ symbolCooldownMs: 5000, minTimeBetweenCyclesMs: 0 }, () => now);
		risk.setMaxConcurrentCycles(4);
		risk.onCycleStart(OPPORTUNITY);
		risk.onCycleResult(makeResult("aborted_no_fill"), ZERO);
		const decision = risk.canStartCycle(OPPORTUNITY);
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.reason).toContain("cooldown");
		now += 6000;
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
	});

	it("halts on stranded inventory regardless of the recorded outcome", () => {
		const risk = makeManager({ haltOnStranded: true, minTimeBetweenCyclesMs: 0 });
		risk.onCycleStart(OPPORTUNITY);
		risk.onCycleResult(makeResult("aborted_deadline", { strandedAsset: "BTC", strandedAmount: d("0.5") }), ZERO);
		expect(risk.isHalted).toBe(true);
		expect(risk.reason).toContain("BTC");
	});

	it("trips the error-rate breaker", () => {
		const risk = makeManager({ maxErrorsInWindow: 3, minTimeBetweenCyclesMs: 0 });
		for (let i = 0; i < 3; i++) risk.onError("boom");
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
		expect(risk.isHalted).toBe(true);
	});

	it("lets old errors age out of the window", () => {
		let now = 1_000_000;
		const risk = makeManager({ maxErrorsInWindow: 3, errorWindowMs: 1000, minTimeBetweenCyclesMs: 0 }, () => now);
		for (let i = 0; i < 2; i++) risk.onError("boom");
		now += 2000;
		expect(risk.snapshot().errorsInWindow).toBe(0);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
	});

	it("enforces the per-second order budget", () => {
		const risk = makeManager({ maxOrdersPerSecond: 4, minTimeBetweenCyclesMs: 0 });
		risk.setMaxConcurrentCycles(10);
		// One cycle of three legs fits; a second would need six.
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
		risk.onCycleStart(OPPORTUNITY);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
	});

	it("enforces the daily cycle cap", () => {
		const risk = makeManager({ maxCyclesPerDay: 2, minTimeBetweenCyclesMs: 0, maxOrdersPerSecond: 100 });
		risk.setMaxConcurrentCycles(10);
		for (let i = 0; i < 2; i++) {
			risk.onCycleStart(OPPORTUNITY);
			risk.onCycleResult(makeResult("completed"), ZERO);
		}
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
	});
});

describe("kill switch", () => {
	it("halts when the file appears", () => {
		let present = false;
		const risk = new RiskManager({
			config: { ...DEFAULT_CONFIG.risk, killSwitchFile: "/tmp/halt", killSwitchPollMs: 0 },
			now: () => 1_000_000,
			fileExists: () => present,
		});
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
		present = true;
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
		expect(risk.reason).toContain("kill switch");
	});

	it("does not poll more often than the configured interval", () => {
		let calls = 0;
		const risk = new RiskManager({
			config: { ...DEFAULT_CONFIG.risk, killSwitchFile: "/tmp/halt", killSwitchPollMs: 10_000 },
			now: () => 1_000_000,
			fileExists: () => {
				calls++;
				return false;
			},
		});
		risk.checkKillSwitch();
		risk.checkKillSwitch();
		risk.checkKillSwitch();
		expect(calls).toBe(1);
	});
});

describe("day rollover", () => {
	it("clears the daily counters and lifts a daily-loss halt", () => {
		let now = Date.UTC(2026, 0, 1, 23, 0, 0);
		const risk = makeManager({ maxDailyLoss: 10, minTimeBetweenCyclesMs: 0 }, () => now);
		risk.onCycleStart(OPPORTUNITY);
		risk.onCycleResult(makeResult("completed"), decFromString("-20"));
		expect(risk.isHalted).toBe(true);

		now = Date.UTC(2026, 0, 2, 1, 0, 0);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
		expect(risk.snapshot().dailyPnl).toBe(0);
		expect(risk.snapshot().cyclesToday).toBe(0);
	});

	it("keeps a halt raised for any other reason across the rollover", () => {
		let now = Date.UTC(2026, 0, 1, 23, 0, 0);
		const risk = makeManager({}, () => now);
		risk.halt("manual stop");
		now = Date.UTC(2026, 0, 2, 1, 0, 0);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
		expect(risk.isHalted).toBe(true);
	});

	it("resumes only when told to", () => {
		const risk = makeManager();
		risk.halt("manual stop");
		expect(risk.isHalted).toBe(true);
		risk.resume();
		expect(risk.isHalted).toBe(false);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
	});
});

describe("halt reasons", () => {
	it("keeps a second halt reason raised across the UTC rollover", () => {
		// Regression: halt() used to discard a new reason when already halted, and the rollover
		// then lifted the halt because it only inspected the first reason recorded.
		let now = Date.UTC(2026, 0, 1, 14, 0, 0);
		const risk = makeManager({ maxDailyLoss: 10, minTimeBetweenCyclesMs: 0 }, () => now);
		risk.onCycleStart(OPPORTUNITY);
		risk.onCycleResult(makeResult("completed"), decFromString("-20"));
		expect(risk.isHalted).toBe(true);

		risk.halt("ambiguous order failure: manual reconciliation required");

		now = Date.UTC(2026, 0, 2, 1, 0, 0);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
		expect(risk.isHalted).toBe(true);
		expect(risk.reason).toContain("reconciliation");
		// The daily-loss counters still reset; only that one reason is day-scoped.
		expect(risk.snapshot().dailyPnl).toBe(0);
	});

	it("lifts a daily-loss halt at the rollover when it is the only reason", () => {
		let now = Date.UTC(2026, 0, 1, 23, 0, 0);
		const risk = makeManager({ maxDailyLoss: 10, minTimeBetweenCyclesMs: 0 }, () => now);
		risk.onCycleStart(OPPORTUNITY);
		risk.onCycleResult(makeResult("completed"), decFromString("-20"));
		now = Date.UTC(2026, 0, 2, 1, 0, 0);
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
	});
});

describe("order accounting", () => {
	it("counts orders beyond the cycle's planned legs", () => {
		const risk = makeManager({ maxOrdersPerSecond: 6, minTimeBetweenCyclesMs: 0 });
		risk.setMaxConcurrentCycles(10);
		risk.onCycleStart(OPPORTUNITY);
		// The three planned legs are already reserved, so these are free.
		for (let i = 0; i < 3; i++) risk.recordOrder();
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(true);
		// Unwind retries are surplus and must consume the budget.
		for (let i = 0; i < 4; i++) risk.recordOrder();
		expect(risk.canStartCycle(OPPORTUNITY).allowed).toBe(false);
	});
});
