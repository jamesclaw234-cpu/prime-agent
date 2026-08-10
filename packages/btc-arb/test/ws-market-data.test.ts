import { describe, expect, it } from "vitest";
import { MarketDataFeed, type WsConnection, type WsHandlers } from "../src/binance/ws-market-data.js";
import type { TopOfBook } from "../src/types.js";

/** A socket the test drives by hand: nothing happens until the test says so. */
class FakeSocket implements WsConnection {
	closed = false;
	readonly sent: string[] = [];

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

	open(): void {
		this.handlers.onOpen();
	}

	message(payload: unknown): void {
		this.handlers.onMessage(typeof payload === "string" ? payload : JSON.stringify(payload));
	}

	drop(code = 1006, reason = "abnormal"): void {
		this.handlers.onClose(code, reason);
	}
}

interface Harness {
	readonly feed: MarketDataFeed;
	readonly sockets: FakeSocket[];
	readonly updates: TopOfBook[];
	readonly timers: { fn: () => void; delay: number; id: number }[];
	runTimers(): void;
	setNow(value: number): void;
}

function harness(symbols: string[], options: { streamsPerConnection?: number; staleTimeoutMs?: number } = {}): Harness {
	const sockets: FakeSocket[] = [];
	const updates: TopOfBook[] = [];
	const timers: { fn: () => void; delay: number; id: number }[] = [];
	let now = 1_000_000;
	let nextId = 1;

	const setTimeoutFn = ((fn: () => void, delay: number) => {
		const id = nextId++;
		timers.push({ fn, delay, id });
		return { id, unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;

	const clearTimeoutFn = ((handle: { id: number }) => {
		const index = timers.findIndex((timer) => timer.id === handle?.id);
		if (index >= 0) timers.splice(index, 1);
	}) as unknown as typeof clearTimeout;

	const feed = new MarketDataFeed({
		wsBaseUrl: "wss://stream.example.test:9443",
		symbols,
		streamsPerConnection: options.streamsPerConnection ?? 2,
		staleTimeoutMs: options.staleTimeoutMs ?? 30_000,
		recycleAfterMs: 0,
		// Pin jitter to its midpoint so the delay sequence is exactly the base progression.
		backoff: { initialMs: 500, maxMs: 30_000, factor: 2, jitter: 0.5, random: () => 0.5 },
		onUpdate: (book) => updates.push(book),
		now: () => now,
		setTimeoutFn,
		clearTimeoutFn,
		wsFactory: (url, handlers) => {
			const socket = new FakeSocket(url, handlers);
			sockets.push(socket);
			return socket;
		},
	});

	return {
		feed,
		sockets,
		updates,
		timers,
		runTimers: () => {
			const pending = [...timers];
			timers.length = 0;
			for (const timer of pending) timer.fn();
		},
		setNow: (value: number) => {
			now = value;
		},
	};
}

const FRAME = { u: 400900217, s: "BTCUSDT", b: "99.00", B: "31.21", a: "100.00", A: "40.66" };

describe("subscriptions", () => {
	it("shards markets across connections and builds combined stream URLs", () => {
		const h = harness(["BTCUSDT", "ETHUSDT", "ETHBTC", "BNBUSDT", "BNBBTC"], { streamsPerConnection: 2 });
		h.feed.start();
		expect(h.feed.shardCount).toBe(3);
		expect(h.sockets).toHaveLength(3);
		expect(h.sockets[0].url).toBe(
			"wss://stream.example.test:9443/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker",
		);
		expect(h.sockets[2].url).toBe("wss://stream.example.test:9443/stream?streams=bnbbtc@bookTicker");
	});

	it("lowercases stream names, which Binance requires", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		expect(h.sockets[0].url).toContain("btcusdt@bookTicker");
	});
});

describe("message handling", () => {
	it("unwraps the combined-stream envelope", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		h.sockets[0].open();
		h.sockets[0].message({ stream: "btcusdt@bookTicker", data: FRAME });
		expect(h.updates).toHaveLength(1);
		expect(h.updates[0].symbol).toBe("BTCUSDT");
		expect(h.updates[0].updateId).toBe(400900217);
	});

	it("accepts a raw frame with no envelope", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		h.sockets[0].open();
		h.sockets[0].message(FRAME);
		expect(h.updates).toHaveLength(1);
	});

	it("ignores SUBSCRIBE acknowledgements without counting them as parse errors", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		h.sockets[0].open();
		h.sockets[0].message({ result: null, id: 1 });
		expect(h.updates).toHaveLength(0);
		expect(h.feed.stats().parseErrors).toBe(0);
	});

	it("counts malformed payloads without throwing", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		h.sockets[0].open();
		h.sockets[0].message("not json");
		h.sockets[0].message({ stream: "x", data: { nonsense: true } });
		expect(h.feed.stats().parseErrors).toBe(2);
		expect(h.updates).toHaveLength(0);
	});

	it("drops a crossed book rather than passing it to the detector", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		h.sockets[0].open();
		h.sockets[0].message({ ...FRAME, b: "101.00", a: "100.00" });
		expect(h.updates).toHaveLength(0);
		expect(h.feed.stats().parseErrors).toBe(0);
	});

	it("ignores messages that arrive on a socket already replaced", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		const original = h.sockets[0];
		original.open();
		original.drop();
		h.runTimers();
		expect(h.sockets).toHaveLength(2);
		original.message(FRAME);
		expect(h.updates).toHaveLength(0);
	});
});

