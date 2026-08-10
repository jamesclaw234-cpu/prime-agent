import { describe, expect, it } from "vitest";
import { settleLeg } from "../src/exec/engine.js";
import { PaperEngine } from "../src/exec/paper-engine.js";
import { decToNumber, decToString } from "../src/util/decimal.js";
import { BTCUSDT, d, FEE_10BPS, FEE_ZERO, makeStore, PROFITABLE, setQuote, TRIANGLE } from "./fixtures.js";

const NOW = 1_000_000;

function engine(overrides: Partial<ConstructorParameters<typeof PaperEngine>[0]> = {}): PaperEngine {
	const store = makeStore(PROFITABLE, NOW);
	return new PaperEngine({
		store,
		fee: FEE_10BPS,
		startingBalances: { USDT: 10_000, BTC: 1, ETH: 10 },
		latencyMs: 0,
		fillProbability: 1,
		adverseSelectionBps: 0,
		depthConsumptionRatio: 1,
		seed: 42,
		now: () => NOW,
		sleepFn: async () => {},
		...overrides,
	});
}

describe("fills", () => {
	it("fills a marketable buy at the ask and debits the quote asset", async () => {
		const paper = engine();
		const outcome = await paper.placeIoc({
			symbol: "BTCUSDT",
			side: "BUY",
			price: d("100"),
			quantity: d("1"),
			rules: BTCUSDT,
			clientOrderId: "test-1",
		});
		expect(outcome.status).toBe("FILLED");
		expect(decToString(outcome.executedQty)).toBe("1");
		expect(decToString(outcome.quoteQty)).toBe("100");
		expect(decToNumber(paper.balanceOf("USDT"))).toBeCloseTo(9900, 8);
		// 10bps commission is charged in the asset received.
		expect(decToNumber(paper.balanceOf("BTC"))).toBeCloseTo(1 + 0.999, 8);
	});

	it("fills a marketable sell at the bid and debits the base asset", async () => {
		const paper = engine();
		const outcome = await paper.placeIoc({
			symbol: "BTCUSDT",
			side: "SELL",
			price: d("99"),
			quantity: d("1"),
			rules: BTCUSDT,
			clientOrderId: "test-2",
		});
		expect(decToString(outcome.quoteQty)).toBe("99");
		expect(decToNumber(paper.balanceOf("BTC"))).toBeCloseTo(0, 8);
		expect(decToNumber(paper.balanceOf("USDT"))).toBeCloseTo(10_000 + 99 * 0.999, 8);
	});

	it("misses when the limit does not cross", async () => {
		const paper = engine();
		const outcome = await paper.placeIoc({
			symbol: "BTCUSDT",
			side: "BUY",
			price: d("99.5"),
			quantity: d("1"),
			rules: BTCUSDT,
			clientOrderId: "test-3",
		});
		expect(outcome.status).toBe("EXPIRED");
		expect(decToString(outcome.executedQty)).toBe("0");
		expect(decToNumber(paper.balanceOf("USDT"))).toBe(10_000);
	});

	it("partially fills against displayed size", async () => {
		const paper = engine({ depthConsumptionRatio: 0.5 });
		const outcome = await paper.placeIoc({
			symbol: "BTCUSDT",
			side: "BUY",
			price: d("100"),
			quantity: d("10"),
			rules: BTCUSDT,
			clientOrderId: "test-4",
		});
		expect(outcome.status).toBe("PARTIALLY_FILLED");
		expect(decToString(outcome.executedQty)).toBe("5");
	});

	it("rejects an order the account cannot fund, as the exchange would", async () => {
		const paper = engine({ startingBalances: { USDT: 50 } });
		const outcome = await paper.placeIoc({
			symbol: "BTCUSDT",
			side: "BUY",
			price: d("100"),
			quantity: d("1"),
			rules: BTCUSDT,
			clientOrderId: "test-5",
		});
		expect(outcome.status).toBe("REJECTED");
		expect(paper.stats.rejected).toBe(1);
	});
});

