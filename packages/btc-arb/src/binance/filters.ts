import type { MarketSymbol, OrderSide, SymbolRules } from "../types.js";
import {
	type Dec,
	decCeilToStep,
	decDiv,
	decFloorToStep,
	decFromString,
	decGt,
	decIsOnStep,
	decIsPositive,
	decLt,
	decMul,
	decScaleOf,
	decToFixed,
	ZERO,
} from "../util/decimal.js";
import type { RawExchangeInfo, RawFilter, RawSymbol } from "./types.js";

/**
 * Translation of `exchangeInfo` filters into the constraints an outbound order must satisfy.
 *
 * Getting this wrong is the single most common source of rejected arbitrage legs: a leg rejected
 * for LOT_SIZE after the previous leg already filled leaves the bot holding inventory it did not
 * want, which is strictly worse than never having traded.
 */

function filterField(filter: RawFilter | undefined, key: string): Dec | undefined {
	if (!filter) return undefined;
	const value = filter[key];
	if (typeof value === "string") return decFromString(value);
	if (typeof value === "number") return decFromString(String(value));
	return undefined;
}

function findFilter(filters: readonly RawFilter[], type: string): RawFilter | undefined {
	return filters.find((f) => f.filterType === type);
}

/** Largest of the supplied values, treating absent values as zero. */
function maxOf(...values: (Dec | undefined)[]): Dec {
	let result = ZERO;
	for (const value of values) {
		if (value !== undefined && value > result) result = value;
	}
	return result;
}

export class ExchangeInfoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExchangeInfoError";
	}
}

/**
 * Distils one raw symbol entry into `SymbolRules`.
 *
 * Returns `undefined` for markets that cannot carry a spot arbitrage leg - not `TRADING`, spot
 * trading disabled, or missing the PRICE_FILTER / LOT_SIZE filters we require to size an order.
 */
export function parseSymbolRules(raw: RawSymbol): SymbolRules | undefined {
	if (raw.status !== "TRADING") return undefined;
	if (raw.isSpotTradingAllowed === false) return undefined;
	if (!raw.orderTypes?.includes("LIMIT")) return undefined;

	const priceFilter = findFilter(raw.filters, "PRICE_FILTER");
	const lotSize = findFilter(raw.filters, "LOT_SIZE");
	const tickSize = filterField(priceFilter, "tickSize");
	const stepSize = filterField(lotSize, "stepSize");
	if (!tickSize || !stepSize || !decIsPositive(tickSize) || !decIsPositive(stepSize)) return undefined;

	const marketLotSize = findFilter(raw.filters, "MARKET_LOT_SIZE");
	// NOTIONAL supersedes MIN_NOTIONAL; older symbols may still carry only the latter.
	const notional = findFilter(raw.filters, "NOTIONAL");
	const minNotionalFilter = findFilter(raw.filters, "MIN_NOTIONAL");
	const percentPrice = findFilter(raw.filters, "PERCENT_PRICE_BY_SIDE");

	const marketStep = filterField(marketLotSize, "stepSize");
	const marketStepUsable = marketStep && decIsPositive(marketStep) ? marketStep : stepSize;

	const applyMinToMarket =
		notional?.applyMinToMarket === true || (notional === undefined && minNotionalFilter?.applyToMarket === true);

	return {
		symbol: raw.symbol,
		baseAsset: raw.baseAsset,
		quoteAsset: raw.quoteAsset,
		status: raw.status,
		isSpotTradingAllowed: raw.isSpotTradingAllowed,
		orderTypes: raw.orderTypes ?? [],
		baseAssetPrecision: raw.baseAssetPrecision,
		quoteAssetPrecision: raw.quoteAssetPrecision,

		tickSize,
		minPrice: filterField(priceFilter, "minPrice") ?? ZERO,
		maxPrice: filterField(priceFilter, "maxPrice") ?? ZERO,

		stepSize,
		minQty: filterField(lotSize, "minQty") ?? ZERO,
		maxQty: filterField(lotSize, "maxQty") ?? ZERO,

		marketStepSize: marketStepUsable,
		marketMinQty: filterField(marketLotSize, "minQty") ?? ZERO,
		marketMaxQty: filterField(marketLotSize, "maxQty") ?? ZERO,

		// A symbol can carry both the legacy MIN_NOTIONAL and the newer NOTIONAL. When it does, the
		// binding constraint is the larger of the two minimums, not whichever we happened to read first.
		minNotional: maxOf(filterField(notional, "minNotional"), filterField(minNotionalFilter, "minNotional")),
		maxNotional: filterField(notional, "maxNotional") ?? ZERO,
		applyMinToMarket,
		applyMaxToMarket: notional?.applyMaxToMarket === true,

		bidMultiplierUp: filterField(percentPrice, "bidMultiplierUp") ?? ZERO,
		bidMultiplierDown: filterField(percentPrice, "bidMultiplierDown") ?? ZERO,
		askMultiplierUp: filterField(percentPrice, "askMultiplierUp") ?? ZERO,
		askMultiplierDown: filterField(percentPrice, "askMultiplierDown") ?? ZERO,

		pricePrecision: decScaleOf(tickSize),
		qtyPrecision: decScaleOf(stepSize),
	};
}

