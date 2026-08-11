import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, RateLimiter } from "../src/binance/rate-limiter.js";
import { BinanceApiError, BinanceRestClient } from "../src/binance/rest-client.js";
import {
	type ArbConfig,
	evaluateLiveGate,
	LIVE_CONFIRMATION_ENV,
	LIVE_CONFIRMATION_PHRASE,
	loadConfig,
} from "../src/config.js";
import { ArbBot } from "../src/run/bot.js";
import { decToNumber } from "../src/util/decimal.js";
import { silentLogger } from "../src/util/logger.js";
import { FakeBinance, type FakeQuote } from "./fake-binance.js";
import { FLAT, PROFITABLE } from "./fixtures.js";

/**
 * The bot against a real server, over real sockets.
 *
 * Everywhere else the suite injects a `fetch` and a WebSocket, which leaves two things unproven:
 * that the signed query string is accepted by something that checks the HMAC over the bytes it
 * received, and that the feed can read frames it did not construct itself. Both only fail for the
 * first time in production otherwise.
 *
 * Nothing here is stubbed. `fetchImpl` and `wsFactory` are left unset, so this exercises Node's
 * `fetch` and Node's `WebSocket` against `test/fake-binance.ts` on a loopback port.
 */

const QUOTES: Record<string, FakeQuote> = { ...PROFITABLE, XYZUSDT: { bid: "1", bidQty: "5", ask: "2", askQty: "5" } };
const FLAT_QUOTES: Record<string, FakeQuote> = { ...FLAT, XYZUSDT: { bid: "1", bidQty: "5", ask: "2", askQty: "5" } };

interface Harness {
	readonly bot: ArbBot;
	readonly fake: FakeBinance;
	readonly config: ArbConfig;
}

const running: Harness[] = [];

afterEach(async () => {
	for (const harness of running.splice(0)) {
		await harness.bot.stop();
		await harness.fake.stop();
	}
});

interface BootOptions {
	readonly live?: boolean;
	readonly autoDetectFees?: boolean;
	readonly quotes?: Record<string, FakeQuote>;
	readonly balances?: Record<string, string>;
}

async function boot(options: BootOptions = {}): Promise<Harness> {
	const fake = new FakeBinance({
		quotes: options.quotes ?? QUOTES,
		balances: options.balances ?? { USDT: "5000" },
		takerBps: 10,
	});
	const { restBaseUrl, wsBaseUrl } = await fake.start();
	const stateDir = mkdtempSync(join(tmpdir(), "btc-arb-loopback-"));

	const env: NodeJS.ProcessEnv = {
		BINANCE_API_KEY: fake.apiKey,
		BINANCE_API_SECRET: fake.apiSecret,
		...(options.live ? { ARB_MODE: "live", [LIVE_CONFIRMATION_ENV]: LIVE_CONFIRMATION_PHRASE } : {}),
	};

	// Loaded through the real loader rather than assembled by hand, so the localhost exemption in
	// the https check is covered by the same test that depends on it.
	const config = loadConfig({
		env,
		overrides: {
			binance: { restBaseUrl, wsBaseUrl, streamsPerConnection: 2 },
			universe: { quoteAssets: ["USDT", "BTC"], requireAsset: "" },
			fees: { takerBps: 10, autoDetect: options.autoDetectFees ?? false },
			detection: { minNetEdgeBps: 8, bellmanFordIntervalMs: 0, maxBookAgeMs: 60_000 },
			execution: {
				startAssets: ["USDT"],
				maxNotionalPerCycle: 300,
				minNotionalPerCycle: 20,
				depthUtilization: 1,
				aggressionTicks: 0,
			},
			risk: { killSwitchFile: "", minTimeBetweenCyclesMs: 0, maxClockSkewMs: 5000 },
			paper: { startingBalances: { USDT: 5000 }, latencyMs: 0, fillProbability: 1, seed: 11 },
			observability: {
				logFile: join(stateDir, "log.jsonl"),
				ledgerFile: join(stateDir, "ledger.jsonl"),
				metricsIntervalMs: 0,
				dashboard: false,
				logLevel: "error",
			},
		},
	});

	const gate = evaluateLiveGate(config, env, options.live ?? false);
	expect(gate.allowed).toBe(options.live ?? false);

	const bot = new ArbBot({ config, liveAllowed: gate.allowed, logger: silentLogger() });
	const harness: Harness = { bot, fake, config };
	running.push(harness);
	await bot.start();
	return harness;
}

