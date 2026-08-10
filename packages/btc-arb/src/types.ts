import type { Dec } from "./util/decimal.js";

/** A settlement asset ticker as Binance spells it, e.g. `BTC`, `USDT`, `FDUSD`. */
export type Asset = string;

/** A Binance spot market, e.g. `BTCUSDT`. Always `${baseAsset}${quoteAsset}`. */
export type MarketSymbol = string;

export type OrderSide = "BUY" | "SELL";

export type TimeInForce = "GTC" | "IOC" | "FOK";

export type OrderType = "LIMIT" | "MARKET" | "LIMIT_MAKER";

/**
 * Trading rules for one market, distilled from `GET /api/v3/exchangeInfo`.
 *
 * Every field that constrains an outbound order is materialised here so the hot path never has to
 * re-read raw filter arrays.
 */
export interface SymbolRules {
	readonly symbol: MarketSymbol;
	readonly baseAsset: Asset;
	readonly quoteAsset: Asset;
	readonly status: string;
	readonly isSpotTradingAllowed: boolean;
	readonly orderTypes: readonly string[];
	readonly baseAssetPrecision: number;
	readonly quoteAssetPrecision: number;

	/** PRICE_FILTER. `maxPrice` of zero means unbounded. */
	readonly tickSize: Dec;
	readonly minPrice: Dec;
	readonly maxPrice: Dec;

	/** LOT_SIZE, applied to LIMIT orders. */
	readonly stepSize: Dec;
	readonly minQty: Dec;
	readonly maxQty: Dec;

	/** MARKET_LOT_SIZE, applied to MARKET orders. Falls back to LOT_SIZE when absent. */
	readonly marketStepSize: Dec;
	readonly marketMinQty: Dec;
	readonly marketMaxQty: Dec;

	/** NOTIONAL / MIN_NOTIONAL. `maxNotional` of zero means unbounded. */
	readonly minNotional: Dec;
	readonly maxNotional: Dec;
	readonly applyMinToMarket: boolean;
	readonly applyMaxToMarket: boolean;

	/** PERCENT_PRICE_BY_SIDE. Zero means the multiplier is not enforced. */
	readonly bidMultiplierUp: Dec;
	readonly bidMultiplierDown: Dec;
	readonly askMultiplierUp: Dec;
	readonly askMultiplierDown: Dec;

	/** Fraction digits implied by `tickSize` and `stepSize`, used to format outbound parameters. */
	readonly pricePrecision: number;
	readonly qtyPrecision: number;
}

/**
 * Best bid and offer for one market.
 *
 * `bidQty` and `askQty` are the resting sizes at those prices and are the hard cap on how much a
 * single marketable order can fill without walking the book, which is why sizing never exceeds them.
 */
export interface TopOfBook {
	readonly symbol: MarketSymbol;
	readonly bid: Dec;
	readonly bidQty: Dec;
	readonly ask: Dec;
	readonly askQty: Dec;
	/** Binance order book `updateId`. Monotonically increasing per symbol; used to drop stale frames. */
	readonly updateId: number;
	/** `Date.now()` when the frame was received locally. */
	readonly receivedAt: number;
	/** Float mirrors of `bid`/`ask`/quantities, for the screening pass only. */
	readonly bidNum: number;
	readonly bidQtyNum: number;
	readonly askNum: number;
	readonly askQtyNum: number;
}

/**
 * One hop of an arbitrage cycle.
 *
 * A leg converts `fromAsset` into `toAsset` by taking liquidity on `symbol`. `SELL` consumes the
 * bid (we hold the base asset), `BUY` consumes the ask (we hold the quote asset).
 */
export interface CycleLeg {
	readonly symbol: MarketSymbol;
	readonly side: OrderSide;
	readonly fromAsset: Asset;
	readonly toAsset: Asset;
}

/** A closed conversion loop that starts and ends on the same asset. */
export interface Cycle {
	/** Stable identifier, e.g. `USDT>BTC>ETH>USDT`. */
	readonly id: string;
	readonly startAsset: Asset;
	readonly legs: readonly CycleLeg[];
}

