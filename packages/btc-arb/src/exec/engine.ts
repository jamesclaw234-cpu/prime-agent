import type { Asset, CycleLeg, MarketSymbol, OrderSide, SymbolRules } from "../types.js";
import { type Dec, decDiv, decMul, decSub, decSum, ZERO } from "../util/decimal.js";

export interface OrderRequest {
	readonly symbol: MarketSymbol;
	readonly side: OrderSide;
	readonly price: Dec;
	readonly quantity: Dec;
	readonly rules: SymbolRules;
	readonly clientOrderId: string;
}

export interface SimpleFill {
	readonly price: Dec;
	readonly qty: Dec;
	readonly commission: Dec;
	readonly commissionAsset: Asset;
}

export interface OrderOutcome {
	readonly orderId: string;
	readonly clientOrderId: string;
	/** Binance order status: `FILLED`, `PARTIALLY_FILLED`, `EXPIRED`, `REJECTED`. */
	readonly status: string;
	readonly executedQty: Dec;
	/** `cummulativeQuoteQty`: quote-asset amount actually traded. */
	readonly quoteQty: Dec;
	readonly fills: readonly SimpleFill[];
	/**
	 * Why the order expired, when it did.
	 *
	 * Separates an ordinary lost race from a price the exchange refused outright, which are the
	 * same zero-fill outcome but very different problems.
	 */
	readonly expiryReason?: string;
	readonly latencyMs: number;
}

/**
 * Order placement, implemented against either a simulator or the live exchange.
 *
 * Only IOC limit orders are exposed. A resting order is not an arbitrage instrument: by the time
 * it fills, the other legs of the cycle have moved, and the position is directional.
 */
export interface ExecutionEngine {
	readonly mode: "paper" | "live";
	placeIoc(request: OrderRequest, signal?: AbortSignal): Promise<OrderOutcome>;
	/** Current spendable balances. Live engines read the account; the paper engine tracks its own. */
	balances(): Promise<ReadonlyMap<Asset, Dec>>;
	/**
	 * Looks up an order whose placement failed ambiguously.
	 *
	 * Querying is safe where retrying is not: it can only tell us what happened. Returns an outcome
	 * with status `NOT_PLACED` when the exchange proves the order never reached the book, a real
	 * outcome when it did, and `undefined` when the question could not be answered - which is the
	 * one case that genuinely requires a human.
	 */
	resolveOrder?(symbol: MarketSymbol, clientOrderId: string, signal?: AbortSignal): Promise<OrderOutcome | undefined>;
}

/** Status used for an order the exchange confirms never existed. */
export const NOT_PLACED = "NOT_PLACED";

export interface SettledLeg {
	/** Amount of `leg.fromAsset` actually spent. */
	readonly amountIn: Dec;
	/** Amount of `leg.toAsset` actually received, net of commission charged in that asset. */
	readonly amountOut: Dec;
	readonly commissions: readonly { asset: Asset; amount: Dec }[];
	readonly avgPrice: Dec;
}

/**
 * Derives what a leg actually produced from the exchange's fill report.
 *
 * The subtlety that costs money if missed: a spot taker commission is charged in the asset you
 * receive, so the amount available to the next leg is the fill minus commission, not the fill. A
 * cycle sized off gross fills fails its final leg for insufficient balance. When commission was
 * instead debited in BNB it does not reduce the received asset, so it is recorded separately and
 * settled by the ledger rather than subtracted here.
 */
export function settleLeg(leg: CycleLeg, outcome: OrderOutcome): SettledLeg {
	const grossOut = leg.side === "SELL" ? outcome.quoteQty : outcome.executedQty;
	const amountIn = leg.side === "SELL" ? outcome.executedQty : outcome.quoteQty;

	const byAsset = new Map<Asset, Dec>();
	for (const fill of outcome.fills) {
		if (fill.commission === ZERO) continue;
		byAsset.set(fill.commissionAsset, ((byAsset.get(fill.commissionAsset) ?? ZERO) + fill.commission) as Dec);
	}

	const inKind = byAsset.get(leg.toAsset) ?? ZERO;
	const amountOut = decSub(grossOut, inKind);

	return {
		amountIn,
		amountOut: amountOut > ZERO ? amountOut : ZERO,
		commissions: [...byAsset].map(([asset, amount]) => ({ asset, amount })),
		avgPrice: averagePrice(outcome),
	};
}

/** Volume-weighted average fill price, falling back to `quoteQty / executedQty`. */
export function averagePrice(outcome: OrderOutcome): Dec {
	if (outcome.fills.length > 0) {
		const qty = decSum(outcome.fills.map((fill) => fill.qty));
		if (qty > ZERO) {
			return decDiv(decSum(outcome.fills.map((fill) => decMul(fill.price, fill.qty))), qty);
		}
	}
	if (outcome.executedQty > ZERO) return decDiv(outcome.quoteQty, outcome.executedQty);
	return ZERO;
}

let orderCounter = 0;

/**
 * Generates a client order id.
 *
 * Binance accepts `[.A-Za-z0-9_-]{1,36}`. Tagging every order the bot sends makes an orphaned
 * order after a crash identifiable, which matters when reconciling.
 */
export function newClientOrderId(prefix = "arb"): string {
	orderCounter = (orderCounter + 1) % 1_000_000;
	const stamp = Date.now().toString(36);
	const counter = orderCounter.toString(36).padStart(4, "0");
	const noise = Math.floor(Math.random() * 1_679_616)
		.toString(36)
		.padStart(4, "0");
	return `${prefix}-${stamp}-${counter}-${noise}`.slice(0, 36);
}
