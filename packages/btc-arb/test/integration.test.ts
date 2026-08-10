import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WsConnection, WsHandlers } from "../src/binance/ws-market-data.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { ArbBot } from "../src/run/bot.js";
import { silentLogger } from "../src/util/logger.js";
import { FLAT, PROFITABLE, type Quote } from "./fixtures.js";

/**
 * End-to-end wiring test.
 *
 * Drives the real `ArbBot` - real exchangeInfo parsing, universe selection, cycle enumeration,
 * detection, sizing, risk checks, paper execution and ledger - with only the two boundaries
 * replaced: the HTTP transport and the WebSocket. Everything between them is production code.
 */

function exchangeInfoBody(): string {
	const symbol = (name: string, base: string, quote: string, tick: string, step: string, minNotional: string) => ({
		symbol: name,
		status: "TRADING",
		baseAsset: base,
		baseAssetPrecision: 8,
		quoteAsset: quote,
		quoteAssetPrecision: 8,
		orderTypes: ["LIMIT", "MARKET"],
		isSpotTradingAllowed: true,
		permissionSets: [["SPOT"]],
		filters: [
			{ filterType: "PRICE_FILTER", minPrice: "0.000001", maxPrice: "1000000", tickSize: tick },
			{ filterType: "LOT_SIZE", minQty: step, maxQty: "900000", stepSize: step },
			{ filterType: "NOTIONAL", minNotional, applyMinToMarket: true, maxNotional: "9000000" },
		],
	});

	return JSON.stringify({
		timezone: "UTC",
		serverTime: 1_700_000_000_000,
		rateLimits: [
			{ rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 6000 },
			{ rateLimitType: "ORDERS", interval: "SECOND", intervalNum: 10, limit: 50 },
		],
		exchangeFilters: [],
		symbols: [
			symbol("BTCUSDT", "BTC", "USDT", "0.01", "0.00001", "5"),
			symbol("ETHBTC", "ETH", "BTC", "0.000001", "0.0001", "0.0001"),
			symbol("ETHUSDT", "ETH", "USDT", "0.01", "0.0001", "5"),
			// A market with no way out except reversing the same trade; must be pruned.
			symbol("XYZUSDT", "XYZ", "USDT", "0.01", "0.001", "5"),
		],
	});
}

function bookTickerBody(quotes: Record<string, Quote>): string {
	return JSON.stringify(
		Object.entries(quotes).map(([symbol, quote]) => ({
			symbol,
			bidPrice: quote.bid,
			bidQty: quote.bidQty,
			askPrice: quote.ask,
			askQty: quote.askQty,
		})),
	);
}

interface Harness {
	readonly bot: ArbBot;
	readonly sockets: FakeSocket[];
	readonly restPaths: string[];
	push(symbol: string, quote: Quote, updateId: number): void;
}

class FakeSocket implements WsConnection {
	closed = false;
	constructor(
		readonly url: string,
		readonly handlers: WsHandlers,
	) {}
	send(): void {}
	close(): void {
		this.closed = true;
	}
}

