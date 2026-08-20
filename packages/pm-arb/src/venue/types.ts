/**
 * Wire types for the Polymarket US API.
 *
 * Mirrored from the official SDK source (Polymarket/polymarket-us-python, types/), which is the
 * closest thing to a machine-readable spec: the docs site describes, the SDK's TypedDicts are what
 * the exchange actually serves. Field names are kept verbatim so a diff against a future SDK
 * version is mechanical.
 */

/** Monetary amount. Prices are dollar strings between "0.01" and "0.99"; currency is always USD. */
export interface Amount {
	readonly value: string;
	readonly currency: "USD";
}

export type OrderType = "ORDER_TYPE_LIMIT" | "ORDER_TYPE_MARKET";

/**
 * What the order does, in one field.
 *
 * LONG is the YES side, SHORT the NO side of the same market - there are no separate complement
 * tokens on this venue. BUY_LONG/BUY_SHORT open exposure; SELL_* close it. A matched LONG+SHORT
 * pair pays $1 at settlement, which is the complement-arbitrage primitive.
 */
export type OrderIntent =
	| "ORDER_INTENT_BUY_LONG"
	| "ORDER_INTENT_SELL_LONG"
	| "ORDER_INTENT_BUY_SHORT"
	| "ORDER_INTENT_SELL_SHORT";

export type TimeInForce =
	| "TIME_IN_FORCE_GOOD_TILL_CANCEL"
	| "TIME_IN_FORCE_GOOD_TILL_DATE"
	| "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL"
	| "TIME_IN_FORCE_FILL_OR_KILL";

export type OrderState =
	| "ORDER_STATE_NEW"
	| "ORDER_STATE_PENDING_NEW"
	| "ORDER_STATE_PENDING_REPLACE"
	| "ORDER_STATE_PENDING_CANCEL"
	| "ORDER_STATE_PENDING_RISK"
	| "ORDER_STATE_PARTIALLY_FILLED"
	| "ORDER_STATE_FILLED"
	| "ORDER_STATE_CANCELED"
	| "ORDER_STATE_REPLACED"
	| "ORDER_STATE_REJECTED"
	| "ORDER_STATE_EXPIRED";

export type MarketState =
	| "MARKET_STATE_OPEN"
	| "MARKET_STATE_PREOPEN"
	| "MARKET_STATE_SUSPENDED"
	| "MARKET_STATE_HALTED"
	| "MARKET_STATE_EXPIRED"
	| "MARKET_STATE_TERMINATED"
	| "MARKET_STATE_MATCH_AND_CLOSE_AUCTION";

export interface OrderBookLevel {
	readonly px: Amount;
	readonly qty: string;
}

export interface MarketStats {
	readonly lastTradePx?: Amount;
	readonly sharesTraded?: string;
	readonly openInterest?: string;
	readonly highPx?: Amount;
	readonly lowPx?: Amount;
}

export interface MarketBook {
	readonly marketSlug?: string;
	readonly bids?: readonly OrderBookLevel[];
	readonly offers?: readonly OrderBookLevel[];
	readonly state?: MarketState;
	readonly stats?: MarketStats;
	readonly transactTime?: string;
}

export interface MarketDetail {
	readonly id?: number;
	readonly slug?: string;
	readonly title?: string;
	readonly outcome?: string;
	readonly description?: string;
	readonly active?: boolean;
	readonly closed?: boolean;
	readonly liquidity?: number;
	readonly volume?: number;
	readonly eventSlug?: string;
}

/** An event groups the markets that are its outcomes - the unit of multi-outcome sum arbitrage. */
export interface EventDetail {
	readonly id?: number;
	readonly slug?: string;
	readonly title?: string;
	readonly active?: boolean;
	readonly closed?: boolean;
	readonly liquidity?: number;
	readonly volume?: number;
	readonly markets?: readonly MarketDetail[];
}

export interface CreateOrderParams {
	readonly marketSlug: string;
	readonly intent: OrderIntent;
	readonly type: OrderType;
	readonly price?: Amount;
	readonly quantity: number;
	readonly tif: TimeInForce;
	readonly goodTillTime?: string;
	readonly participateDontInitiate?: boolean;
}

export interface Order {
	readonly id?: string;
	readonly marketSlug?: string;
	readonly type?: OrderType;
	readonly price?: Amount;
	readonly quantity?: number;
	readonly cumQuantity?: number;
	readonly leavesQuantity?: number;
	readonly tif?: TimeInForce;
	readonly intent?: OrderIntent;
	readonly state?: OrderState;
	readonly avgPx?: Amount;
	/** Fees actually charged, straight from the exchange - never model these locally. */
	readonly commissionNotionalTotalCollected?: Amount;
	readonly commissionsBasisPoints?: string;
	readonly makerCommissionsBasisPoints?: string;
	readonly insertTime?: string;
	readonly createTime?: string;
}

export interface UserPosition {
	readonly marketSlug?: string;
	readonly quantity?: string;
	readonly side?: string;
	readonly avgPx?: Amount;
}

/** Error envelope. The SDK surfaces { message } with the HTTP status; mirror that. */
export interface ApiErrorBody {
	readonly message?: string;
	readonly code?: string | number;
}