describe("pessimism", () => {
	it("degrades the fill price by the adverse-selection haircut", async () => {
		const paper = engine({ adverseSelectionBps: 100 });
		const outcome = await paper.placeIoc({
			symbol: "BTCUSDT",
			side: "BUY",
			price: d("200"),
			quantity: d("1"),
			rules: BTCUSDT,
			clientOrderId: "test-6",
		});
		// Ask 100 degraded by 1% costs 101, still inside the 200 limit.
		expect(decToNumber(outcome.fills[0].price)).toBeCloseTo(101, 8);
	});

	it("never fills worse than the limit price", async () => {
		const paper = engine({ adverseSelectionBps: 1000 });
		const outcome = await paper.placeIoc({
			symbol: "BTCUSDT",
			side: "BUY",
			price: d("100"),
			quantity: d("1"),
			rules: BTCUSDT,
			clientOrderId: "test-7",
		});
		expect(decToNumber(outcome.fills[0].price)).toBeLessThanOrEqual(100);
	});

	it("misses a share of orders when fill probability is below one", async () => {
		const paper = engine({ fillProbability: 0.5 });
		let filled = 0;
		for (let i = 0; i < 200; i++) {
			const outcome = await paper.placeIoc({
				symbol: "BTCUSDT",
				side: "BUY",
				price: d("100"),
				quantity: d("0.001"),
				rules: BTCUSDT,
				clientOrderId: `test-p${i}`,
			});
			if (outcome.status !== "EXPIRED") filled++;
		}
		expect(filled).toBeGreaterThan(60);
		expect(filled).toBeLessThan(140);
	});

	it("is reproducible from its seed", async () => {
		const run = async (): Promise<number> => {
			const paper = engine({ fillProbability: 0.5, seed: 7 });
			let filled = 0;
			for (let i = 0; i < 50; i++) {
				const outcome = await paper.placeIoc({
					symbol: "BTCUSDT",
					side: "BUY",
					price: d("100"),
					quantity: d("0.001"),
					rules: BTCUSDT,
					clientOrderId: `seed-${i}`,
				});
				if (outcome.status !== "EXPIRED") filled++;
			}
			return filled;
		};
		expect(await run()).toBe(await run());
	});

	it("re-reads the book after the latency delay, so a moved quote misses", async () => {
		let clock = NOW;
		const store = makeStore(PROFITABLE, NOW, () => clock);
		const paper = new PaperEngine({
			store,
			fee: FEE_ZERO,
			startingBalances: { USDT: 10_000 },
			latencyMs: 100,
			fillProbability: 1,
			adverseSelectionBps: 0,
			depthConsumptionRatio: 1,
			seed: 1,
			now: () => clock,
			// The quote runs away while the order is "in flight".
			sleepFn: async () => {
				clock += 100;
				setQuote(store, "BTCUSDT", { bid: "200", bidQty: "10", ask: "201", askQty: "10" }, clock, 99);
			},
		});
		const outcome = await paper.placeIoc({
			symbol: "BTCUSDT",
			side: "BUY",
			price: d("100"),
			quantity: d("1"),
			rules: BTCUSDT,
			clientOrderId: "race",
		});
		expect(outcome.status).toBe("EXPIRED");
	});
});

describe("settlement", () => {
	it("subtracts a commission charged in the received asset", () => {
		const settled = settleLeg(TRIANGLE.legs[0], {
			orderId: "1",
			clientOrderId: "c",
			status: "FILLED",
			executedQty: d("1"),
			quoteQty: d("100"),
			fills: [{ price: d("100"), qty: d("1"), commission: d("0.001"), commissionAsset: "BTC" }],
			latencyMs: 1,
		});
		expect(decToString(settled.amountIn)).toBe("100");
		expect(decToString(settled.amountOut)).toBe("0.999");
		expect(decToString(settled.avgPrice)).toBe("100");
	});

	it("leaves the received asset intact when the commission was paid in BNB", () => {
		const settled = settleLeg(TRIANGLE.legs[0], {
			orderId: "1",
			clientOrderId: "c",
			status: "FILLED",
			executedQty: d("1"),
			quoteQty: d("100"),
			fills: [{ price: d("100"), qty: d("1"), commission: d("0.02"), commissionAsset: "BNB" }],
			latencyMs: 1,
		});
		expect(decToString(settled.amountOut)).toBe("1");
		expect(settled.commissions).toEqual([{ asset: "BNB", amount: d("0.02") }]);
	});

	it("computes a volume-weighted average across several fills", () => {
		const settled = settleLeg(TRIANGLE.legs[2], {
			orderId: "1",
			clientOrderId: "c",
			status: "FILLED",
			executedQty: d("3"),
			quoteQty: d("36"),
			fills: [
				{ price: d("12"), qty: d("1"), commission: d("0.012"), commissionAsset: "USDT" },
				{ price: d("12"), qty: d("2"), commission: d("0.024"), commissionAsset: "USDT" },
			],
			latencyMs: 1,
		});
		expect(decToString(settled.avgPrice)).toBe("12");
		expect(decToString(settled.amountIn)).toBe("3");
		expect(decToString(settled.amountOut)).toBe("35.964");
	});

	it("reports zero rather than a negative amount when commission exceeds the fill", () => {
		const settled = settleLeg(TRIANGLE.legs[0], {
			orderId: "1",
			clientOrderId: "c",
			status: "FILLED",
			executedQty: d("1"),
			quoteQty: d("100"),
			fills: [{ price: d("100"), qty: d("1"), commission: d("2"), commissionAsset: "BTC" }],
			latencyMs: 1,
		});
		expect(decToString(settled.amountOut)).toBe("0");
	});
});
