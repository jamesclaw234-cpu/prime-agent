import { createHmac, timingSafeEqual } from "node:crypto";
import type { MarketSymbol, OrderSide, OrderType, TimeInForce } from "../types.js";
import { ServerClock } from "../util/clock.js";
import { type Logger, silentLogger } from "../util/logger.js";
import { ORDERS, ORDERS_DAY, RAW_REQUESTS, type RateLimiter, WEIGHT } from "./rate-limiter.js";
import {
	BINANCE_ERROR,
	type BinanceErrorPayload,
	type RawAccountInfo,
	type RawBookTickerRest,
	type RawExchangeInfo,
	type RawOrderResponse,
	type RawServerTime,
} from "./types.js";

/**
 * Documented request weights for the endpoints this bot uses.
 *
 * Kept in one place so a change in Binance's published table is a one-line edit rather than a hunt
 * through call sites. `exchangeInfo` overwrites the *limits* at startup but not these costs.
 */
export const ENDPOINT_WEIGHT = {
	ping: 1,
	time: 1,
	exchangeInfo: 20,
	bookTickerAll: 4,
	bookTickerOne: 2,
	account: 20,
	newOrder: 1,
	cancelOrder: 1,
	queryOrder: 4,
	myTrades: 20,
	openOrders: 6,
} as const;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RestClientOptions {
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly apiSecret?: string;
	readonly recvWindowMs: number;
	readonly timeoutMs: number;
	readonly limiter: RateLimiter;
	readonly clock?: ServerClock;
	readonly logger?: Logger;
	readonly fetchImpl?: FetchLike;
	readonly now?: () => number;
}

/** An error returned by Binance with its documented `code`/`msg` envelope. */
export class BinanceApiError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly httpStatus: number,
		readonly endpoint: string,
		readonly retryAfterMs = 0,
	) {
		super(`${endpoint} failed: ${message} (code ${code}, HTTP ${httpStatus})`);
		this.name = "BinanceApiError";
	}

	/** True when the same request may succeed later without changing its parameters. */
	get retryable(): boolean {
		return (
			this.httpStatus === 429 ||
			this.httpStatus === 418 ||
			this.httpStatus >= 500 ||
			this.code === BINANCE_ERROR.TOO_MANY_REQUESTS ||
			this.code === BINANCE_ERROR.DISCONNECTED ||
			this.code === BINANCE_ERROR.TIMEOUT ||
			this.code === BINANCE_ERROR.UNKNOWN
		);
	}

	/**
	 * True when the request may have reached the matching engine despite the error.
	 *
	 * A timeout, a 5xx or a -1000 on an order placement is the dangerous case: the order might be
	 * live. Callers must reconcile by client order id rather than retrying, because a blind retry
	 * on an order that did execute doubles the position.
	 */
	get ambiguous(): boolean {
		return (
			this.code === BINANCE_ERROR.UNKNOWN ||
			this.code === BINANCE_ERROR.TIMEOUT ||
			this.httpStatus >= 500 ||
			this.httpStatus === 0
		);
	}
}

export class MissingCredentialsError extends Error {
	constructor(endpoint: string) {
		super(`${endpoint} requires an API key and secret`);
		this.name = "MissingCredentialsError";
	}
}

export interface NewOrderParams {
	readonly symbol: MarketSymbol;
	readonly side: OrderSide;
	readonly type: OrderType;
	readonly timeInForce?: TimeInForce;
	/** Base-asset quantity, already formatted to the symbol's lot precision. */
	readonly quantity?: string;
	/** Quote-asset amount for MARKET orders that spend a known notional. */
	readonly quoteOrderQty?: string;
	/** Limit price, already formatted to the symbol's tick precision. */
	readonly price?: string;
	readonly newClientOrderId?: string;
	readonly newOrderRespType?: "ACK" | "RESULT" | "FULL";
	readonly selfTradePreventionMode?: string;
}

type QueryValue = string | number | boolean | undefined;

/**
 * Signed client for the Binance Spot REST API.
 *
 * All parameters travel in the query string, including for POST. Binance signs the concatenation
 * of query string and body, so keeping the body empty removes an entire class of signature bug.
 */
export class BinanceRestClient {
	readonly clock: ServerClock;
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchLike;
	private readonly logger: Logger;
	private readonly now: () => number;

	constructor(private readonly options: RestClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.logger = options.logger ?? silentLogger();
		this.clock = options.clock ?? new ServerClock(options.now);
		this.now = options.now ?? Date.now;
	}

	get hasCredentials(): boolean {
		return Boolean(this.options.apiKey && this.options.apiSecret);
	}

