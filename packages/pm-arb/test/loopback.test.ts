import { randomBytes } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BookStore, type TopOfBook } from "../src/core/book.js";
import { decToString } from "../src/util/decimal.js";
import { createAuthHeaders, privateKeyFromSecret, rawPublicKey } from "../src/venue/auth.js";
import { MarketDataFeed } from "../src/venue/feed.js";
import { PolymarketApiError, PolymarketRestClient } from "../src/venue/rest-client.js";
import { rawWebSocketFactory } from "../src/venue/ws-client.js";
import { FakePolymarketUS } from "./fake-polymarket-us.js";

/**
 * The venue layer against a real server over real sockets - Node's own fetch and WebSocket,
 * nothing stubbed. The fake verifies Ed25519 signatures over the exact bytes received and refuses
 * what the venue would refuse, so a pass here means the requests would authenticate live.
 */

const SECRET = Buffer.alloc(32, 11).toString("base64");
const KEY_ID = "test-key-1";

const MARKETS = [
	{ slug: "yes-alpha", eventSlug: "event-a", bid: "0.44", bidQty: "120", ask: "0.47", askQty: "80" },
	{ slug: "yes-beta", eventSlug: "event-a", bid: "0.30", bidQty: "200", ask: "0.33", askQty: "150" },
];

const running: FakePolymarketUS[] = [];

afterEach(async () => {
	for (const fake of running.splice(0)) await fake.stop();
});

