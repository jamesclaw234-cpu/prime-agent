import { BookStore, makeBook } from "../src/core/book.js";
import { MarketGraph } from "../src/core/graph.js";
import { makeFeeModel } from "../src/core/pricing.js";
import type { MarketSymbol, SymbolRules } from "../src/types.js";
import { type Dec, decFromString } from "../src/util/decimal.js";

export const d = decFromString;

/**
 * A deliberately round-numbered three-market universe.
 *
 * USDT -> BTC -> ETH -> USDT prices out at exactly 1.2x before fees, which makes every expected
 * value in the tests something a reader can verify by hand rather than by running the code.
 */
export function makeRules(overrides: Partial<SymbolRules> & Pick<SymbolRules, "symbol">): SymbolRules {
	const base: SymbolRules = {
		symbol: overrides.symbol,
		baseAsset: "BTC",
		quoteAsset: "USDT",
		status: "TRADING",
		isSpotTradingAllowed: true,
		orderTypes: ["LIMIT", "MARKET"],
		baseAssetPrecision: 8,
		quoteAssetPrecision: 8,
		tickSize: d("0.01"),
		minPrice: d("0.01"),
		maxPrice: d("1000000"),
		stepSize: d("0.00001"),
		minQty: d("0.00001"),
		maxQty: d("9000"),
		marketStepSize: d("0.00001"),
		marketMinQty: d("0.00001"),
		marketMaxQty: d("9000"),
		minNotional: d("10"),
		maxNotional: d("0"),
		applyMinToMarket: true,
		applyMaxToMarket: false,
		bidMultiplierUp: d("5"),
		bidMultiplierDown: d("0.2"),
		askMultiplierUp: d("5"),
		askMultiplierDown: d("0.2"),
		pricePrecision: 2,
		qtyPrecision: 5,
	};
	return { ...base, ...overrides };
}

export const BTCUSDT = makeRules({ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" });

export const ETHBTC = makeRules({
	symbol: "ETHBTC",
	baseAsset: "ETH",
	quoteAsset: "BTC",
	tickSize: d("0.000001"),
	stepSize: d("0.0001"),
	minQty: d("0.0001"),
	minNotional: d("0.0001"),
	pricePrecision: 6,
	qtyPrecision: 4,
});

export const ETHUSDT = makeRules({
	symbol: "ETHUSDT",
	baseAsset: "ETH",
	quoteAsset: "USDT",
	stepSize: d("0.0001"),
	minQty: d("0.0001"),
	pricePrecision: 2,
	qtyPrecision: 4,
});

export const RULES: ReadonlyMap<MarketSymbol, SymbolRules> = new Map([
	["BTCUSDT", BTCUSDT],
	["ETHBTC", ETHBTC],
	["ETHUSDT", ETHUSDT],
]);

export const GRAPH = new MarketGraph(RULES.values());

export interface Quote {
	readonly bid: string;
	readonly bidQty: string;
	readonly ask: string;
	readonly askQty: string;
}

/** Prices that make the USDT->BTC->ETH->USDT loop worth exactly 1.2x before fees. */
export const PROFITABLE: Record<MarketSymbol, Quote> = {
	BTCUSDT: { bid: "99", bidQty: "10", ask: "100", askQty: "10" },
	ETHBTC: { bid: "0.09", bidQty: "100", ask: "0.1", askQty: "100" },
	ETHUSDT: { bid: "12", bidQty: "100", ask: "13", askQty: "100" },
};

/** The same markets with no exploitable loop in either direction. */
export const FLAT: Record<MarketSymbol, Quote> = {
	BTCUSDT: { bid: "99.9", bidQty: "10", ask: "100", askQty: "10" },
	ETHBTC: { bid: "0.0999", bidQty: "100", ask: "0.1", askQty: "100" },
	ETHUSDT: { bid: "9.99", bidQty: "100", ask: "10", askQty: "100" },
};

export function makeStore(quotes: Record<MarketSymbol, Quote>, at = 1_000_000, now = () => at): BookStore {
	const store = new BookStore(now);
	let updateId = 1;
	for (const [symbol, quote] of Object.entries(quotes)) {
		store.apply(makeBook(symbol, d(quote.bid), d(quote.bidQty), d(quote.ask), d(quote.askQty), updateId++, at));
	}
	return store;
}

export function setQuote(store: BookStore, symbol: MarketSymbol, quote: Quote, at: number, updateId: number): void {
	store.apply(makeBook(symbol, d(quote.bid), d(quote.bidQty), d(quote.ask), d(quote.askQty), updateId, at));
}

export const FEE_10BPS = makeFeeModel(10);
export const FEE_ZERO = makeFeeModel(0);

/** `USDT -> BTC -> ETH -> USDT`, the loop every sizing and execution test uses. */
export const TRIANGLE = {
	id: "USDT>BTC>ETH>USDT",
	startAsset: "USDT",
	legs: [
		{ symbol: "BTCUSDT", side: "BUY" as const, fromAsset: "USDT", toAsset: "BTC" },
		{ symbol: "ETHBTC", side: "BUY" as const, fromAsset: "BTC", toAsset: "ETH" },
		{ symbol: "ETHUSDT", side: "SELL" as const, fromAsset: "ETH", toAsset: "USDT" },
	],
};

export function budget(max: string, min = "10"): { max: Dec; min: Dec } {
	return { max: d(max), min: d(min) };
}
