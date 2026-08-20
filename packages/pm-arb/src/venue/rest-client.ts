import type { KeyObject } from "node:crypto";
import { type Logger, silentLogger } from "../util/logger.js";
import { createAuthHeaders, privateKeyFromSecret } from "./auth.js";
import type {
	ApiErrorBody,
	CreateOrderParams,
	EventDetail,
	MarketBook,
	MarketDetail,
	Order,
	UserPosition,
} from "./types.js";

/**
 * Client for the Polymarket US REST API.
 *
 * Two hosts, split the way the official SDK splits them: public market data is served from the
 * gateway host and needs no credentials; anything trading- or account-shaped is served from the
 * api host and carries the Ed25519 signature over `${ts}${METHOD}${path}` - bare path, query and
 * body excluded from the signed message.
 *
 * The public tier is documented at 60 requests per minute, so this client meters itself with a
 * sliding window rather than discovering the limit as an error mid-scan. WebSocket streaming is
 * the intended bulk data path; REST is startup snapshots and the occasional refresh.
 */

export const GATEWAY_BASE_URL = "https://gateway.polymarket.us";
export const API_BASE_URL = "https://api.polymarket.us";
/** Documented public rate limit. Self-imposed, with headroom, so a scan never trips the real one. */
export const PUBLIC_REQUESTS_PER_MINUTE = 60;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RestClientOptions {
	readonly gatewayBaseUrl?: string;
	readonly apiBaseUrl?: string;
	readonly keyId?: string;
	/** Base64 Ed25519 secret. Held only as a parsed KeyObject after construction. */
	readonly secretKey?: string;
	readonly timeoutMs?: number;
	readonly logger?: Logger;
	readonly fetchImpl?: FetchLike;
	readonly now?: () => number;
	/** Override for tests; production keeps the documented budget. */
	readonly publicRequestsPerMinute?: number;
}

export class PolymarketApiError extends Error {
	constructor(
		readonly httpStatus: number,
		message: string,
		readonly endpoint: string,
	) {
		super(`${endpoint} failed: ${message} (HTTP ${httpStatus})`);
		this.name = "PolymarketApiError";
	}

	/** True when the same request may succeed later unchanged. */
	get retryable(): boolean {
		return this.httpStatus === 429 || this.httpStatus >= 500 || this.httpStatus === 0;
	}

	/**
	 * True when an order placement may have reached the matching engine despite the error.
	 *
	 * The same hazard class as on any exchange: a timeout or 5xx after the request left the
	 * process. Callers must reconcile via the open-orders and positions endpoints, never blind-retry.
	 */
	get ambiguous(): boolean {
		return this.httpStatus >= 500 || this.httpStatus === 0;
	}
}

export class MissingCredentialsError extends Error {
	constructor(endpoint: string) {
		super(`${endpoint} requires POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY`);
		this.name = "MissingCredentialsError";
	}
}

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

export class PolymarketRestClient {
	private readonly gatewayBaseUrl: string;
	private readonly apiBaseUrl: string;
	private readonly keyId?: string;
	private readonly privateKey?: KeyObject;
	private readonly timeoutMs: number;
	private readonly logger: Logger;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private readonly publicBudget: number;
	/** Timestamps of recent public requests; pruned to the trailing minute. */
	private readonly publicRequestTimes: number[] = [];

	constructor(options: RestClientOptions = {}) {
		this.gatewayBaseUrl = (options.gatewayBaseUrl ?? GATEWAY_BASE_URL).replace(/\/+$/, "");
		this.apiBaseUrl = (options.apiBaseUrl ?? API_BASE_URL).replace(/\/+$/, "");
		this.keyId = options.keyId;
		this.privateKey = options.secretKey ? privateKeyFromSecret(options.secretKey) : undefined;
		this.timeoutMs = options.timeoutMs ?? 5000;
		this.logger = options.logger ?? silentLogger();
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.now = options.now ?? Date.now;
		this.publicBudget = options.publicRequestsPerMinute ?? PUBLIC_REQUESTS_PER_MINUTE;
	}

	get hasCredentials(): boolean {
		return Boolean(this.keyId && this.privateKey);
	}

	// --- public market data (gateway host, unauthenticated, self-metered) -------------------------

	async events(params?: { limit?: number; offset?: number; active?: boolean }): Promise<EventDetail[]> {
		const body = await this.request<{ events?: EventDetail[] }>("GET", "/v1/events", { query: params });
		return body.events ?? [];
	}

	async markets(params?: { limit?: number; offset?: number }): Promise<MarketDetail[]> {
		const body = await this.request<{ markets?: MarketDetail[] }>("GET", "/v1/markets", { query: params });
		return body.markets ?? [];
	}

	async marketBySlug(slug: string): Promise<MarketDetail> {
		const body = await this.request<{ market?: MarketDetail }>("GET", `/v1/market/slug/${encodeURIComponent(slug)}`);
		return body.market ?? (body as MarketDetail);
	}