/** A cycle priced against the current book, before any size or filter constraints are applied. */
export interface CycleQuote {
	readonly cycle: Cycle;
	/** Product of the fee-adjusted leg rates. Greater than 1 means a gross profit exists. */
	readonly grossMultiple: number;
	/** `(grossMultiple - 1) * 10000`, i.e. the raw edge in basis points. */
	readonly edgeBps: number;
	/** Age in milliseconds of the oldest book frame used to price this cycle. */
	readonly maxBookAgeMs: number;
}

/** A concrete, filter-compliant plan for one leg. */
export interface LegPlan {
	readonly leg: CycleLeg;
	/** Limit price, already rounded to `tickSize` and bounded by the aggression offset. */
	readonly price: Dec;
	/** Order quantity in base asset units, already rounded down to `stepSize`. */
	readonly quantity: Dec;
	/** `price * quantity`, the quote-asset notional. */
	readonly notional: Dec;
	/** Amount of `leg.fromAsset` consumed by this leg. */
	readonly amountIn: Dec;
	/** Expected amount of `leg.toAsset` received, net of the taker fee. */
	readonly expectedOut: Dec;
	/** Best price observed when the plan was built, used to detect drift before sending. */
	readonly referencePrice: Dec;
}

/** A fully sized, filter-checked, fee-adjusted opportunity that is ready to execute. */
export interface Opportunity {
	readonly id: string;
	readonly cycle: Cycle;
	readonly quote: CycleQuote;
	readonly legs: readonly LegPlan[];
	/** Amount of `cycle.startAsset` committed to leg 1. */
	readonly amountIn: Dec;
	/** Expected amount of `cycle.startAsset` returned by the final leg. */
	readonly expectedOut: Dec;
	/** `expectedOut - amountIn`, in start-asset units, after all fees and lot rounding. */
	readonly expectedProfit: Dec;
	/** `expectedProfit / amountIn` in basis points, after rounding. This is the number to trust. */
	readonly netEdgeBps: number;
	/** Notional of leg 1 converted into the accounting asset, for risk limits. */
	readonly notionalInAccountingAsset: Dec;
	readonly detectedAt: number;
}

/** What actually happened on one leg. */
export interface LegFill {
	readonly leg: CycleLeg;
	readonly requestedQty: Dec;
	readonly executedQty: Dec;
	/** `cummulativeQuoteQty` from Binance: the quote-asset amount actually traded. */
	readonly quoteQty: Dec;
	/** Amount of `leg.fromAsset` actually spent. */
	readonly amountIn: Dec;
	/**
	 * Amount of `leg.toAsset` actually received, net of commission.
	 *
	 * Commission is deducted here only when it was charged in `toAsset`. A commission paid in BNB
	 * is recorded in `commissions` and settled separately by the ledger.
	 */
	readonly amountOut: Dec;
	readonly commissions: readonly { asset: Asset; amount: Dec }[];
	readonly avgPrice: Dec;
	readonly orderId: string;
	readonly clientOrderId: string;
	readonly status: string;
	readonly latencyMs: number;
}

export type CycleOutcome =
	| "completed"
	| "aborted_no_fill"
	| "aborted_edge_gone"
	| "aborted_deadline"
	| "aborted_risk"
	| "unwound"
	| "stranded"
	| "error";

/** The full record of one attempted cycle, written to the ledger. */
export interface CycleResult {
	readonly opportunityId: string;
	readonly cycleId: string;
	readonly mode: "paper" | "live";
	readonly outcome: CycleOutcome;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly fills: readonly LegFill[];
	/** Legs executed to flatten residual inventory after a failed cycle. */
	readonly unwindFills: readonly LegFill[];
	readonly amountIn: Dec;
	readonly amountOut: Dec;
	/** `amountOut - amountIn`, in start-asset units. Negative on a loss. */
	readonly realizedPnl: Dec;
	readonly realizedPnlAsset: Asset;
	/** Inventory left over in an asset other than the start asset, if the unwind could not flatten. */
	readonly strandedAsset?: Asset;
	readonly strandedAmount?: Dec;
	readonly expectedProfit: Dec;
	/** `realizedPnl - expectedProfit`: how much worse reality was than the signal. */
	readonly slippage: Dec;
	/**
	 * An order failed in a way that leaves it unknown whether it executed.
	 *
	 * The recorded position cannot be trusted until the account is queried, so the supervisor
	 * halts on this rather than continuing to trade against a guess.
	 */
	readonly needsReconciliation: boolean;
	readonly error?: string;
}