	/** HMAC-SHA256 of the parameter string, hex encoded, as Binance requires. */
	private sign(payload: string): string {
		if (!this.options.apiSecret) throw new MissingCredentialsError("signed request");
		return createHmac("sha256", this.options.apiSecret).update(payload).digest("hex");
	}

	private buildQuery(params: Readonly<Record<string, QueryValue>>): string {
		const parts: string[] = [];
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined) continue;
			parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
		}
		return parts.join("&");
	}

	private async request<T>(
		method: "GET" | "POST" | "DELETE" | "PUT",
		path: string,
		params: Readonly<Record<string, QueryValue>>,
		budgets: Readonly<Record<string, number>>,
		options: { signed?: boolean; keyed?: boolean; signal?: AbortSignal } = {},
	): Promise<T> {
		const signed = options.signed ?? false;
		if (signed && !this.hasCredentials) throw new MissingCredentialsError(path);

		// The timeout is armed BEFORE queuing, so the caller's budget covers the wait as well as the
		// request. Otherwise a 429 penalty parks an order in the limiter for a full minute and then
		// sends it at a price derived from a book that was checked for freshness a minute ago.
		const timeout = AbortSignal.timeout(this.options.timeoutMs);
		const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

		try {
			await this.options.limiter.acquire({ ...budgets, [RAW_REQUESTS]: 1 }, signal);
		} catch (error) {
			throw new BinanceApiError(
				BINANCE_ERROR.TOO_MANY_REQUESTS,
				`rate limit wait exceeded the request budget: ${error instanceof Error ? error.message : String(error)}`,
				429,
				path,
				this.options.limiter.penaltyRemainingMs,
			);
		}
		if (signal.aborted) {
			throw new BinanceApiError(BINANCE_ERROR.TOO_MANY_REQUESTS, "request budget elapsed while queued", 429, path);
		}

		let query = this.buildQuery(
			signed ? { ...params, timestamp: this.clock.timestamp(), recvWindow: this.options.recvWindowMs } : params,
		);
		if (signed) query = `${query}&signature=${this.sign(query)}`;

		const url = query ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`;
		const headers: Record<string, string> = {};
		if (signed || options.keyed) {
			if (!this.options.apiKey) throw new MissingCredentialsError(path);
			headers["X-MBX-APIKEY"] = this.options.apiKey;
		}

		const startedAt = this.now();
		let response: Response;
		try {
			response = await this.fetchImpl(url, { method, headers, signal });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// HTTP status 0 marks "we never saw a reply", which `ambiguous` keys off.
			throw new BinanceApiError(BINANCE_ERROR.UNKNOWN, `transport failure: ${message}`, 0, path);
		}

		this.observeLimitHeaders(response.headers);

		const bodyText = await response.text();
		const latencyMs = this.now() - startedAt;

		if (!response.ok) {
			const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
			if (response.status === 429 || response.status === 418) {
				this.options.limiter.penalize(retryAfterMs || 60_000);
			}
			const payload = safeParse<BinanceErrorPayload>(bodyText);
			const code = typeof payload?.code === "number" ? payload.code : response.status * -1;
			const msg = payload?.msg ?? bodyText.slice(0, 200) ?? response.statusText;
			this.logger.warn("binance rest error", { path, status: response.status, code, msg, latencyMs });
			throw new BinanceApiError(code, msg, response.status, path, retryAfterMs);
		}

		this.logger.debug("binance rest ok", { path, latencyMs });
		if (bodyText.length === 0) return undefined as T;
		const parsed = safeParse<T>(bodyText);
		if (parsed === undefined) {
			throw new BinanceApiError(BINANCE_ERROR.UNKNOWN, "response was not valid JSON", response.status, path);
		}
		return parsed;
	}

	private observeLimitHeaders(headers: Headers): void {
		const usedWeight = headers.get("x-mbx-used-weight-1m");
		if (usedWeight) this.options.limiter.syncUsedWeight(WEIGHT, Number.parseInt(usedWeight, 10));
		const orderCount = headers.get("x-mbx-order-count-10s");
		if (orderCount) this.options.limiter.syncUsedWeight(ORDERS, Number.parseInt(orderCount, 10));
		const dayCount = headers.get("x-mbx-order-count-1d");
		if (dayCount) this.options.limiter.syncUsedWeight(ORDERS_DAY, Number.parseInt(dayCount, 10));
	}

	async ping(signal?: AbortSignal): Promise<void> {
		await this.request<Record<string, never>>(
			"GET",
			"/api/v3/ping",
			{},
			{ [WEIGHT]: ENDPOINT_WEIGHT.ping },
			{
				signal,
			},
		);
	}

	async serverTime(signal?: AbortSignal): Promise<number> {
		const payload = await this.request<RawServerTime>(
			"GET",
			"/api/v3/time",
			{},
			{ [WEIGHT]: ENDPOINT_WEIGHT.time },
			{ signal },
		);
		return payload.serverTime;
	}

	/**
	 * Measures and stores the offset between local and exchange time.
	 *
	 * Returns the resulting offset in milliseconds; callers compare it against
	 * `risk.maxClockSkewMs` before allowing trading.
	 */
	async syncClock(signal?: AbortSignal): Promise<number> {
		const sentAt = this.now();
		const serverTime = await this.serverTime(signal);
		const receivedAt = this.now();
		this.clock.observe(sentAt, serverTime, receivedAt);
		this.logger.debug("clock synced", { offsetMs: this.clock.offset, roundTripMs: this.clock.roundTripMs });
		return this.clock.offset;
	}

	async exchangeInfo(symbols?: readonly MarketSymbol[], signal?: AbortSignal): Promise<RawExchangeInfo> {
		const params: Record<string, QueryValue> = {};
		if (symbols && symbols.length > 0) {
			// Binance expects a JSON array literal, and rejects it if it contains spaces.
			params.symbols = JSON.stringify(symbols);
		}
		return this.request<RawExchangeInfo>(
			"GET",
			"/api/v3/exchangeInfo",
			params,
			{ [WEIGHT]: ENDPOINT_WEIGHT.exchangeInfo },
			{ signal },
		);
	}

	/** Snapshot of best bid/ask across every market, used to seed the book before streams arrive. */
	async bookTickers(signal?: AbortSignal): Promise<RawBookTickerRest[]> {
		return this.request<RawBookTickerRest[]>(
			"GET",
			"/api/v3/ticker/bookTicker",
			{},
			{ [WEIGHT]: ENDPOINT_WEIGHT.bookTickerAll },
			{ signal },
		);
	}

	async account(signal?: AbortSignal): Promise<RawAccountInfo> {
		return this.request<RawAccountInfo>(
			"GET",
			"/api/v3/account",
			{},
			{ [WEIGHT]: ENDPOINT_WEIGHT.account },
			{ signed: true, signal },
		);
	}

	async newOrder(params: NewOrderParams, signal?: AbortSignal): Promise<RawOrderResponse> {
		return this.request<RawOrderResponse>(
			"POST",
			"/api/v3/order",
			{ newOrderRespType: "FULL", ...params },
			{ [WEIGHT]: ENDPOINT_WEIGHT.newOrder, [ORDERS]: 1, [ORDERS_DAY]: 1 },
			{ signed: true, signal },
		);
	}

	/** Validates an order against every filter without placing it. Used by `doctor`. */
	async testOrder(params: NewOrderParams, signal?: AbortSignal): Promise<void> {
		await this.request<Record<string, never>>(
			"POST",
			"/api/v3/order/test",
			{ ...params },
			{ [WEIGHT]: ENDPOINT_WEIGHT.newOrder },
			{ signed: true, signal },
		);
	}

	async queryOrder(
		symbol: MarketSymbol,
		selector: { orderId?: number; origClientOrderId?: string },
		signal?: AbortSignal,
	): Promise<RawOrderResponse> {
		return this.request<RawOrderResponse>(
			"GET",
			"/api/v3/order",
			{ symbol, ...selector },
			{ [WEIGHT]: ENDPOINT_WEIGHT.queryOrder },
			{ signed: true, signal },
		);
	}

	async cancelOrder(
		symbol: MarketSymbol,
		selector: { orderId?: number; origClientOrderId?: string },
		signal?: AbortSignal,
	): Promise<RawOrderResponse> {
		return this.request<RawOrderResponse>(
			"DELETE",
			"/api/v3/order",
			{ symbol, ...selector },
			{ [WEIGHT]: ENDPOINT_WEIGHT.cancelOrder },
			{ signed: true, signal },
		);
	}
}

function safeParse<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/** `Retry-After` is in seconds per RFC 9110; Binance sends it on 429 and 418. */
function parseRetryAfter(header: string | null): number {
	if (!header) return 0;
	const seconds = Number.parseInt(header, 10);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/**
 * Constant-time comparison for a webhook or listen-key style shared secret.
 *
 * Exported because the CLI's `doctor` command verifies a signature round-trip and must not do so
 * with `===`, which leaks timing information.
 */
export function secretsMatch(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}
