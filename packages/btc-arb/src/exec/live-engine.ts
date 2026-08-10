import { formatPrice, formatQty } from "../binance/filters.js";
import { BinanceApiError, type BinanceRestClient } from "../binance/rest-client.js";
import { BINANCE_ERROR, type RawOrderResponse } from "../binance/types.js";
import type { Asset } from "../types.js";
import { type Dec, decFromString, ZERO } from "../util/decimal.js";
import { type Logger, silentLogger } from "../util/logger.js";
import { type ExecutionEngine, NOT_PLACED, type OrderOutcome, type OrderRequest, type SimpleFill } from "./engine.js";

export interface LiveEngineOptions {
	readonly client: BinanceRestClient;
	readonly logger?: Logger;
	readonly now?: () => number;
	/** Cache window for account balances. Zero re-reads on every call. */
	readonly balanceCacheMs?: number;
}

/**
 * Order placement against the real exchange.
 *
 * Reachable only through the live gate in `config.ts`; nothing constructs this by accident.
 *
 * Every order is IOC, so there is never a resting order to reconcile after a crash. The one case
 * that still needs care is an ambiguous transport failure - a timeout after the request left the
 * process - where the order may or may not have executed. That is surfaced to the caller as an
 * `ambiguous` error rather than silently retried, because a blind retry on a filled leg doubles
 * the position.
 */
export class LiveEngine implements ExecutionEngine {
	readonly mode = "live" as const;
	private readonly logger: Logger;
	private readonly now: () => number;
	private cachedBalances?: { at: number; balances: Map<Asset, Dec> };

	constructor(private readonly options: LiveEngineOptions) {
		this.logger = options.logger ?? silentLogger();
		this.now = options.now ?? Date.now;
	}

	async placeIoc(request: OrderRequest, signal?: AbortSignal): Promise<OrderOutcome> {
		const startedAt = this.now();
		const params = {
			symbol: request.symbol,
			side: request.side,
			type: "LIMIT" as const,
			timeInForce: "IOC" as const,
			quantity: formatQty(request.rules, request.quantity),
			price: formatPrice(request.rules, request.price),
			newClientOrderId: request.clientOrderId,
			newOrderRespType: "FULL" as const,
		};

		let response: RawOrderResponse;
		try {
			response = await this.options.client.newOrder(params, signal);
		} catch (error) {
			if (error instanceof BinanceApiError) {
				// A rejection is a definite non-fill and safe to treat as a zero-quantity outcome.
				if (!error.ambiguous && isDefiniteRejection(error)) {
					this.logger.warn("order rejected", {
						symbol: request.symbol,
						side: request.side,
						code: error.code,
						msg: error.message,
					});
					return {
						orderId: "",
						clientOrderId: request.clientOrderId,
						status: "REJECTED",
						executedQty: ZERO,
						quoteQty: ZERO,
						fills: [],
						latencyMs: this.now() - startedAt,
					};
				}
			}
			throw error;
		}

		// Balances just changed; the cache would otherwise hand the next leg a stale figure.
		this.cachedBalances = undefined;
		return toOutcome(response, this.now() - startedAt);
	}

	/**
	 * Resolves an order whose placement failed ambiguously.
	 *
	 * Looks the order up by the client id we generated. A `NO_SUCH_ORDER` response proves the
	 * order never reached the book, which is the only safe basis for continuing.
	 *
	 * The returned outcome carries no `fills` array - Binance's order-query response has none - so
	 * it answers "did this execute" and must not be used to compute commission or PnL.
	 */
	async resolveOrder(symbol: string, clientOrderId: string, signal?: AbortSignal): Promise<OrderOutcome | undefined> {
		try {
			const response = await this.options.client.queryOrder(symbol, { origClientOrderId: clientOrderId }, signal);
			return toOutcome(response, 0);
		} catch (error) {
			if (error instanceof BinanceApiError && error.code === BINANCE_ERROR.NO_SUCH_ORDER) {
				return {
					orderId: "",
					clientOrderId,
					status: NOT_PLACED,
					executedQty: ZERO,
					quoteQty: ZERO,
					fills: [],
					latencyMs: 0,
				};
			}
			return undefined;
		}
	}

	async balances(): Promise<ReadonlyMap<Asset, Dec>> {
		const cacheMs = this.options.balanceCacheMs ?? 0;
		const cached = this.cachedBalances;
		if (cached && cacheMs > 0 && this.now() - cached.at < cacheMs) return cached.balances;

		const account = await this.options.client.account();
		const balances = new Map<Asset, Dec>();
		for (const balance of account.balances ?? []) {
			const free = decFromString(balance.free);
			if (free > ZERO) balances.set(balance.asset, free);
		}
		this.cachedBalances = { at: this.now(), balances };
		return balances;
	}
}

function toOutcome(response: RawOrderResponse, latencyMs: number): OrderOutcome {
	const fills: SimpleFill[] = (response.fills ?? []).map((fill) => ({
		price: decFromString(fill.price),
		qty: decFromString(fill.qty),
		commission: decFromString(fill.commission),
		commissionAsset: fill.commissionAsset,
	}));
	return {
		orderId: String(response.orderId),
		clientOrderId: response.clientOrderId,
		status: response.status,
		executedQty: decFromString(response.executedQty),
		quoteQty: decFromString(response.cummulativeQuoteQty),
		fills,
		latencyMs,
	};
}

/**
 * True when the exchange definitively refused the order.
 *
 * These codes all mean "nothing was placed": a filter violation, an unfundable order, or a
 * malformed parameter. Anything else keeps its ambiguity and is re-thrown.
 */
function isDefiniteRejection(error: BinanceApiError): boolean {
	// `-2010 Duplicate order sent.` is the one -2010 that is NOT a clean refusal: it means an order
	// already exists under this client id, which may be resting or filled. It must be reconciled,
	// never treated as a non-fill and never re-sent.
	if (error.code === BINANCE_ERROR.NEW_ORDER_REJECTED && /duplicate order/i.test(error.message)) return false;
	return (
		error.code === BINANCE_ERROR.NEW_ORDER_REJECTED ||
		error.code === BINANCE_ERROR.FILTER_FAILURE ||
		error.code === BINANCE_ERROR.BAD_PRECISION ||
		error.code === BINANCE_ERROR.ILLEGAL_CHARS ||
		error.code === BINANCE_ERROR.MANDATORY_PARAM_MISSING
	);
}