async function boot(balanceUsd = "100") {
	const fake = new FakePolymarketUS({
		markets: MARKETS.map((market) => ({ ...market })),
		keys: { [KEY_ID]: rawPublicKey(privateKeyFromSecret(SECRET)) },
		balanceUsd,
	});
	running.push(fake);
	const { baseUrl } = await fake.start();
	const client = new PolymarketRestClient({
		gatewayBaseUrl: baseUrl,
		apiBaseUrl: baseUrl,
		keyId: KEY_ID,
		secretKey: SECRET,
	});
	return { fake, client, baseUrl };
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("REST over a real socket", () => {
	it("serves public data and verifies the signature on trading calls", async () => {
		const { fake, client } = await boot();
		const events = await client.events();
		expect(events).toHaveLength(1);
		expect(events[0].markets).toHaveLength(2);

		const book = await client.book("yes-alpha");
		expect(book.offers?.[0].px.value).toBe("0.47");

		await client.openOrders();
		expect(fake.signatureFailures).toBe(0);
	});

	it("rejects a tampered key: the signature check is real, not decorative", async () => {
		const { fake, baseUrl } = await boot();
		const wrong = new PolymarketRestClient({
			gatewayBaseUrl: baseUrl,
			apiBaseUrl: baseUrl,
			keyId: KEY_ID,
			secretKey: Buffer.alloc(32, 12).toString("base64"),
		});
		await expect(wrong.openOrders()).rejects.toMatchObject({ httpStatus: 401 });
		expect(fake.signatureFailures).toBe(1);
	});

	it("places a marketable IOC BUY_LONG: the create response is {id, executions}, not {order}", async () => {
		const { fake, client } = await boot();
		const response = await client.createOrder({
			marketSlug: "yes-alpha",
			intent: "ORDER_INTENT_BUY_LONG",
			type: "ORDER_TYPE_LIMIT",
			price: { value: "0.47", currency: "USD" },
			quantity: 10,
			tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
		});
		// Order state and fills live INSIDE executions[i].order on this venue's create response.
		expect(response.id).toBeDefined();
		const execution = response.executions?.[0];
		expect(execution?.type).toBe("EXECUTION_TYPE_FILL");
		expect(execution?.order?.state).toBe("ORDER_STATE_FILLED");
		expect(execution?.order?.cumQuantity).toBe(10);
		// 10 shares at the 0.47 ask.
		expect(decToString(fake.balanceOf())).toBe("95.3");
	});

	it("refuses what the venue refuses, each for its OWN reason, not one hiding another", async () => {
		const { client } = await boot("2");
		const base = {
			marketSlug: "yes-alpha",
			intent: "ORDER_INTENT_BUY_LONG" as const,
			type: "ORDER_TYPE_LIMIT" as const,
			tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL" as const,
		};
		// The message is asserted per case because the statuses are identical: with a $2 balance
		// the out-of-range and off-tick cases would ALSO fail the funds check, so a status-only
		// assertion could not tell whether the check it pins still exists.
		const cases: { params: Parameters<typeof client.createOrder>[0]; reason: RegExp }[] = [
			{ params: { ...base, price: { value: "0.475", currency: "USD" }, quantity: 10 }, reason: /tick/ },
			{ params: { ...base, price: { value: "1.00", currency: "USD" }, quantity: 10 }, reason: /inside \(0, 1\)/ },
			{ params: { ...base, price: { value: "0.47", currency: "USD" }, quantity: 4 }, reason: />= 5/ },
			{ params: { ...base, price: { value: "0.47", currency: "USD" }, quantity: 10 }, reason: /buying power/ },
			{
				params: { ...base, intent: "BUY_LONG" as never, price: { value: "0.47", currency: "USD" }, quantity: 10 },
				reason: /ORDER_INTENT/,
			},
			{
				params: {
					...base,
					tif: "TIME_IN_FORCE_GOOD_TILL_CANCEL" as never,
					price: { value: "0.47", currency: "USD" },
					quantity: 10,
				},
				reason: /immediate orders only/,
			},
		];
		for (const { params, reason } of cases) {
			const error = await client.createOrder(params).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(PolymarketApiError);
			expect((error as PolymarketApiError).httpStatus).toBe(400);
			expect((error as PolymarketApiError).message).toMatch(reason);
		}
	});

	it("fills BUY_SHORT against the mirrored side of the unified book", async () => {
		const { client } = await boot();
		// SHORT ask mirrors the LONG bid: 1 - 0.44 = 0.56.
		const response = await client.createOrder({
			marketSlug: "yes-alpha",
			intent: "ORDER_INTENT_BUY_SHORT",
			type: "ORDER_TYPE_LIMIT",
			price: { value: "0.56", currency: "USD" },
			quantity: 10,
			tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
		});
		const order = response.executions?.[0]?.order;
		expect(order?.state).toBe("ORDER_STATE_FILLED");
		expect(order?.avgPx?.value).toBe("0.56");
	});

	it("serves positions as a dict keyed by market slug, even when empty", async () => {
		const { client } = await boot();
		const positions = await client.positions();
		expect(Array.isArray(positions)).toBe(false);
		expect(Object.keys(positions)).toHaveLength(0);
	});
});

describe("market data over a real WebSocket", () => {
	/** Signs each upgrade the way the venue's SDK does: over `GET /v1/ws/markets`, fresh timestamp. */
	function signedFactory() {
		const privateKey = privateKeyFromSecret(SECRET);
		return rawWebSocketFactory({
			headersProvider: () => createAuthHeaders(KEY_ID, privateKey, "GET", "/v1/ws/markets", Date.now()),
		});
	}

	it("subscribes with a signed upgrade, receives snapshots and live pushes", async () => {
		const { fake, baseUrl } = await boot();
		const store = new BookStore();
		const updates: TopOfBook[] = [];
		const feed = new MarketDataFeed({
			wsBaseUrl: baseUrl.replace("http://", "ws://"),
			slugs: ["yes-alpha", "yes-beta"],
			staleTimeoutMs: 30_000,
			recycleAfterMs: 0,
			wsFactory: signedFactory(),
			onUpdate: (book) => {
				if (store.apply(book)) updates.push(book);
			},
		});
		feed.start();
		try {
			await waitFor("subscription snapshots", () => store.size === 2);
			expect(decToString(store.get("yes-alpha")?.ask ?? (0n as never))).toBe("0.47");

			fake.publish("yes-alpha", { bid: "0.45", bidQty: "90", ask: "0.48", askQty: "60" });
			await waitFor("live push", () => decToString(store.get("yes-alpha")?.bid ?? (0n as never)) === "0.45");
			expect(feed.stats().serverErrors).toBe(0);
			expect(feed.stats().parseErrors).toBe(0);
			expect(fake.wsUpgradesRejected).toBe(0);
		} finally {
			feed.stop();
		}
	});

	it("refuses an unsigned upgrade: market data is authenticated on this venue", async () => {
		const { fake, baseUrl } = await boot();
		const feed = new MarketDataFeed({
			wsBaseUrl: baseUrl.replace("http://", "ws://"),
			slugs: ["yes-alpha"],
			staleTimeoutMs: 30_000,
			recycleAfterMs: 0,
			// No headersProvider: the upgrade carries no signature, as the built-in WebSocket would.
			wsFactory: rawWebSocketFactory(),
			onUpdate: () => {},
		});
		feed.start();
		try {
			await waitFor("rejected upgrade", () => fake.wsUpgradesRejected >= 1);
			expect(feed.stats().messages).toBe(0);
		} finally {
			feed.stop();
		}
	});

	it("surfaces an unknown-slug subscription as a server error, loudly", async () => {
		const { baseUrl } = await boot();
		const feed = new MarketDataFeed({
			wsBaseUrl: baseUrl.replace("http://", "ws://"),
			slugs: ["no-such-market"],
			staleTimeoutMs: 30_000,
			recycleAfterMs: 0,
			wsFactory: signedFactory(),
			onUpdate: () => {},
		});
		feed.start();
		try {
			await waitFor("server error to be counted", () => feed.stats().serverErrors >= 1);
		} finally {
			feed.stop();
		}
	});
});

describe("order preview over a real socket", () => {
	it("round-trips the request envelope and reports commission basis points", async () => {
		const { fake, client } = await boot();
		const order = await client.previewOrder({
			marketSlug: "yes-alpha",
			intent: "ORDER_INTENT_BUY_LONG",
			type: "ORDER_TYPE_LIMIT",
			price: { value: "0.01", currency: "USD" },
			quantity: 5,
			tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
		});
		expect(order.commissionsBasisPoints).toBe("500");
		expect(order.makerCommissionsBasisPoints).toBe("-125");
		// Nothing was placed and nothing moved.
		expect(fake.previews).toBe(1);
		expect(fake.placements).toHaveLength(0);
		expect(decToString(fake.balanceOf())).toBe("100");
	});

	it("refuses a preview that fails the venue's static order checks", async () => {
		const { client } = await boot();
		await expect(
			client.previewOrder({
				marketSlug: "yes-alpha",
				intent: "ORDER_INTENT_BUY_LONG",
				type: "ORDER_TYPE_LIMIT",
				price: { value: "0.475", currency: "USD" },
				quantity: 5,
				tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
			}),
		).rejects.toMatchObject({ httpStatus: 400 });
	});

	it("refuses a preview whose intent is not a known enum value", async () => {
		const { client } = await boot();
		const error = await client
			.previewOrder({
				marketSlug: "yes-alpha",
				intent: "BUY_LONG" as never,
				type: "ORDER_TYPE_LIMIT",
				price: { value: "0.01", currency: "USD" },
				quantity: 5,
				tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
			})
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PolymarketApiError);
		expect((error as PolymarketApiError).message).toMatch(/ORDER_INTENT/);
	});
});