describe("reconnection", () => {
	it("schedules a reconnect after a close and backs off exponentially", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		h.sockets[0].open();
		h.sockets[0].drop();
		expect(h.timers).toHaveLength(1);
		expect(h.timers[0].delay).toBe(500);
		h.runTimers();
		expect(h.sockets).toHaveLength(2);

		// The replacement never opened, so the failure streak continues.
		h.sockets[1].drop();
		expect(h.timers[0].delay).toBe(1000);
		h.runTimers();
		h.sockets[2].drop();
		expect(h.timers[0].delay).toBe(2000);
		expect(h.feed.stats().reconnects).toBe(3);
	});

	it("resets backoff after a successful open", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		h.sockets[0].open();
		h.sockets[0].drop();
		h.runTimers();
		expect(h.timers).toHaveLength(0);
		h.sockets[1].open();
		h.sockets[1].drop();
		// A healthy connection in between means the delay starts over from the base.
		expect(h.timers[0].delay).toBe(500);
	});

	it("forces a reconnect when a shard goes silent", () => {
		const h = harness(["BTCUSDT"], { staleTimeoutMs: 10_000 });
		h.feed.start();
		h.sockets[0].open();
		expect(h.feed.healthy).toBe(true);

		h.setNow(1_000_000 + 60_000);
		h.runTimers();
		expect(h.sockets[0].closed).toBe(true);
		expect(h.sockets).toHaveLength(2);
	});

	it("keeps a quiet but live shard when it is still inside the stale window", () => {
		const h = harness(["BTCUSDT"], { staleTimeoutMs: 30_000 });
		h.feed.start();
		h.sockets[0].open();
		h.setNow(1_000_000 + 5_000);
		h.runTimers();
		expect(h.sockets).toHaveLength(1);
		expect(h.sockets[0].closed).toBe(false);
	});

	it("reports unhealthy while a shard is down", () => {
		const h = harness(["BTCUSDT", "ETHUSDT", "ETHBTC"], { streamsPerConnection: 1 });
		h.feed.start();
		for (const socket of h.sockets) socket.open();
		expect(h.feed.healthy).toBe(true);
		h.sockets[1].drop();
		expect(h.feed.healthy).toBe(false);
		expect(h.feed.stats().openShards).toBe(2);
	});

	it("stops cleanly and does not reconnect afterwards", () => {
		const h = harness(["BTCUSDT"]);
		h.feed.start();
		h.sockets[0].open();
		h.feed.stop();
		expect(h.sockets[0].closed).toBe(true);
		h.sockets[0].drop();
		h.runTimers();
		expect(h.sockets).toHaveLength(1);
	});
});
