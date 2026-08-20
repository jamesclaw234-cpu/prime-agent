import { afterEach, describe, expect, it } from "vitest";
import { BookStore, type TopOfBook } from "../src/core/book.js";
import { decToString } from "../src/util/decimal.js";
import { privateKeyFromSecret, rawPublicKey } from "../src/venue/auth.js";
import { MarketDataFeed } from "../src/venue/feed.js";
import { PolymarketApiError, PolymarketRestClient } from "../src/venue/rest-client.js";
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

	it("places a marketable IOC BUY_LONG and the fake's balance moves", async () => {
		const { fake, client } = await boot();
		const order = await client.createOrder({
			marketSlug: "yes-alpha",
			intent: "ORDER_INTENT_BUY_LONG",
			type: "ORDER_TYPE_LIMIT",
			price: { value: "0.47", currency: "USD" },
			quantity: 10,
			tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
		});
		expect(order.state).toBe("ORDER_STATE_FILLED");
		expect(order.cumQuantity).toBe(10);
		// 10 shares at the 0.47 ask.
		expect(decToString(fake.balanceOf())).toBe("95.3");
	});

	it("refuses what the venue refuses: off-tick, out-of-range, sub-minimum, unfunded", async () => {
		const { client } = await boot("2");
		const base = {
			marketSlug: "yes-alpha",
			intent: "ORDER_INTENT_BUY_LONG" as const,
			type: "ORDER_TYPE_LIMIT" as const,
			tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL" as const,
		};
		const cases = [
			{ ...base, price: { value: "0.475", currency: "USD" as const }, quantity: 10 },
			{ ...base, price: { value: "1.00", currency: "USD" as const }, quantity: 10 },
			{ ...base, price: { value: "0.47", currency: "USD" as const }, quantity: 4 },
			{ ...base, price: { value: "0.47", currency: "USD" as const }, quantity: 10 },
		];
		for (const params of cases) {
			const error = await client.createOrder(params).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(PolymarketApiError);
			expect((error as PolymarketApiError).httpStatus).toBe(400);
		}
	});

	it("fills BUY_SHORT against the mirrored side of the unified book", async () => {
		const { client } = await boot();
		// SHORT ask mirrors the LONG bid: 1 - 0.44 = 0.56.
		const order = await client.createOrder({
			marketSlug: "yes-alpha",
			intent: "ORDER_INTENT_BUY_SHORT",
			type: "ORDER_TYPE_LIMIT",
			price: { value: "0.56", currency: "USD" },
			quantity: 10,
			tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
		});
		expect(order.state).toBe("ORDER_STATE_FILLED");
		expect(order.avgPx?.value).toBe("0.56");
	});
});

describe("market data over a real WebSocket", () => {
	it("subscribes, receives snapshots and live pushes, and applies them to the store", async () => {
		const { fake, baseUrl } = await boot();
		const store = new BookStore();
		const updates: TopOfBook[] = [];
		const feed = new MarketDataFeed({
			wsBaseUrl: baseUrl.replace("http://", "ws://"),
			slugs: ["yes-alpha", "yes-beta"],
			staleTimeoutMs: 30_000,
			recycleAfterMs: 0,
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
