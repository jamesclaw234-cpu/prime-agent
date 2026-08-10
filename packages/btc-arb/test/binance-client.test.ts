import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_LIMITS,
	limitsFromExchangeInfo,
	ORDERS,
	ORDERS_DAY,
	RAW_REQUESTS,
	RateLimiter,
	WEIGHT,
} from "../src/binance/rate-limiter.js";
import { BinanceApiError, BinanceRestClient, MissingCredentialsError } from "../src/binance/rest-client.js";
import { BINANCE_ERROR } from "../src/binance/types.js";

const SECRET = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
const KEY = "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A";

interface Captured {
	url: string;
	method: string;
	headers: Record<string, string>;
}

function stubFetch(
	responder: (captured: Captured) => { status: number; body: string; headers?: Record<string, string> },
): { fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; calls: Captured[] } {
	const calls: Captured[] = [];
	const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
		const captured: Captured = {
			url,
			method: init?.method ?? "GET",
			headers: (init?.headers as Record<string, string>) ?? {},
		};
		calls.push(captured);
		const result = responder(captured);
		return new Response(result.body, { status: result.status, headers: result.headers });
	};
	return { fetchImpl, calls };
}

function makeClient(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	withCredentials = true,
): BinanceRestClient {
	return new BinanceRestClient({
		baseUrl: "https://api.example.test",
		apiKey: withCredentials ? KEY : undefined,
		apiSecret: withCredentials ? SECRET : undefined,
		recvWindowMs: 5000,
		timeoutMs: 1000,
		limiter: new RateLimiter({ limits: [...DEFAULT_LIMITS], safetyFactor: 1, now: () => 0 }),
		fetchImpl,
		now: () => 1_700_000_000_000,
	});
}

describe("signing", () => {
	it("reproduces the signature from Binance's own worked example", () => {
		// Verbatim from the SIGNED endpoint examples in binance-spot-api-docs. If this ever fails,
		// the signing scheme is wrong and every signed request will be rejected with -1022.
		const payload =
			"symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
		expect(createHmac("sha256", SECRET).update(payload).digest("hex")).toBe(
			"c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71",
		);
	});

	it("signs the exact query string with HMAC-SHA256", async () => {
		const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: "{}" }));
		await makeClient(fetchImpl).account();

		const url = new URL(calls[0].url);
		const signature = url.searchParams.get("signature");
		expect(signature).toMatch(/^[0-9a-f]{64}$/);

		// Reproduce the signature the way the docs describe: HMAC over everything before `&signature=`.
		const query = url.search.slice(1, url.search.indexOf("&signature="));
		expect(createHmac("sha256", SECRET).update(query).digest("hex")).toBe(signature);
	});

	it("stamps timestamp and recvWindow onto signed requests", async () => {
		const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: "{}" }));
		await makeClient(fetchImpl).account();
		const url = new URL(calls[0].url);
		expect(url.searchParams.get("timestamp")).toBe("1700000000000");
		expect(url.searchParams.get("recvWindow")).toBe("5000");
	});

	it("sends the API key header only when the endpoint needs it", async () => {
		const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: "{}" }));
		const client = makeClient(fetchImpl);
		await client.ping();
		await client.account();
		expect(calls[0].headers["X-MBX-APIKEY"]).toBeUndefined();
		expect(calls[1].headers["X-MBX-APIKEY"]).toBe(KEY);
	});

	it("keeps parameters in the query string even for POST, so the body never affects the signature", async () => {
		const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: JSON.stringify(orderBody()) }));
		await makeClient(fetchImpl).newOrder({
			symbol: "BTCUSDT",
			side: "BUY",
			type: "LIMIT",
			timeInForce: "IOC",
			quantity: "1.00000",
			price: "100.00",
		});
		expect(calls[0].method).toBe("POST");
		const url = new URL(calls[0].url);
		expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
		expect(url.searchParams.get("timeInForce")).toBe("IOC");
		expect(url.searchParams.get("newOrderRespType")).toBe("FULL");
	});

	it("refuses a signed request without credentials rather than sending an unsigned one", async () => {
		const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: "{}" }));
		await expect(makeClient(fetchImpl, false).account()).rejects.toThrow(MissingCredentialsError);
		expect(calls).toHaveLength(0);
	});

	it("percent-encodes parameters that need it", async () => {
		const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: '{"symbols":[]}' }));
		await makeClient(fetchImpl).exchangeInfo(["BTCUSDT", "ETHUSDT"]);
		expect(calls[0].url).toContain("symbols=%5B%22BTCUSDT%22%2C%22ETHUSDT%22%5D");
	});
});