describe("WebSocket framing strictness", () => {
	it("fails the connection on an unmasked client frame, as RFC 6455 requires of servers", async () => {
		const { fake, baseUrl } = await boot();
		const target = new URL(baseUrl);
		const privateKey = privateKeyFromSecret(SECRET);

		// Hand-rolled handshake: the production client always masks, so proving the fake REFUSES
		// an unmasked frame needs a client that misbehaves on purpose.
		const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
			const request = http.request({
				host: target.hostname,
				port: Number(target.port),
				path: "/v1/ws/markets",
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
					"sec-websocket-version": "13",
					"sec-websocket-key": randomBytes(16).toString("base64"),
					...createAuthHeaders("test-key-1", privateKey, "GET", "/v1/ws/markets", Date.now()),
				},
			});
			request.on("upgrade", (_response, upgradedSocket) => resolve(upgradedSocket));
			request.on("response", () => reject(new Error("upgrade refused")));
			request.on("error", reject);
			request.end();
		});
		expect(fake.openConnections).toBe(1);

		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		const payload = Buffer.from(JSON.stringify({ subscribe: { requestId: "x" } }), "utf8");
		// FIN + text opcode, mask bit CLEAR: a frame no compliant client sends.
		socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));

		await closed;
		expect(fake.unmaskedFrames).toBe(1);
		expect(fake.openConnections).toBe(0);
	});
});
