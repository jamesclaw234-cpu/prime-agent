/**
 * Wire shapes for the Binance Spot REST and WebSocket APIs.
 *
 * Field names mirror the exchange exactly, including `cummulativeQuoteQty`, which Binance spells
 * with a doubled `m`. Nothing here is normalised - normalisation happens in `filters.ts` and
 * `rest-client.ts` so the raw payload stays greppable against the published docs.
 */

export interface BinanceErrorPayload {
	code: number;
	msg: string;
}

export interface RawRateLimit {
	rateLimitType: "REQUEST_WEIGHT" | "ORDERS" | "RAW_REQUESTS" | string;
	interval: "SECOND" | "MINUTE" | "DAY" | string;
	intervalNum: number;
	limit: number;
}

export interface RawFilter {
	filterType: string;
	[key: string]: string | number | boolean | undefined;
}

export interface RawSymbol {
	symbol: string;
	status: string;
	baseAsset: string;
	baseAssetPrecision: number;
	quoteAsset: string;
	quotePrecision?: number;
	quoteAssetPrecision: number;
	orderTypes: string[];
	icebergAllowed?: boolean;
	ocoAllowed?: boolean;
	quoteOrderQtyMarketAllowed?: boolean;
	isSpotTradingAllowed: boolean;
	isMarginTradingAllowed?: boolean;
	filters: RawFilter[];
	permissions?: string[];
	permissionSets?: string[][];
	defaultSelfTradePreventionMode?: string;
	allowedSelfTradePreventionModes?: string[];
}

export interface RawExchangeInfo {
	timezone: string;
	serverTime: number;
	rateLimits: RawRateLimit[];
	exchangeFilters: RawFilter[];
	symbols: RawSymbol[];
}

export interface RawBookTickerRest {
	symbol: string;
	bidPrice: string;
	bidQty: string;
	askPrice: string;
	askQty: string;
}

/** `<symbol>@bookTicker` stream payload. */
export interface RawBookTickerStream {
	/** Order book `updateId`, monotonically increasing per symbol. */
	u: number;
	s: string;
	/** Best bid price. */
	b: string;
	/** Best bid quantity. */
	B: string;
	/** Best ask price. */
	a: string;
	/** Best ask quantity. */
	A: string;
}

/** Envelope used by the combined stream endpoint `/stream?streams=a/b/c`. */
export interface RawCombinedStreamMessage<T> {
	stream: string;
	data: T;
}

export interface RawServerTime {
	serverTime: number;
}

export interface RawBalance {
	asset: string;
	free: string;
	locked: string;
}

export interface RawCommissionRates {
	maker: string;
	taker: string;
	buyer: string;
	seller: string;
}

export interface RawAccountInfo {
	/** Legacy integer basis-point fields, superseded by `commissionRates` but still present. */
	makerCommission: number;
	takerCommission: number;
	commissionRates?: RawCommissionRates;
	canTrade: boolean;
	canWithdraw: boolean;
	canDeposit: boolean;
	accountType?: string;
	balances: RawBalance[];
	permissions?: string[];
	updateTime?: number;
}

export interface RawFill {
	price: string;
	qty: string;
	commission: string;
	commissionAsset: string;
	tradeId?: number;
}

/** Response to `POST /api/v3/order` with `newOrderRespType=FULL`. */
export interface RawOrderResponse {
	symbol: string;
	orderId: number;
	orderListId?: number;
	clientOrderId: string;
	transactTime: number;
	price: string;
	origQty: string;
	executedQty: string;
	cummulativeQuoteQty: string;
	status: string;
	timeInForce?: string;
	type: string;
	side: string;
	workingTime?: number;
	selfTradePreventionMode?: string;
	fills?: RawFill[];
}

export type RawOrderStatus =
	| "NEW"
	| "PARTIALLY_FILLED"
	| "FILLED"
	| "CANCELED"
	| "PENDING_CANCEL"
	| "REJECTED"
	| "EXPIRED"
	| "EXPIRED_IN_MATCH";

/** Binance error codes this package branches on. */
export const BINANCE_ERROR = {
	/** Internal error; request status unknown. Treat as possibly executed. */
	UNKNOWN: -1000,
	DISCONNECTED: -1001,
	/** Too many requests; the caller is being rate limited. */
	TOO_MANY_REQUESTS: -1003,
	/**
	 * Timed out waiting for the matching engine.
	 *
	 * On an order placement this is the dangerous case: the order may have executed. Reconcile by
	 * client order id; never blindly retry.
	 */
	TIMEOUT: -1007,
	/** `timestamp` outside `recvWindow`, or ahead of server time. Resync the clock. */
	INVALID_TIMESTAMP: -1021,
	INVALID_SIGNATURE: -1022,
	ILLEGAL_CHARS: -1100,
	MANDATORY_PARAM_MISSING: -1102,
	/** Filter failure: LOT_SIZE, PRICE_FILTER, NOTIONAL, PERCENT_PRICE_BY_SIDE, etc. */
	FILTER_FAILURE: -1013,
	/** IP auto-banned for repeatedly exceeding rate limits. */
	IP_BANNED: -1015,
	BAD_PRECISION: -1111,
	NEW_ORDER_REJECTED: -2010,
	CANCEL_REJECTED: -2011,
	NO_SUCH_ORDER: -2013,
	BAD_API_KEY: -2014,
	REJECTED_MBX_KEY: -2015,
} as const;