function orderBody(): Record<string, unknown> {
	return {
		symbol: "BTCUSDT",
		orderId: 28,
		clientOrderId: "abc",
		transactTime: 1,
		price: "100.00",
		origQty: "1.00000",
		executedQty: "1.00000",
		cummulativeQuoteQty: "100.00000000",
		status: "FILLED",
		type: "LIMIT",
		side: "BUY",
		fills: [{ price: "100.00", qty: "1.00000", commission: "0.001", commissionAsset: "BTC", tradeId: 1 }],
	};
}

describe("error handling", () => {
	it("maps the code/msg envelope", async () => {
		const { fetchImpl } = stubFetch(() => ({
			status: 400,
			body: JSON.stringify({ code: -2010, msg: "Account has insufficient balance for requested action." }),
		}));
		await expect(makeClient(fetchImpl).account()).rejects.toMatchObject({
			code: BINANCE_ERROR.NEW_ORDER_REJECTED,
			httpStatus: 400,
		});
	});

	it("marks a transport failure as ambiguous, because the order may have landed", async () => {
		const fetchImpl = async (): Promise<Response> => {
			throw new Error("socket hang up");
		};
		try {
			await makeClient(fetchImpl).account();
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(BinanceApiError);
			const api = error as BinanceApiError;
			expect(api.ambiguous).toBe(true);
			expect(api.httpStatus).toBe(0);
		}
	});

	it("classifies retryable and definite failures differently", async () => {
		const rateLimited = new BinanceApiError(BINANCE_ERROR.TOO_MANY_REQUESTS, "too many", 429, "/x");
		const rejected = new BinanceApiError(BINANCE_ERROR.NEW_ORDER_REJECTED, "no balance", 400, "/x");
		expect(rateLimited.retryable).toBe(true);
		expect(rateLimited.ambiguous).toBe(false);
		expect(rejected.retryable).toBe(false);
		expect(rejected.ambiguous).toBe(false);
		expect(new BinanceApiError(BINANCE_ERROR.UNKNOWN, "?", 500, "/x").ambiguous).toBe(true);
	});

	it("penalises the limiter on a 429 and honours Retry-After", async () => {
		const limiter = new RateLimiter({ limits: [...DEFAULT_LIMITS], safetyFactor: 1, now: () => 0 });
		const { fetchImpl } = stubFetch(() => ({
			status: 429,
			body: JSON.stringify({ code: -1003, msg: "Too many requests" }),
			headers: { "retry-after": "30" },
		}));
		const client = new BinanceRestClient({
			baseUrl: "https://api.example.test",
			recvWindowMs: 5000,
			timeoutMs: 1000,
			limiter,
			fetchImpl,
			now: () => 0,
		});
		await expect(client.ping()).rejects.toMatchObject({ retryAfterMs: 30_000 });
		expect(limiter.penaltyRemainingMs).toBe(30_000);
	});

	it("reports a non-JSON body rather than crashing on it", async () => {
		const { fetchImpl } = stubFetch(() => ({ status: 200, body: "<html>maintenance</html>" }));
		await expect(makeClient(fetchImpl).serverTime()).rejects.toThrow(/not valid JSON/);
	});
});

