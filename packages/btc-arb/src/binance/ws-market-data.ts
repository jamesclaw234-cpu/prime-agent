import { bookFromStream } from "../core/book.js";
import type { MarketSymbol, TopOfBook } from "../types.js";
import { Backoff, type BackoffOptions, DEFAULT_BACKOFF } from "../util/backoff.js";
import { type Logger, silentLogger } from "../util/logger.js";
import type { RawBookTickerStream, RawCombinedStreamMessage } from "./types.js";

/**
 * Minimal WebSocket surface, so the feed can be driven by a fake in tests.
 *
 * Wrapping rather than exposing the platform `WebSocket` keeps the reconnect state machine free of
 * DOM event plumbing and makes every transition directly observable.
 */
export interface WsConnection {
	send(data: string): void;
	close(): void;
}

export interface WsHandlers {
	onOpen(): void;
	onMessage(data: string): void;
	onClose(code: number, reason: string): void;
	onError(error: unknown): void;
}

export type WsFactory = (url: string, handlers: WsHandlers) => WsConnection;

/** Adapter over Node's built-in WebSocket. */
export const nodeWebSocketFactory: WsFactory = (url, handlers) => {
	const socket = new WebSocket(url);
	socket.addEventListener("open", () => handlers.onOpen());
	socket.addEventListener("message", (event) => {
		const data: unknown = event.data;
		handlers.onMessage(typeof data === "string" ? data : String(data));
	});
	socket.addEventListener("close", (event) => handlers.onClose(event.code, event.reason));
	socket.addEventListener("error", (event) => handlers.onError(event));
	return {
		send: (data: string) => socket.send(data),
		close: () => socket.close(),
	};
};

export interface MarketDataFeedOptions {
	readonly wsBaseUrl: string;
	readonly symbols: readonly MarketSymbol[];
	readonly streamsPerConnection: number;
	/**
	 * Reconnect a shard that has produced no message for this long.
	 *
	 * Node's WebSocket answers server pings transparently and exposes no pong event, so a dead
	 * connection is only detectable by absence of data. Shards mix liquid and illiquid markets, so
	 * this must be generous enough not to churn on genuinely quiet books.
	 */
	readonly staleTimeoutMs: number;
	/**
	 * Proactively cycle each connection at this age.
	 *
	 * Binance force-closes a market stream after 24 hours. Reconnecting early, on our own schedule
	 * and staggered per shard, means the drop never lands in the middle of a live cycle.
	 */
	readonly recycleAfterMs: number;
	readonly onUpdate: (book: TopOfBook) => void;
	readonly logger?: Logger;
	readonly backoff?: BackoffOptions;
	readonly wsFactory?: WsFactory;
	readonly now?: () => number;
	readonly setTimeoutFn?: typeof setTimeout;
	readonly clearTimeoutFn?: typeof clearTimeout;
}

interface Shard {
	readonly index: number;
	readonly symbols: readonly MarketSymbol[];
	connection?: WsConnection;
	backoff: Backoff;
	connectedAt: number;
	lastMessageAt: number;
	messages: number;
	reconnects: number;
	state: "idle" | "connecting" | "open" | "closed";
	watchdog?: ReturnType<typeof setTimeout>;
	retryTimer?: ReturnType<typeof setTimeout>;
	/** Guards against a stale socket's callbacks mutating shard state after replacement. */
	generation: number;
}

export interface FeedStats {
	readonly shards: number;
	readonly openShards: number;
	readonly messages: number;
	readonly reconnects: number;
	readonly parseErrors: number;
	readonly oldestMessageAgeMs: number;
}

/**
 * Live top-of-book feed over Binance's combined `@bookTicker` streams.
 *
 * Markets are split across several connections rather than one: a single socket carrying every
 * stream is a single point of failure whose reconnect blinds the whole bot, and Binance caps
 * streams per connection anyway. Each shard reconnects independently with jittered backoff.
 */
