import { describe, expect, it } from "vitest";
import { privateKeyFromSecret, publicKeyFromRaw, rawPublicKey, verifyAuthMessage } from "../src/venue/auth.js";
import { MissingCredentialsError, PolymarketApiError, PolymarketRestClient } from "../src/venue/rest-client.js";

const SECRET = Buffer.alloc(32, 5).toString("base64");

/** Captures requests and verifies signatures the way the real server would. */
function harness(handler?: (url: URL, init: RequestInit) => Response) {
	const requests: { url: URL; init: RequestInit; signatureValid?: boolean }[] = [];
	const pub = publicKeyFromRaw(rawPublicKey(privateKeyFromSecret(SECRET)));
	const client = new PolymarketRestClient({
		keyId: "key-1",
		secretKey: SECRET,
		fetchImpl: async (rawUrl, init) => {
			const url = new URL(rawUrl);
			const record: (typeof requests)[number] = { url, init: init ?? {} };
			const headers = (init?.headers ?? {}) as Record<string, string>;
			if (headers["X-PM-Signature"]) {
				record.signatureValid = verifyAuthMessage(
					pub,
					headers["X-PM-Timestamp"],
					init?.method ?? "GET",
					url.pathname,
					headers["X-PM-Signature"],
				);
			}
			requests.push(record);
			return handler ? handler(url, init ?? {}) : new Response("{}");
		},
	});
	return { client, requests };
}

describe("host split", () => {
	it("serves public data from the gateway and trading from the api host", async () => {
		const { client, requests } = harness();
		await client.events({ limit: 5 });
		await client.openOrders();
		expect(requests[0].url.hostname).toBe("gateway.polymarket.us");
		expect(requests[0].init.headers).not.toHaveProperty("X-PM-Signature");
		expect(requests[1].url.hostname).toBe("api.polymarket.us");
		expect(requests[1].signatureValid).toBe(true);
	});
});

describe("signing over the wire", () => {
	it("signs the bare path even when a query string is sent", async () => {
		// The signed message excludes the query - verified against the SDK source. A client that
		// signed the full URL would authenticate against itself and fail against the venue.
		const { client, requests } = harness();
		await client.events({ limit: 10, offset: 20 });
		expect(requests[0].url.search).toBe("?limit=10&offset=20");
	});

	it("signs order placement and cancellation", async () => {
		const { client, requests } = harness();
		await client.createOrder({
			marketSlug: "btc-100k",
			intent: "ORDER_INTENT_BUY_LONG",
			type: "ORDER_TYPE_LIMIT",
			price: { value: "0.55", currency: "USD" },
			quantity: 10,
			tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
		});
		await client.cancelOrder("ord-1", "btc-100k");
		expect(requests[0].url.pathname).toBe("/v1/orders");
		expect(requests[0].signatureValid).toBe(true);
		expect(JSON.parse(String(requests[0].init.body)).intent).toBe("ORDER_INTENT_BUY_LONG");
		expect(requests[1].url.pathname).toBe("/v1/order/ord-1/cancel");
		expect(requests[1].signatureValid).toBe(true);
	});

	it("refuses signed endpoints without credentials instead of sending unsigned", async () => {
		const bare = new PolymarketRestClient({ fetchImpl: async () => new Response("{}") });
		await expect(bare.openOrders()).rejects.toThrow(MissingCredentialsError);
	});
});

describe("error classification", () => {
	it("classifies 5xx and transport failures as ambiguous, 4xx as definite", async () => {
		const { client } = harness(() => new Response('{"message":"nope"}', { status: 503 }));
		const error = await client.openOrders().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PolymarketApiError);
		expect((error as PolymarketApiError).ambiguous).toBe(true);
		expect((error as PolymarketApiError).retryable).toBe(true);

		const bad = harness(() => new Response('{"message":"bad order"}', { status: 400 }));
		const badError = await bad.client.openOrders().catch((caught: unknown) => caught);
		expect((badError as PolymarketApiError).ambiguous).toBe(false);
		expect((badError as PolymarketApiError).retryable).toBe(false);
	});
});

describe("public self-metering", () => {
	it("never exceeds the public budget within a minute window", async () => {
		let clock = 1_000_000;
		const times: number[] = [];
		const client = new PolymarketRestClient({
			publicRequestsPerMinute: 3,
			now: () => clock,
			fetchImpl: async () => {
				times.push(clock);
				return new Response('{"markets":[]}');
			},
		});
		// setTimeout waits advance the fake clock, so the test is instant and deterministic.
		const originalSetTimeout = globalThis.setTimeout;
		const patched = ((fn: () => void, ms?: number) => {
			clock += ms ?? 0;
			return originalSetTimeout(fn, 0);
		}) as typeof setTimeout;
		globalThis.setTimeout = patched;
		try {
			for (let i = 0; i < 5; i++) await client.markets();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
		// Requests 4 and 5 must land after the window rolled, never inside the same minute.
		const within = (t: number) => times.filter((x) => x > t - 60_000 && x <= t).length;
		for (const t of times) expect(within(t)).toBeLessThanOrEqual(3);
	});
});