describe("responses", () => {
	it("parses server time and records the clock offset", async () => {
		const { fetchImpl } = stubFetch(() => ({ status: 200, body: JSON.stringify({ serverTime: 1_700_000_000_500 }) }));
		const client = makeClient(fetchImpl);
		const offset = await client.syncClock();
		expect(offset).toBe(500);
		expect(client.clock.synced).toBe(true);
		expect(client.clock.timestamp()).toBe(1_700_000_000_500);
	});

	it("adopts the used-weight header as a floor on local accounting", async () => {
		const limiter = new RateLimiter({ limits: [...DEFAULT_LIMITS], safetyFactor: 1, now: () => 0 });
		const { fetchImpl } = stubFetch(() => ({
			status: 200,
			body: "{}",
			headers: { "x-mbx-used-weight-1m": "4321", "x-mbx-order-count-10s": "7" },
		}));
		const client = new BinanceRestClient({
			baseUrl: "https://api.example.test",
			recvWindowMs: 5000,
			timeoutMs: 1000,
			limiter,
			fetchImpl,
			now: () => 0,
		});
		await client.ping();
		expect(limiter.snapshot()[WEIGHT].used).toBe(4321);
		expect(limiter.snapshot()[ORDERS].used).toBe(7);
	});
});

describe("rate limiter", () => {
	it("allows usage up to the safety-adjusted budget", () => {
		const limiter = new RateLimiter({
			limits: [{ name: WEIGHT, intervalMs: 1000, limit: 100 }],
			safetyFactor: 0.5,
			now: () => 0,
		});
		expect(limiter.snapshot()[WEIGHT].limit).toBe(50);
		expect(limiter.canAcquire({ [WEIGHT]: 50 })).toBe(true);
		expect(limiter.canAcquire({ [WEIGHT]: 51 })).toBe(false);
	});

	it("waits until the window slides rather than failing", async () => {
		let now = 0;
		const waits: number[] = [];
		const limiter = new RateLimiter({
			limits: [{ name: WEIGHT, intervalMs: 1000, limit: 10 }],
			safetyFactor: 1,
			now: () => now,
			sleepFn: async (ms) => {
				waits.push(ms);
				now += ms;
			},
		});
		await limiter.acquire({ [WEIGHT]: 10 });
		await limiter.acquire({ [WEIGHT]: 10 });
		expect(waits).toEqual([1001]);
		expect(now).toBe(1001);
	});

	it("releases capacity as entries age out", async () => {
		let now = 0;
		const limiter = new RateLimiter({
			limits: [{ name: WEIGHT, intervalMs: 1000, limit: 10 }],
			safetyFactor: 1,
			now: () => now,
		});
		await limiter.acquire({ [WEIGHT]: 10 });
		expect(limiter.canAcquire({ [WEIGHT]: 1 })).toBe(false);
		now = 1500;
		expect(limiter.canAcquire({ [WEIGHT]: 10 })).toBe(true);
	});

	it("tracks several budgets at once", async () => {
		const limiter = new RateLimiter({
			limits: [
				{ name: WEIGHT, intervalMs: 60_000, limit: 6000 },
				{ name: ORDERS, intervalMs: 10_000, limit: 2 },
			],
			safetyFactor: 1,
			now: () => 0,
		});
		await limiter.acquire({ [WEIGHT]: 1, [ORDERS]: 1 });
		await limiter.acquire({ [WEIGHT]: 1, [ORDERS]: 1 });
		expect(limiter.canAcquire({ [WEIGHT]: 1, [ORDERS]: 1 })).toBe(false);
		expect(limiter.canAcquire({ [WEIGHT]: 1 })).toBe(true);
	});

	it("refuses a request larger than the whole budget instead of waiting forever", () => {
		const limiter = new RateLimiter({
			limits: [{ name: WEIGHT, intervalMs: 1000, limit: 10 }],
			safetyFactor: 1,
			now: () => 0,
		});
		expect(limiter.canAcquire({ [WEIGHT]: 999 })).toBe(false);
	});

	it("carries usage across a limit replacement", async () => {
		const limiter = new RateLimiter({
			limits: [{ name: WEIGHT, intervalMs: 60_000, limit: 6000 }],
			safetyFactor: 1,
			now: () => 0,
		});
		await limiter.acquire({ [WEIGHT]: 100 });
		limiter.replaceLimits([{ name: WEIGHT, intervalMs: 60_000, limit: 120 }]);
		expect(limiter.snapshot()[WEIGHT]).toEqual({ used: 100, limit: 120 });
	});

	it("separates the daily order budget from the ten-second one", () => {
		const limits = limitsFromExchangeInfo([
			{ rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 6000 },
			{ rateLimitType: "ORDERS", interval: "SECOND", intervalNum: 10, limit: 50 },
			{ rateLimitType: "ORDERS", interval: "DAY", intervalNum: 1, limit: 160_000 },
			{ rateLimitType: "RAW_REQUESTS", interval: "MINUTE", intervalNum: 5, limit: 61_000 },
		]);
		expect(limits.map((l) => l.name)).toEqual([WEIGHT, ORDERS, ORDERS_DAY, RAW_REQUESTS]);
		expect(limits[1]).toEqual({ name: ORDERS, intervalMs: 10_000, limit: 50 });
		expect(limits[2].intervalMs).toBe(86_400_000);
	});

	it("falls back to the built-in defaults when the payload is unusable", () => {
		expect(limitsFromExchangeInfo([])).toEqual([...DEFAULT_LIMITS]);
		expect(limitsFromExchangeInfo([{ rateLimitType: "X", interval: "FORTNIGHT", intervalNum: 1, limit: 5 }])).toEqual(
			[...DEFAULT_LIMITS],
		);
	});
});