export class MarketDataFeed {
	private readonly shards: Shard[] = [];
	private readonly logger: Logger;
	private readonly wsFactory: WsFactory;
	private readonly now: () => number;
	private readonly setTimeoutFn: typeof setTimeout;
	private readonly clearTimeoutFn: typeof clearTimeout;
	private parseErrors = 0;
	private running = false;

	constructor(private readonly options: MarketDataFeedOptions) {
		this.logger = options.logger ?? silentLogger();
		this.wsFactory = options.wsFactory ?? nodeWebSocketFactory;
		this.now = options.now ?? Date.now;
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

		const perShard = Math.max(1, options.streamsPerConnection);
		for (let index = 0; index * perShard < options.symbols.length; index++) {
			this.shards.push({
				index,
				symbols: options.symbols.slice(index * perShard, (index + 1) * perShard),
				backoff: new Backoff(options.backoff ?? DEFAULT_BACKOFF),
				connectedAt: 0,
				lastMessageAt: 0,
				messages: 0,
				reconnects: 0,
				state: "idle",
				generation: 0,
			});
		}
	}

	get shardCount(): number {
		return this.shards.length;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		for (const shard of this.shards) this.connect(shard);
	}

	stop(): void {
		this.running = false;
		for (const shard of this.shards) {
			shard.generation++;
			this.clearTimers(shard);
			shard.state = "closed";
			try {
				shard.connection?.close();
			} catch {
				// A socket that is already gone is exactly the state we wanted.
			}
			shard.connection = undefined;
		}
	}

	private streamUrl(shard: Shard): string {
		const streams = shard.symbols.map((symbol) => `${symbol.toLowerCase()}@bookTicker`).join("/");
		return `${this.options.wsBaseUrl.replace(/\/+$/, "")}/stream?streams=${streams}`;
	}

	private clearTimers(shard: Shard): void {
		if (shard.watchdog) this.clearTimeoutFn(shard.watchdog);
		if (shard.retryTimer) this.clearTimeoutFn(shard.retryTimer);
		shard.watchdog = undefined;
		shard.retryTimer = undefined;
	}

	private connect(shard: Shard): void {
		if (!this.running) return;
		this.clearTimers(shard);
		shard.state = "connecting";
		const generation = ++shard.generation;
		const url = this.streamUrl(shard);
		this.logger.debug("ws connecting", { shard: shard.index, streams: shard.symbols.length });

		const isCurrent = (): boolean => this.running && shard.generation === generation;

		try {
			shard.connection = this.wsFactory(url, {
				onOpen: () => {
					if (!isCurrent()) return;
					shard.state = "open";
					shard.connectedAt = this.now();
					shard.lastMessageAt = this.now();
					shard.backoff.reset();
					this.armWatchdog(shard, generation);
					this.logger.info("ws open", { shard: shard.index, streams: shard.symbols.length });
				},
				onMessage: (data) => {
					if (!isCurrent()) return;
					shard.lastMessageAt = this.now();
					shard.messages++;
					this.handleMessage(data);
				},
				onClose: (code, reason) => {
					if (!isCurrent()) return;
					this.logger.warn("ws closed", { shard: shard.index, code, reason });
					this.scheduleReconnect(shard);
				},
				onError: (error) => {
					if (!isCurrent()) return;
					this.logger.warn("ws error", { shard: shard.index, error: describeError(error) });
					// `close` always follows `error` on a real socket; reconnect is scheduled there.
				},
			});
		} catch (error) {
			this.logger.warn("ws connect threw", { shard: shard.index, error: describeError(error) });
			this.scheduleReconnect(shard);
		}
	}