/** Builds the tradable symbol table from an `exchangeInfo` payload. */
export function parseExchangeInfo(raw: RawExchangeInfo): Map<MarketSymbol, SymbolRules> {
	if (!Array.isArray(raw?.symbols)) throw new ExchangeInfoError("exchangeInfo payload has no symbols array");
	const table = new Map<MarketSymbol, SymbolRules>();
	for (const entry of raw.symbols) {
		const rules = parseSymbolRules(entry);
		if (rules) table.set(rules.symbol, rules);
	}
	if (table.size === 0) throw new ExchangeInfoError("exchangeInfo contained no tradable spot symbols");
	return table;
}

/** Rounds a price down to the tick grid. Used for SELL limits, where lower is more aggressive. */
export function roundPriceDown(rules: SymbolRules, price: Dec): Dec {
	return decFloorToStep(price, rules.tickSize);
}

/** Rounds a price up to the tick grid. Used for BUY limits, where higher is more aggressive. */
export function roundPriceUp(rules: SymbolRules, price: Dec): Dec {
	return decCeilToStep(price, rules.tickSize);
}

/**
 * Rounds a quantity down to the lot grid.
 *
 * Always down: rounding a quantity up would either exceed the inventory the previous leg produced
 * or breach `maxQty`.
 */
export function roundQtyDown(rules: SymbolRules, qty: Dec): Dec {
	return decFloorToStep(qty, rules.stepSize);
}

/** Formats a price for the wire: plain decimal, exactly as many fraction digits as the tick allows. */
export function formatPrice(rules: SymbolRules, price: Dec): string {
	return decToFixed(price, rules.pricePrecision);
}

/** Formats a quantity for the wire, at the precision the lot step allows. */
export function formatQty(rules: SymbolRules, qty: Dec): string {
	return decToFixed(qty, rules.qtyPrecision);
}

export type FilterRejection =
	| { readonly ok: true }
	| { readonly ok: false; readonly filter: string; readonly detail: string };

const OK: FilterRejection = { ok: true };

function reject(filter: string, detail: string): FilterRejection {
	return { ok: false, filter, detail };
}

/**
 * Checks a limit order against every filter that can reject it.
 *
 * `referencePrice` stands in for the exchange's average price when evaluating
 * PERCENT_PRICE_BY_SIDE. We pass the current touch rather than fetching `avgPrice`, which makes
 * this check approximate but conservative for the few-ticks-through-the-touch prices this bot
 * sends; it is documented as such rather than silently skipped.
 */
export function validateLimitOrder(
	rules: SymbolRules,
	side: OrderSide,
	price: Dec,
	quantity: Dec,
	referencePrice?: Dec,
): FilterRejection {
	if (!decIsPositive(price)) return reject("PRICE_FILTER", "price must be positive");
	if (!decIsPositive(quantity)) return reject("LOT_SIZE", "quantity must be positive");

	if (!decIsOnStep(price, rules.tickSize)) {
		return reject("PRICE_FILTER", `price ${decToFixed(price, 18)} is not a multiple of tickSize`);
	}
	if (decIsPositive(rules.minPrice) && decLt(price, rules.minPrice)) {
		return reject("PRICE_FILTER", "price below minPrice");
	}
	if (decIsPositive(rules.maxPrice) && decGt(price, rules.maxPrice)) {
		return reject("PRICE_FILTER", "price above maxPrice");
	}

	if (!decIsOnStep(quantity, rules.stepSize)) {
		return reject("LOT_SIZE", "quantity is not a multiple of stepSize");
	}
	if (decIsPositive(rules.minQty) && decLt(quantity, rules.minQty)) {
		return reject("LOT_SIZE", "quantity below minQty");
	}
	if (decIsPositive(rules.maxQty) && decGt(quantity, rules.maxQty)) {
		return reject("LOT_SIZE", "quantity above maxQty");
	}

	const notionalValue = decMul(price, quantity);
	if (decIsPositive(rules.minNotional) && decLt(notionalValue, rules.minNotional)) {
		return reject("NOTIONAL", "notional below minNotional");
	}
	if (decIsPositive(rules.maxNotional) && decGt(notionalValue, rules.maxNotional)) {
		return reject("NOTIONAL", "notional above maxNotional");
	}

	if (referencePrice && decIsPositive(referencePrice)) {
		const up = side === "BUY" ? rules.bidMultiplierUp : rules.askMultiplierUp;
		const down = side === "BUY" ? rules.bidMultiplierDown : rules.askMultiplierDown;
		if (decIsPositive(up) && decGt(price, decMul(referencePrice, up))) {
			return reject("PERCENT_PRICE_BY_SIDE", "price above the side multiplier ceiling");
		}
		if (decIsPositive(down) && decLt(price, decMul(referencePrice, down))) {
			return reject("PERCENT_PRICE_BY_SIDE", "price below the side multiplier floor");
		}
	}

	return OK;
}

/**
 * Largest quantity at `price` that still satisfies LOT_SIZE and the NOTIONAL ceiling.
 *
 * Returns zero when no compliant quantity exists at that price.
 */
export function maxCompliantQty(rules: SymbolRules, price: Dec, desired: Dec): Dec {
	let qty = roundQtyDown(rules, desired);
	if (decIsPositive(rules.maxQty) && decGt(qty, rules.maxQty)) {
		qty = roundQtyDown(rules, rules.maxQty);
	}
	if (decIsPositive(rules.maxNotional) && decIsPositive(price)) {
		const byNotional = roundQtyDown(rules, decDiv(rules.maxNotional, price));
		if (decGt(qty, byNotional)) qty = byNotional;
	}
	return qty;
}