describe("error classification against the published table", () => {
	it("treats every documented 'execution status unknown' code as ambiguous", () => {
		// -1006 "An unexpected response was received from the message bus. Execution status unknown."
		// -1007 "Timeout waiting for response from backend server. Send status unknown."
		// -1000 unknown error. 5xx: the docs say explicitly NOT to treat these as failures.
		for (const code of [BINANCE_ERROR.UNKNOWN, BINANCE_ERROR.TIMEOUT, BINANCE_ERROR.UNEXPECTED_RESP]) {
			expect(new BinanceApiError(code, "x", 200, "/api/v3/order").ambiguous).toBe(true);
		}
		expect(new BinanceApiError(-1, "x", 503, "/api/v3/order").ambiguous).toBe(true);
		expect(new BinanceApiError(-1, "x", 0, "/api/v3/order").ambiguous).toBe(true);
	});

	it("treats a request rejected before the matching engine as definite", () => {
		// -1013: "The request is rejected by the API. (i.e. The request didn't reach the Matching Engine.)"
		expect(new BinanceApiError(BINANCE_ERROR.FILTER_FAILURE, "Filter failure: LOT_SIZE", 400, "/x").ambiguous).toBe(
			false,
		);
		expect(new BinanceApiError(BINANCE_ERROR.NEW_ORDER_REJECTED, "insufficient balance", 400, "/x").ambiguous).toBe(
			false,
		);
	});

	it("classifies the order-count limit as retryable, not as an IP ban", () => {
		// -1015 is TOO_MANY_ORDERS, tracked per account. An IP ban is HTTP 418 or -1003.
		const tooManyOrders = new BinanceApiError(BINANCE_ERROR.TOO_MANY_ORDERS, "Too many new orders.", 429, "/x");
		expect(tooManyOrders.retryable).toBe(true);
		expect(tooManyOrders.ambiguous).toBe(false);
		expect(new BinanceApiError(BINANCE_ERROR.SERVER_BUSY, "overloaded", 503, "/x").retryable).toBe(true);
	});
});

