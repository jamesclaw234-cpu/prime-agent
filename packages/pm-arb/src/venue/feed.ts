import { bookFromWire, type MarketSlug, type TopOfBook } from "../core/book.js";
import { Backoff, type BackoffOptions, DEFAULT_BACKOFF } from "../util/backoff.js";
import { type Logger, silentLogger } from "../util/logger.js";
import type { MarketBook } from "./types.js";
import { rawWebSocketFactory } from "./ws-client.js";

/** Minimal WebSocket surface so the feed can be driven by a fake in tests. */
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

/** Documented cap: one market-data connection carries at most this many instruments. */
export const MAX_SLUGS_PER_CONNECTION = 10;

export interface MarketDataFeedOptions {
	readonly wsBaseUrl: string;
	readonly slugs: readonly MarketSlug[];
	/** Clamped to the venue's documented 10-instrument cap. */
	readonly slugsPerConnection?: number;
	/**
	 * Reconnect a shard silent for this long. Unlike the Binance feed, this venue sends explicit
	 * heartbeat messages, so silence really does mean a dead connection rather than a quiet market
	 * - the window can be tight without churning on illiquid books.
	 */
	readonly staleTimeoutMs: number;
	/** Proactively cycle each connection at this age; zero disables. */
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
	readonly slugs: readonly MarketSlug[];
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
	readonly serverErrors: number;
	readonly oldestMessageAgeMs: number;
}

interface WireMessage {
	readonly requestId?: string;
	readonly subscriptionType?: string;
	readonly marketData?: MarketBook;
	readonly heartbeat?: Record<string, unknown>;
	readonly error?: string;
}

/**
 * Live order-book feed over `/v1/ws/markets`.
 *
 * Subscriptions travel as JSON messages after the socket opens - not in the URL as on Binance -
 * and the venue caps each connection at ten instruments, so markets are sharded across
 * connections exactly the way btc-arb shards its streams, each with independent jittered
 * reconnect and a liveness watchdog.
 */
export class MarketDataFeed {
	private readonly shards: Shard[] = [];
	private readonly logger: Logger;
	private readonly wsFactory: WsFactory;
	private readonly now: () => number;
	private readonly setTimeoutFn: typeof setTimeout;
	private readonly clearTimeoutFn: typeof clearTimeout;
	private parseErrors = 0;
	private serverErrors = 0;
	private subscriptionCounter = 0;
	private running = false;

	constructor(private readonly options: MarketDataFeedOptions) {
		this.logger = options.logger ?? silentLogger();
		// The default is the hand-rolled client, never Node's built-in WebSocket: the venue signs
		// the upgrade request itself, and the browser-API WebSocket cannot carry those headers.
		this.wsFactory = options.wsFactory ?? rawWebSocketFactory();
		this.now = options.now ?? Date.now;
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

		const perShard = Math.min(
			MAX_SLUGS_PER_CONNECTION,
			Math.max(1, options.slugsPerConnection ?? MAX_SLUGS_PER_CONNECTION),
		);
		for (let index = 0; index * perShard < options.slugs.length; index++) {
			this.shards.push({
				index,
				slugs: options.slugs.slice(index * perShard, (index + 1) * perShard),
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

	get healthy(): boolean {
		if (this.shards.length === 0) return false;
		const now = this.now();
		return this.shards.every(
			(shard) => shard.state === "open" && now - shard.lastMessageAt < this.options.staleTimeoutMs,
		);
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
				// Already gone is the state we wanted.
			}
			shard.connection = undefined;
		}
	}

	stats(): FeedStats {
		const now = this.now();
		let messages = 0;
		let reconnects = 0;
		let open = 0;
		let oldest = 0;
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
			serverErrors: this.serverErrors,
			oldestMessageAgeMs: oldest,
		};
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
		const url = `${this.options.wsBaseUrl.replace(/\/+$/, "")}/v1/ws/markets`;
		const isCurrent = (): boolean => this.running && shard.generation === generation;

		try {
			shard.connection = this.wsFactory(url, {
				onOpen: () => {
					if (!isCurrent()) return;
					shard.state = "open";
					shard.connectedAt = this.now();
					shard.lastMessageAt = this.now();
					shard.backoff.reset();
					// Subscription is a message, not a URL. One request per shard; the requestId ties
					// error replies back to what was asked.
					const requestId = `md-${shard.index}-${++this.subscriptionCounter}`;
					shard.connection?.send(
						JSON.stringify({
							subscribe: {
								requestId,
								subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA",
								marketSlugs: [...shard.slugs],
							},
						}),
					);
					this.armWatchdog(shard, generation);
					this.logger.info("ws open", { shard: shard.index, slugs: shard.slugs.length });
				},
				onMessage: (data) => {
					if (!isCurrent()) return;
					shard.lastMessageAt = this.now();
					shard.messages++;
					this.handleMessage(data, shard.index);
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

	private handleMessage(data: string, shardIndex: number): void {
		let message: WireMessage;
		try {
			message = JSON.parse(data) as WireMessage;
		} catch {
			this.parseErrors++;
			return;
		}
		// Heartbeats refresh liveness (already done by the caller) and carry nothing else.
		if (message.heartbeat) return;
		if (message.error) {
			// A subscription-level refusal. The books simply never arrive if this is ignored, so it
			// is counted and logged loudly rather than filed under parse errors.
			this.serverErrors++;
			this.logger.error("ws server error", { shard: shardIndex, error: message.error });
			return;
		}
		const raw = message.marketData;
		if (!raw) return;
		const book = bookFromWire(raw, this.now());
		if (!book) return;
		this.options.onUpdate(book);
	}

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
		shard.state = "connecting";
		shard.reconnects++;
		this.clearTimers(shard);
		const delay = shard.backoff.next();
		shard.retryTimer = this.setTimeoutFn(() => this.connect(shard), delay);
		shard.retryTimer.unref?.();
		this.logger.info("ws reconnect scheduled", { shard: shard.index, delayMs: delay });
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