/** Polls a condition against wall-clock time; the sockets here are genuinely asynchronous. */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** Re-publishes until the bot reacts; a single frame can land before the socket is fully wired. */
async function pump(
	fake: FakeBinance,
	quotes: Record<string, FakeQuote>,
	until: () => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (until()) return;
		fake.publishAll(quotes);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	if (!until()) throw new Error("timed out pumping quotes");
}

describe("startup over a real socket", () => {
	it("completes the startup sequence against a server that checks every signature", async () => {
		const { bot, fake } = await boot();

		expect(fake.paths).toContain("/api/v3/time");
		expect(fake.paths).toContain("/api/v3/exchangeInfo");
		expect(fake.paths).toContain("/api/v3/ticker/bookTicker");
		expect(fake.signatureFailures).toBe(0);

		const status = bot.status();
		// XYZUSDT is quoted but is a dead end, so it is pruned before a stream slot is spent on it.
		expect(status.symbols).toBe(3);
		expect(status.cycles).toBe(2);
		expect(status.bookSymbols).toBe(3);
		// Three symbols at two streams per connection is two shards, both genuinely connected.
		expect(status.feed.shards).toBe(2);
		await waitFor("both shards to open", () => fake.openConnections === 2);
	});

	it("reads signed endpoints that a wrong secret would be refused for", async () => {
		const { bot, fake } = await boot({ autoDetectFees: true });

		// autoDetect makes startup call the two signed endpoints; the fake verifies the HMAC over
		// the exact bytes, so reaching a fee at all proves the signature was accepted.
		expect(fake.paths).toContain("/api/v3/account/commission");
		expect(bot.status().takerBps).toBeCloseTo(10, 6);
		expect(fake.signatureFailures).toBe(0);
	});

	it("adopts the exchange's own usage counters from real response headers", async () => {
		const fake = new FakeBinance({ quotes: QUOTES });
		const { restBaseUrl } = await fake.start();
		try {
			const limiter = new RateLimiter({ limits: [...DEFAULT_LIMITS], safetyFactor: 0.7 });
			const client = new BinanceRestClient({
				baseUrl: restBaseUrl,
				recvWindowMs: 5000,
				timeoutMs: 5000,
				limiter,
			});
			expect(limiter.snapshot().REQUEST_WEIGHT.used).toBe(0);
			await client.ping();
			expect(limiter.snapshot().REQUEST_WEIGHT.used).toBe(1);

			// Something else on the same key has been spending the budget. Our own tally says 2; the
			// exchange says 900, and the exchange is the one that enforces it. These are headers off
			// a real socket, parsed by the regex that has to survive Binance changing its interval.
			fake.reportUsedWeight(900);
			await client.ping();
			expect(limiter.snapshot().REQUEST_WEIGHT.used).toBe(900);
		} finally {
			await fake.stop();
		}
	});

	it("syncs the clock from the exchange rather than trusting the local one", async () => {
		const { bot } = await boot();
		// Loopback round trip, so the measured offset is small but genuinely measured.
		expect(Math.abs(bot.status().clockSkewMs)).toBeLessThan(1000);
	});
});

describe("market data over a real WebSocket", () => {
	it("receives framed book updates and moves the book", async () => {
		const { bot, fake } = await boot({ quotes: FLAT_QUOTES });
		await waitFor("shards to open", () => fake.openConnections === 2);

		await pump(fake, FLAT_QUOTES, () => bot.status().feed.messages >= 3);

		const status = bot.status();
		expect(status.feed.messages).toBeGreaterThanOrEqual(3);
		expect(status.feed.parseErrors).toBe(0);
		expect(status.feed.openShards).toBe(2);
	});

	it("reconnects when the exchange announces a shutdown", async () => {
		const { bot, fake } = await boot({ quotes: FLAT_QUOTES });
		await waitFor("shards to open", () => fake.openConnections === 2);
		await pump(fake, FLAT_QUOTES, () => bot.status().feed.messages >= 2);

		fake.announceShutdown();

		// Both shards drop and come back on their own; the count returning to two is the proof.
		await waitFor("reconnects to be recorded", () => bot.status().feed.reconnects >= 2, 10_000);
		await waitFor("shards to reopen", () => fake.openConnections === 2, 10_000);
	}, 20_000);
});