describe("rate limit headers", () => {
	async function pingWith(
		headers: Record<string, string>,
		limits: { name: string; intervalMs: number; limit: number }[],
	) {
		const limiter = new RateLimiter({ limits, safetyFactor: 1, now: () => 0 });
		const { fetchImpl } = stubFetch(() => ({ status: 200, body: "{}", headers }));
		const client = new BinanceRestClient({
			baseUrl: "https://api.example.test",
			recvWindowMs: 5000,
			timeoutMs: 1000,
			limiter,
			fetchImpl,
			now: () => 0,
		});
		await client.ping();
		return limiter.snapshot();
	}

	it("matches the header interval rather than a hardcoded suffix", async () => {
		// The header suffix is (intervalNum)(intervalLetter), so it follows whatever intervals the
		// exchange publishes. A 1-second order budget yields X-MBX-ORDER-COUNT-1S, not -10S.
		const snapshot = await pingWith(
			{ "x-mbx-used-weight-1m": "1234", "x-mbx-order-count-1s": "7", "x-mbx-order-count-1d": "900" },
			[
				{ name: WEIGHT, intervalMs: 60_000, limit: 6000 },
				{ name: ORDERS, intervalMs: 1000, limit: 10 },
				{ name: ORDERS_DAY, intervalMs: 86_400_000, limit: 160_000 },
			],
		);
		expect(snapshot[WEIGHT].used).toBe(1234);
		expect(snapshot[ORDERS].used).toBe(7);
		expect(snapshot[ORDERS_DAY].used).toBe(900);
	});

	it("still matches a ten-second order budget", async () => {
		const snapshot = await pingWith({ "x-mbx-order-count-10s": "22" }, [
			{ name: ORDERS, intervalMs: 10_000, limit: 50 },
		]);
		expect(snapshot[ORDERS].used).toBe(22);
	});

	it("ignores a header whose interval no window covers", async () => {
		const snapshot = await pingWith({ "x-mbx-order-count-3h": "5" }, [
			{ name: ORDERS, intervalMs: 10_000, limit: 50 },
		]);
		expect(snapshot[ORDERS].used).toBe(0);
	});
});

describe("unfilled order count", () => {
	it("follows the exchange's count downward, because fills decrement it", async () => {
		// The ORDERS limit counts *unfilled* orders and decrements when one fills: "so long as your
		// orders trade, you can keep trading". Treating the header as a floor would throttle the bot
		// exactly when its orders are filling.
		const limiter = new RateLimiter({
			limits: [{ name: ORDERS, intervalMs: 10_000, limit: 50 }],
			safetyFactor: 1,
			now: () => 0,
		});
		await limiter.acquire({ [ORDERS]: 40 });
		expect(limiter.snapshot()[ORDERS].used).toBe(40);

		const { fetchImpl } = stubFetch(() => ({ status: 200, body: "{}", headers: { "x-mbx-order-count-10s": "3" } }));
		const client = new BinanceRestClient({
			baseUrl: "https://api.example.test",
			recvWindowMs: 5000,
			timeoutMs: 1000,
			limiter,
			fetchImpl,
			now: () => 0,
		});
		await client.ping();
		expect(limiter.snapshot()[ORDERS].used).toBe(3);
		expect(limiter.canAcquire({ [ORDERS]: 40 })).toBe(true);
	});

	it("keeps floor semantics for request weight, which has no decrement", async () => {
		const limiter = new RateLimiter({
			limits: [{ name: WEIGHT, intervalMs: 60_000, limit: 6000 }],
			safetyFactor: 1,
			now: () => 0,
		});
		await limiter.acquire({ [WEIGHT]: 500 });
		const { fetchImpl } = stubFetch(() => ({ status: 200, body: "{}", headers: { "x-mbx-used-weight-1m": "10" } }));
		const client = new BinanceRestClient({
			baseUrl: "https://api.example.test",
			recvWindowMs: 5000,
			timeoutMs: 1000,
			limiter,
			fetchImpl,
			now: () => 0,
		});
		await client.ping();
		// Other processes on the same IP add weight we cannot see, so a lower header never relaxes us.
		expect(limiter.snapshot()[WEIGHT].used).toBeGreaterThanOrEqual(500);
	});
});