	async book(slug: string): Promise<MarketBook> {
		return this.request<MarketBook>("GET", `/v1/markets/${encodeURIComponent(slug)}/book`);
	}

	// --- trading and account (api host, signed) ---------------------------------------------------

	async createOrder(params: CreateOrderParams, signal?: AbortSignal): Promise<Order> {
		const body = await this.request<{ order?: Order }>("POST", "/v1/orders", {
			body: params,
			authenticated: true,
			signal,
		});
		return body.order ?? (body as Order);
	}

	/**
	 * Validates an order without placing it - this venue's free rehearsal rung, used by doctor.
	 *
	 * The wire shape differs from create: the SDK's PreviewOrderParams wraps the order in a
	 * `request` field, and the response is an Order carrying the commission fields to reconcile
	 * the configured fee rates against.
	 */
	async previewOrder(params: CreateOrderParams, signal?: AbortSignal): Promise<Order> {
		const body = await this.request<{ order?: Order }>("POST", "/v1/order/preview", {
			body: { request: params },
			authenticated: true,
			signal,
		});
		return body.order ?? (body as Order);
	}

	async openOrders(signal?: AbortSignal): Promise<Order[]> {
		const body = await this.request<{ orders?: Order[] }>("GET", "/v1/orders/open", {
			authenticated: true,
			signal,
		});
		return body.orders ?? [];
	}

	async order(orderId: string, signal?: AbortSignal): Promise<Order> {
		const body = await this.request<{ order?: Order }>("GET", `/v1/order/${encodeURIComponent(orderId)}`, {
			authenticated: true,
			signal,
		});
		return body.order ?? (body as Order);
	}

	async cancelOrder(orderId: string, marketSlug: string, signal?: AbortSignal): Promise<void> {
		await this.request<unknown>("POST", `/v1/order/${encodeURIComponent(orderId)}/cancel`, {
			body: { marketSlug },
			authenticated: true,
			signal,
		});
	}

	async positions(signal?: AbortSignal): Promise<UserPosition[]> {
		const body = await this.request<{ positions?: UserPosition[] }>("GET", "/v1/portfolio/positions", {
			authenticated: true,
			signal,
		});
		return body.positions ?? [];
	}

	// --- transport ---------------------------------------------------------------------------------

	private async request<T>(
		method: "GET" | "POST",
		path: string,
		options: { query?: Query; body?: unknown; authenticated?: boolean; signal?: AbortSignal } = {},
	): Promise<T> {
		const authenticated = options.authenticated ?? false;
		if (authenticated && (!this.keyId || !this.privateKey)) throw new MissingCredentialsError(path);

		if (!authenticated) await this.meterPublicRequest();

		const base = authenticated ? this.apiBaseUrl : this.gatewayBaseUrl;
		const query = buildQuery(options.query);
		const url = query ? `${base}${path}?${query}` : `${base}${path}`;

		const headers: Record<string, string> = { "content-type": "application/json" };
		if (authenticated && this.keyId && this.privateKey) {
			// The signature covers the BARE path - never the query string, never the body. Getting
			// this wrong fails only against a verifying server, which is why the loopback fake
			// verifies rather than trusts.
			Object.assign(headers, createAuthHeaders(this.keyId, this.privateKey, method, path, this.now()));
		}

		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new PolymarketApiError(0, `transport failure: ${message}`, path);
		}

		const text = await response.text();
		if (!response.ok) {
			const parsed = safeParse<ApiErrorBody>(text);
			const message = parsed?.message ?? text.slice(0, 200) ?? response.statusText;
			this.logger.warn("polymarket rest error", { path, status: response.status, message });
			throw new PolymarketApiError(response.status, message, path);
		}
		if (text.length === 0) return {} as T;
		const parsed = safeParse<T>(text);
		if (parsed === undefined) throw new PolymarketApiError(response.status, "response was not valid JSON", path);
		return parsed;
	}

	/** Sliding-window self-metering for the public tier. Waits rather than 429s. */
	private async meterPublicRequest(): Promise<void> {
		for (;;) {
			const now = this.now();
			const cutoff = now - 60_000;
			while (this.publicRequestTimes.length > 0 && this.publicRequestTimes[0] <= cutoff) {
				this.publicRequestTimes.shift();
			}
			if (this.publicRequestTimes.length < this.publicBudget) {
				this.publicRequestTimes.push(now);
				return;
			}
			const waitMs = this.publicRequestTimes[0] + 60_000 - now + 1;
			await new Promise((resolve) => setTimeout(resolve, Math.max(1, waitMs)));
		}
	}
}

function buildQuery(query?: Query): string {
	if (!query) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined) continue;
		parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
	}
	return parts.join("&");
}

function safeParse<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}
