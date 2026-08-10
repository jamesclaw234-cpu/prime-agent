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

/** One component's rates. The side fields are ADDED to the maker/taker field, not alternatives. */
export interface RawCommissionComponent {
	maker: string;
	taker: string;
	buyer: string;
	seller: string;
}

/** Response to `GET /api/v3/account/commission`. Per symbol; weight 20. */
export interface RawSymbolCommission {
	symbol: string;
	standardCommission: RawCommissionComponent;
	specialCommission?: RawCommissionComponent;
	taxCommission?: RawCommissionComponent;
	discount?: {
		enabledForAccount?: boolean;
		enabledForSymbol?: boolean;
		discountAsset?: string;
		discount?: string;
	};
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
	/** Present only when the order expired. See `EXPIRY_REASON`. */
	expiryReason?: string;
}

/**
 * Why an order expired.
 *
 * `UNFILLED_IOC_QUANTITY_EXPIRED` is the ordinary outcome for a marketable IOC that lost the race
 * and needs no attention. The others are diagnoses worth acting on: a price the exchange refused,
 * or a book with nothing in it.
 */
export const EXPIRY_REASON = {
	UNFILLED_IOC: "UNFILLED_IOC_QUANTITY_EXPIRED",
	UNFILLED_FOK: "UNFILLED_FOK_ORDER_EXPIRED",
	INSUFFICIENT_LIQUIDITY: "INSUFFICIENT_LIQUIDITY",
	/** A taker order tried to execute outside the symbol's Price Range execution rule. */
	PRICE_RANGE_EXCEEDED: "EXECUTION_RULE_PRICE_RANGE_EXCEEDED",
	EXCHANGE_CANCELED: "EXCHANGE_CANCELED",
	REJECTED: "REJECTED",
	NONE: "NONE",
} as const;

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
	 * Unexpected response from the message bus.
	 *
	 * The docs state plainly: "Execution status unknown." Same hazard class as -1007.
	 */
	UNEXPECTED_RESP: -1006,
	/**
	 * Timed out waiting for the matching engine.
	 *
	 * On an order placement this is the dangerous case: the order may have executed. Reconcile by
	 * client order id; never blindly retry. Binance's own processing timeout is 10 seconds.
	 */
	TIMEOUT: -1007,
	/** Server overloaded and asking us to come back later; the request was not processed. */
	SERVER_BUSY: -1008,
	/** A matching-engine error message; shares its message table with -2010. */
	ERROR_MSG_RECEIVED: -1010,
	/** `timestamp` outside `recvWindow`, or ahead of server time. Resync the clock. */
	INVALID_TIMESTAMP: -1021,
	INVALID_SIGNATURE: -1022,
	ILLEGAL_CHARS: -1100,
	MANDATORY_PARAM_MISSING: -1102,
	/** Filter failure: LOT_SIZE, PRICE_FILTER, NOTIONAL, PERCENT_PRICE_BY_SIDE, etc. */
	FILTER_FAILURE: -1013,
	/**
	 * Too many new orders.
	 *
	 * This is the unfilled-order-count limit, which is tracked per account. An IP ban is a
	 * different thing entirely: HTTP 418, or -1003 with an "IP banned until" message.
	 */
	TOO_MANY_ORDERS: -1015,
	/** The service is shutting down and will not process the request. */
	SERVICE_SHUTTING_DOWN: -1016,
	BAD_PRECISION: -1111,
	NEW_ORDER_REJECTED: -2010,
	CANCEL_REJECTED: -2011,
	NO_SUCH_ORDER: -2013,
	BAD_API_KEY: -2014,
	REJECTED_MBX_KEY: -2015,
} as const;