	/**
	 * Re-arms the liveness watchdog.
	 *
	 * The timer doubles as the proactive recycle trigger, so a long-lived healthy connection is
	 * still replaced before the exchange drops it out from under an in-flight cycle.
	 */
	private armWatchdog(shard: Shard, generation: number): void {
		if (shard.watchdog) this.clearTimeoutFn(shard.watchdog);
		const check = (): void => {
			if (!this.running || shard.generation !== generation) return;
			const now = this.now();
			const silentFor = now - shard.lastMessageAt;
			const age = now - shard.connectedAt;
			if (silentFor >= this.options.staleTimeoutMs) {
				this.logger.warn("ws stale, forcing reconnect", { shard: shard.index, silentForMs: silentFor });
				this.forceReconnect(shard);
				return;
			}
			if (this.options.recycleAfterMs > 0 && age >= this.options.recycleAfterMs) {
				this.logger.info("ws recycling connection", { shard: shard.index, ageMs: age });
				this.forceReconnect(shard);
				return;
			}
			shard.watchdog = this.setTimeoutFn(check, Math.max(250, Math.floor(this.options.staleTimeoutMs / 2)));
			shard.watchdog.unref?.();
		};
		shard.watchdog = this.setTimeoutFn(check, Math.max(250, Math.floor(this.options.staleTimeoutMs / 2)));
		shard.watchdog.unref?.();
	}

	private forceReconnect(shard: Shard): void {
		const connection = shard.connection;
		shard.generation++;
		shard.connection = undefined;
		this.clearTimers(shard);
		try {
			connection?.close();
		} catch {
			// Already closed.
		}
		shard.reconnects++;
		this.connect(shard);
	}

	private scheduleReconnect(shard: Shard): void {
		if (!this.running) return;
		shard.state = "closed";
		shard.generation++;
		shard.connection = undefined;
		this.clearTimers(shard);
		shard.reconnects++;
		const delay = shard.backoff.next();
		this.logger.info("ws reconnect scheduled", {
			shard: shard.index,
			delayMs: delay,
			attempt: shard.backoff.attempts,
		});
		shard.retryTimer = this.setTimeoutFn(() => this.connect(shard), delay);
		shard.retryTimer.unref?.();
	}

	private handleMessage(data: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			this.parseErrors++;
			return;
		}
		if (!parsed || typeof parsed !== "object") {
			this.parseErrors++;
			return;
		}

		// Combined streams wrap payloads; control-message replies to SUBSCRIBE carry `result`/`id`.
		const envelope = parsed as Partial<RawCombinedStreamMessage<RawBookTickerStream>> & { id?: number };
		const payload = envelope.data ?? (parsed as RawBookTickerStream);
		if (!payload || typeof payload !== "object") {
			if (envelope.id === undefined) this.parseErrors++;
			return;
		}
		if (typeof payload.s !== "string" || typeof payload.b !== "string" || typeof payload.a !== "string") {
			if (envelope.id === undefined) this.parseErrors++;
			return;
		}

		let book: TopOfBook | undefined;
		try {
			book = bookFromStream(payload, this.now());
		} catch {
			this.parseErrors++;
			return;
		}
		if (!book) return;
		this.options.onUpdate(book);
	}

	stats(): FeedStats {
		let messages = 0;
		let reconnects = 0;
		let open = 0;
		let oldest = 0;
		const now = this.now();
		for (const shard of this.shards) {
			messages += shard.messages;
			reconnects += shard.reconnects;
			if (shard.state === "open") open++;
			if (shard.lastMessageAt > 0) oldest = Math.max(oldest, now - shard.lastMessageAt);
		}
		return {
			shards: this.shards.length,
			openShards: open,
			messages,
			reconnects,
			parseErrors: this.parseErrors,
			oldestMessageAgeMs: oldest,
		};
	}

	/** True when every shard is open and producing data. */
	get healthy(): boolean {
		if (this.shards.length === 0) return false;
		const now = this.now();
		return this.shards.every(
			(shard) => shard.state === "open" && now - shard.lastMessageAt < this.options.staleTimeoutMs,
		);
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && "message" in error) {
		return String((error as { message: unknown }).message);
	}
	return String(error);
}
