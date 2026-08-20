import { describe, expect, it } from "vitest";
import type { TopOfBook } from "../src/core/book.js";
import { BookStore, bookFromWire } from "../src/core/book.js";
import { decToString } from "../src/util/decimal.js";
import { MarketDataFeed, type WsConnection, type WsHandlers } from "../src/venue/feed.js";

class FakeSocket implements WsConnection {
	sent: string[] = [];
	closed = false;
	constructor(
		readonly url: string,
		readonly handlers: WsHandlers,
	) {}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
	}
}

function bookMessage(slug: string, bid: string, ask: string, transactTime?: string): string {
	return JSON.stringify({
		requestId: "md-0-1",
		subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA",
		marketData: {
			marketSlug: slug,
			bids: [{ px: { value: bid, currency: "USD" }, qty: "120" }],
			offers: [{ px: { value: ask, currency: "USD" }, qty: "80" }],
			state: "MARKET_STATE_OPEN",
			...(transactTime ? { transactTime } : {}),
		},
	});
}

function harness(slugs: string[], staleTimeoutMs = 30_000) {
	const sockets: FakeSocket[] = [];
	const updates: TopOfBook[] = [];
	let clock = 1_000_000;
	const feed = new MarketDataFeed({
		wsBaseUrl: "wss://api.polymarket.us",
		slugs,
		staleTimeoutMs,
		recycleAfterMs: 0,
		now: () => clock,
		onUpdate: (book) => updates.push(book),
		wsFactory: (url, handlers) => {
			const socket = new FakeSocket(url, handlers);
			sockets.push(socket);
			return socket;
		},
	});
	const tick = (ms: number): void => {
		clock += ms;
	};
	return { feed, sockets, updates, tick };
}

describe("sharding", () => {
	it("splits markets across connections at the venue's 10-instrument cap", () => {
		const slugs = Array.from({ length: 23 }, (_, i) => `m-${i}`);
		const { feed, sockets } = harness(slugs);
		feed.start();
		expect(feed.shardCount).toBe(3);
		expect(sockets).toHaveLength(3);
		for (const socket of sockets) expect(socket.url).toContain("/v1/ws/markets");
		feed.stop();
	});

	it("clamps a configured shard size above the cap back down to it", () => {
		const slugs = Array.from({ length: 12 }, (_, i) => `m-${i}`);
		const feed = new MarketDataFeed({
			wsBaseUrl: "wss://x",
			slugs,
			slugsPerConnection: 64,
			staleTimeoutMs: 30_000,
			recycleAfterMs: 0,
			onUpdate: () => {},
			wsFactory: (url, handlers) => new FakeSocket(url, handlers),
		});
		// 12 slugs at a true cap of 10 is two shards; honouring 64 would be one over-full one.
		expect(feed.shardCount).toBe(2);
	});
});

describe("subscription protocol", () => {
	it("subscribes by message after open, with exactly this shard's slugs", () => {
		const { feed, sockets } = harness(["alpha", "beta"]);
		feed.start();
		sockets[0].handlers.onOpen();
		expect(sockets[0].sent).toHaveLength(1);
		const message = JSON.parse(sockets[0].sent[0]);
		expect(message.subscribe.subscriptionType).toBe("SUBSCRIPTION_TYPE_MARKET_DATA");
		expect(message.subscribe.marketSlugs).toEqual(["alpha", "beta"]);
		expect(message.subscribe.requestId).toBeTruthy();
		feed.stop();
	});

	it("counts a server error reply loudly instead of filing it as a parse error", () => {
		const { feed, sockets } = harness(["alpha"]);
		feed.start();
		sockets[0].handlers.onOpen();
		sockets[0].handlers.onMessage(JSON.stringify({ requestId: "md-0-1", error: "unknown market" }));
		expect(feed.stats().serverErrors).toBe(1);
		expect(feed.stats().parseErrors).toBe(0);
		feed.stop();
	});
});

describe("book flow", () => {
	it("converts MARKET_DATA payloads to exact-decimal books", () => {
		const { feed, sockets, updates } = harness(["alpha"]);
		feed.start();
		sockets[0].handlers.onOpen();
		sockets[0].handlers.onMessage(bookMessage("alpha", "0.44", "0.47"));
		expect(updates).toHaveLength(1);
		expect(decToString(updates[0].bid)).toBe("0.44");
		expect(decToString(updates[0].ask)).toBe("0.47");
		feed.stop();
	});

	it("drops crossed and one-sided books rather than pricing on them", () => {
		const { feed, sockets, updates } = harness(["alpha"]);
		feed.start();
		sockets[0].handlers.onOpen();
		sockets[0].handlers.onMessage(bookMessage("alpha", "0.50", "0.48"));
		sockets[0].handlers.onMessage(JSON.stringify({ marketData: { marketSlug: "alpha", bids: [], offers: [] } }));
		expect(updates).toHaveLength(0);
		feed.stop();
	});

	it("treats heartbeats as liveness, not data", () => {
		const { feed, sockets, updates, tick } = harness(["alpha"], 1000);
		feed.start();
		sockets[0].handlers.onOpen();
		tick(900);
		sockets[0].handlers.onMessage(JSON.stringify({ heartbeat: {} }));
		expect(updates).toHaveLength(0);
		expect(feed.healthy).toBe(true);
		feed.stop();
	});
});

describe("book store ordering", () => {
	it("rejects a transact-time regression after a reconnect race", () => {
		let now = 5_000;
		const store = new BookStore(() => now);
		const newer = bookFromWire(
			JSON.parse(bookMessage("alpha", "0.44", "0.47", "2026-08-20T00:00:10Z")).marketData,
			now,
		);
		now = 5_100;
		const older = bookFromWire(
			JSON.parse(bookMessage("alpha", "0.40", "0.43", "2026-08-20T00:00:05Z")).marketData,
			now,
		);
		expect(store.apply(newer as TopOfBook)).toBe(true);
		expect(store.apply(older as TopOfBook)).toBe(false);
		expect(decToString(store.get("alpha")?.bid ?? (0n as never))).toBe("0.44");
	});
});