describe("live execution over the wire", () => {
	it("places signed IOC limit orders and the exchange balance moves accordingly", async () => {
		const { bot, fake } = await boot({ live: true });
		expect(bot.status().mode).toBe("live");
		await waitFor("shards to open", () => fake.openConnections === 2);

		await pump(fake, QUOTES, () => fake.placements.length >= 3, 10_000);
		await waitFor("the cycle to be recorded", () => bot.status().ledger.cycles >= 1, 10_000);

		const legs = fake.placements.slice(0, 3);
		expect(legs.map((order) => order.symbol)).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
		expect(legs.map((order) => order.side)).toEqual(["BUY", "BUY", "SELL"]);
		for (const order of legs) {
			expect(order.type).toBe("LIMIT");
			expect(order.timeInForce).toBe("IOC");
			expect(order.status).toBe("FILLED");
			// Plain decimal, never exponential: Binance rejects `1e-7` outright.
			expect(order.price).toMatch(/^\d+(\.\d+)?$/);
			expect(order.quantity).toMatch(/^\d+(\.\d+)?$/);
		}
		// Formatted to each symbol's own tick and step, not to a shared default.
		expect(legs[0].price.split(".")[1]).toHaveLength(2);
		expect(legs[1].price.split(".")[1]).toHaveLength(6);
		expect(legs[1].quantity.split(".")[1]).toHaveLength(4);

		expect(fake.signatureFailures).toBe(0);

		// The exchange's own books are the arbiter: the account must actually be richer.
		const usdt = decToNumber(fake.balanceOf("USDT"));
		expect(usdt).toBeGreaterThan(5000);
		const summary = bot.status().ledger;
		expect(summary.realizedPnl).toBeGreaterThan(0);
		expect(bot.riskManager.snapshot().halted).toBe(false);
	}, 30_000);

	it("does not trade a flat book", async () => {
		const { bot, fake } = await boot({ live: true, quotes: FLAT_QUOTES });
		await waitFor("shards to open", () => fake.openConnections === 2);

		const deadline = Date.now() + 1500;
		while (Date.now() < deadline) {
			fake.publishAll(FLAT_QUOTES);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		expect(fake.placements).toHaveLength(0);
		expect(bot.status().ledger.cycles).toBe(0);
		expect(decToNumber(fake.balanceOf("USDT"))).toBe(5000);
	}, 20_000);
});

describe("ambiguous failures over the wire", () => {
	it("keeps trading when the exchange proves the lost order was never placed", async () => {
		const { bot, fake } = await boot({ live: true });
		await waitFor("shards to open", () => fake.openConnections === 2);
		// A 5xx with no order behind it: the reply was lost, but nothing reached the book.
		fake.failNextOrders(1, { status: 503, code: -1000, msg: "Internal error; unable to process your request." });

		await pump(fake, QUOTES, () => fake.placements.length >= 1, 10_000);
		await waitFor("the failed cycle to be recorded", () => bot.status().ledger.cycles >= 1, 10_000);

		// `queryOrder` answered `-2013 Order does not exist`, which is proof of a clean miss. There
		// is no position to reconcile, so halting would be an overreaction.
		expect(fake.paths).toContain("/api/v3/order");
		expect(bot.riskManager.snapshot().halted).toBe(false);
	}, 30_000);

	it("halts when the lost order turns out to have executed", async () => {
		const { bot, fake } = await boot({ live: true });
		await waitFor("shards to open", () => fake.openConnections === 2);
		// The same 5xx, but this time the order is on the book. Only the reply was lost.
		fake.failNextOrders(1, {
			status: 503,
			code: -1000,
			msg: "Internal error; unable to process your request.",
			place: true,
		});

		await pump(fake, QUOTES, () => fake.placements.length >= 1, 10_000);
		await waitFor("the bot to halt", () => bot.riskManager.snapshot().halted, 10_000);

		const snapshot = bot.riskManager.snapshot();
		expect(snapshot.haltReason).toMatch(/ambiguous|reconcil/i);
		// Halted means halted: no further orders after the one that went missing.
		const placedWhenHalted = fake.placements.length;
		fake.publishAll(QUOTES);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(fake.placements.length).toBe(placedWhenHalted);
	}, 30_000);
});

describe("credential errors over the wire", () => {
	it("surfaces a bad signature as -1022 rather than as a parse failure", async () => {
		const fake = new FakeBinance({ quotes: QUOTES });
		const { restBaseUrl } = await fake.start();
		try {
			const client = new BinanceRestClient({
				baseUrl: restBaseUrl,
				apiKey: fake.apiKey,
				apiSecret: "the-wrong-secret",
				recvWindowMs: 5000,
				timeoutMs: 5000,
				limiter: new RateLimiter({ limits: [...DEFAULT_LIMITS], safetyFactor: 0.7 }),
			});
			await expect(client.account()).rejects.toMatchObject({ code: -1022, httpStatus: 401 });
			expect(fake.signatureFailures).toBe(1);
		} finally {
			await fake.stop();
		}
	});

	it("surfaces a bad API key as -2015", async () => {
		const fake = new FakeBinance({ quotes: QUOTES });
		const { restBaseUrl } = await fake.start();
		try {
			const client = new BinanceRestClient({
				baseUrl: restBaseUrl,
				apiKey: "not-the-key",
				apiSecret: fake.apiSecret,
				recvWindowMs: 5000,
				timeoutMs: 5000,
				limiter: new RateLimiter({ limits: [...DEFAULT_LIMITS], safetyFactor: 0.7 }),
			});
			const error = await client.account().catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(BinanceApiError);
			expect((error as BinanceApiError).code).toBe(-2015);
			// A permissions problem is not something to retry, and definitely not ambiguous.
			expect((error as BinanceApiError).retryable).toBe(false);
			expect((error as BinanceApiError).ambiguous).toBe(false);
		} finally {
			await fake.stop();
		}
	});

	it("rejects a stale timestamp with -1021, the way a skewed clock would be refused", async () => {
		const fake = new FakeBinance({ quotes: QUOTES });
		const { restBaseUrl } = await fake.start();
		try {
			const client = new BinanceRestClient({
				baseUrl: restBaseUrl,
				apiKey: fake.apiKey,
				apiSecret: fake.apiSecret,
				recvWindowMs: 5000,
				timeoutMs: 5000,
				limiter: new RateLimiter({ limits: [...DEFAULT_LIMITS], safetyFactor: 0.7 }),
				// A clock an hour behind the exchange, which is what an unsynced host looks like.
				now: () => Date.now() - 3_600_000,
			});
			await expect(client.account()).rejects.toMatchObject({ code: -1021 });
		} finally {
			await fake.stop();
		}
	});
});

describe("venue parameter strictness", () => {
	/**
	 * Regression: `GET /api/v3/account` carried `omitZeroBalances`.
	 *
	 * Binance.com ignores it; Binance.US answers `-1101 Too many parameters`. That endpoint is the
	 * only source of balances, so on Binance.US every balance refresh failed, every cycle had no
	 * budget, and the bot ran indefinitely without ever placing an order or reporting a fault. The
	 * fake refuses extra parameters here for exactly that reason.
	 */
	it("reads balances from a venue that refuses optional parameters", async () => {
		const { bot, fake } = await boot({ live: true });
		expect(fake.paths).toContain("/api/v3/account");

		// A funded budget is the observable consequence: with the balance read failing, nothing is
		// spendable and no cycle can ever be sized.
		await waitFor("shards to open", () => fake.openConnections === 2);
		await pump(fake, QUOTES, () => fake.placements.length >= 3, 10_000);
		expect(bot.status().ledger.cycles).toBeGreaterThanOrEqual(1);
	}, 30_000);
});