function harness(seedQuotes: Record<string, Quote>): Harness {
	const sockets: FakeSocket[] = [];
	const restPaths: string[] = [];
	const stateDir = mkdtempSync(join(tmpdir(), "btc-arb-it-"));

	const config = {
		...DEFAULT_CONFIG,
		universe: { ...DEFAULT_CONFIG.universe, quoteAssets: ["USDT", "BTC"], requireAsset: "" },
		fees: { takerBps: 10, autoDetect: false },
		detection: { ...DEFAULT_CONFIG.detection, minNetEdgeBps: 8, bellmanFordIntervalMs: 0, maxBookAgeMs: 60_000 },
		execution: {
			...DEFAULT_CONFIG.execution,
			startAssets: ["USDT"],
			maxNotionalPerCycle: 500,
			minNotionalPerCycle: 20,
			depthUtilization: 1,
			aggressionTicks: 0,
		},
		risk: { ...DEFAULT_CONFIG.risk, killSwitchFile: "", minTimeBetweenCyclesMs: 0 },
		paper: { ...DEFAULT_CONFIG.paper, startingBalances: { USDT: 5000 }, latencyMs: 0, fillProbability: 1, seed: 11 },
		observability: {
			...DEFAULT_CONFIG.observability,
			logFile: join(stateDir, "log.jsonl"),
			ledgerFile: join(stateDir, "ledger.jsonl"),
			metricsIntervalMs: 0,
			dashboard: false,
		},
	};

	const bot = new ArbBot({
		config,
		liveAllowed: false,
		logger: silentLogger(),
		fetchImpl: async (url: string): Promise<Response> => {
			const path = new URL(url).pathname;
			restPaths.push(path);
			if (path === "/api/v3/time") return new Response(JSON.stringify({ serverTime: Date.now() }));
			if (path === "/api/v3/exchangeInfo") return new Response(exchangeInfoBody());
			if (path === "/api/v3/ticker/bookTicker") return new Response(bookTickerBody(seedQuotes));
			return new Response("{}", { status: 404 });
		},
		wsFactory: (url, handlers) => {
			const socket = new FakeSocket(url, handlers);
			sockets.push(socket);
			return socket;
		},
	});

	return {
		bot,
		sockets,
		restPaths,
		push: (symbol, quote, updateId) => {
			for (const socket of sockets) {
				socket.handlers.onMessage(
					JSON.stringify({
						stream: `${symbol.toLowerCase()}@bookTicker`,
						data: { u: updateId, s: symbol, b: quote.bid, B: quote.bidQty, a: quote.ask, A: quote.askQty },
					}),
				);
			}
		},
	};
}

/** Yields to the event loop so the bot's async cycle execution can settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("startup", () => {
	it("loads markets, prunes dead ends, enumerates cycles and seeds the book", async () => {
		const h = harness(FLAT);
		await h.bot.start();

		expect(h.restPaths).toContain("/api/v3/time");
		expect(h.restPaths).toContain("/api/v3/exchangeInfo");
		expect(h.restPaths).toContain("/api/v3/ticker/bookTicker");

		const status = h.bot.status();
		// XYZUSDT is a dead end and must not be subscribed.
		expect(status.symbols).toBe(3);
		expect(status.cycles).toBe(2);
		expect(status.bookSymbols).toBe(3);
		expect(h.sockets).toHaveLength(1);
		expect(h.sockets[0].url).toContain("btcusdt@bookTicker");
		expect(h.sockets[0].url).not.toContain("xyzusdt");

		await h.bot.stop();
	});

	it("refuses to start when the universe contains no cycles", async () => {
		const h = harness(FLAT);
		const bot = new ArbBot({
			config: {
				...DEFAULT_CONFIG,
				universe: { ...DEFAULT_CONFIG.universe, quoteAssets: ["ZZZ"] },
				execution: { ...DEFAULT_CONFIG.execution, startAssets: ["ZZZ"] },
			},
			liveAllowed: false,
			logger: silentLogger(),
			fetchImpl: async (url: string): Promise<Response> => {
				const path = new URL(url).pathname;
				if (path === "/api/v3/time") return new Response(JSON.stringify({ serverTime: Date.now() }));
				if (path === "/api/v3/exchangeInfo") return new Response(exchangeInfoBody());
				return new Response("[]");
			},
			wsFactory: (url, handlers) => new FakeSocket(url, handlers),
		});
		await expect(bot.start()).rejects.toThrow(/no arbitrage cycles/);
		void h;
	});
});

describe("detect and execute", () => {
	it("does nothing on a flat book", async () => {
		const h = harness(FLAT);
		await h.bot.start();
		h.push("BTCUSDT", FLAT.BTCUSDT, 100);
		await settle();

		const status = h.bot.status();
		expect(status.detector.ticks).toBeGreaterThan(0);
		expect(status.detector.planned).toBe(0);
		expect(status.ledger.cycles).toBe(0);
		await h.bot.stop();
	});

	it("detects and paper-executes a profitable cycle end to end", async () => {
		const h = harness(FLAT);
		await h.bot.start();

		// Move ETHUSDT so the USDT -> BTC -> ETH -> USDT loop becomes worth 1.2x gross.
		h.push("ETHUSDT", PROFITABLE.ETHUSDT, 200);
		await settle();

		const status = h.bot.status();
		expect(status.detector.planned).toBeGreaterThan(0);
		expect(status.ledger.cycles).toBe(1);
		expect(status.ledger.completed).toBe(1);
		expect(status.ledger.realizedPnl).toBeGreaterThan(0);
		expect(status.ledger.byOutcome.completed).toBe(1);
		expect(status.risk.halted).toBe(false);

		await h.bot.stop();
	});

	it("respects the notional cap on the executed size", async () => {
		const h = harness(FLAT);
		await h.bot.start();
		h.push("ETHUSDT", PROFITABLE.ETHUSDT, 200);
		await settle();

		// maxNotionalPerCycle is 500 USDT; depth would allow far more.
		expect(h.bot.status().ledger.volume).toBeLessThanOrEqual(500);
		expect(h.bot.status().ledger.volume).toBeGreaterThan(0);
		await h.bot.stop();
	});

	it("does not execute in scan-only mode", async () => {
		const sockets: FakeSocket[] = [];
		const stateDir = mkdtempSync(join(tmpdir(), "btc-arb-it-"));
		const bot = new ArbBot({
			config: {
				...DEFAULT_CONFIG,
				universe: { ...DEFAULT_CONFIG.universe, quoteAssets: ["USDT", "BTC"], requireAsset: "" },
				fees: { takerBps: 10, autoDetect: false },
				detection: { ...DEFAULT_CONFIG.detection, bellmanFordIntervalMs: 0, maxBookAgeMs: 60_000 },
				execution: { ...DEFAULT_CONFIG.execution, startAssets: ["USDT"], depthUtilization: 1, aggressionTicks: 0 },
				risk: { ...DEFAULT_CONFIG.risk, killSwitchFile: "" },
				paper: { ...DEFAULT_CONFIG.paper, startingBalances: { USDT: 5000 }, latencyMs: 0, fillProbability: 1 },
				observability: {
					...DEFAULT_CONFIG.observability,
					logFile: join(stateDir, "log.jsonl"),
					ledgerFile: join(stateDir, "ledger.jsonl"),
					metricsIntervalMs: 0,
					dashboard: false,
				},
			},
			liveAllowed: false,
			scanOnly: true,
			logger: silentLogger(),
			fetchImpl: async (url: string): Promise<Response> => {
				const path = new URL(url).pathname;
				if (path === "/api/v3/time") return new Response(JSON.stringify({ serverTime: Date.now() }));
				if (path === "/api/v3/exchangeInfo") return new Response(exchangeInfoBody());
				if (path === "/api/v3/ticker/bookTicker") return new Response(bookTickerBody(PROFITABLE));
				return new Response("{}", { status: 404 });
			},
			wsFactory: (url, handlers) => {
				const socket = new FakeSocket(url, handlers);
				sockets.push(socket);
				return socket;
			},
		});

		await bot.start();
		for (const socket of sockets) {
			socket.handlers.onMessage(
				JSON.stringify({
					stream: "ethusdt@bookTicker",
					data: { u: 300, s: "ETHUSDT", b: "12", B: "100", a: "13", A: "100" },
				}),
			);
		}
		await settle();

		expect(bot.status().detector.planned).toBeGreaterThan(0);
		expect(bot.status().ledger.cycles).toBe(0);
		await bot.stop();
	});

	it("stops trading once the risk manager halts", async () => {
		const h = harness(FLAT);
		await h.bot.start();
		h.bot.riskManager.halt("test halt");

		h.push("ETHUSDT", PROFITABLE.ETHUSDT, 200);
		await settle();

		expect(h.bot.status().detector.planned).toBeGreaterThan(0);
		expect(h.bot.status().ledger.cycles).toBe(0);
		await h.bot.stop();
	});

	it("survives a stream reconnect without losing the cycle table", async () => {
		const h = harness(FLAT);
		await h.bot.start();
		const before = h.bot.status();

		h.sockets[0].handlers.onClose(1006, "abnormal");
		expect(h.bot.status().cycles).toBe(before.cycles);
		expect(h.bot.status().feed.reconnects).toBeGreaterThan(0);

		await h.bot.stop();
	});
});
