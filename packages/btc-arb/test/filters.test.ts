import { describe, expect, it } from "vitest";
import {
	ExchangeInfoError,
	formatPrice,
	formatQty,
	maxCompliantQty,
	parseExchangeInfo,
	parseSymbolRules,
	roundPriceDown,
	roundPriceUp,
	roundQtyDown,
	validateLimitOrder,
} from "../src/binance/filters.js";
import type { RawExchangeInfo, RawSymbol } from "../src/binance/types.js";
import { doctorProbePrice } from "../src/cli.js";
import { decToNumber, decToString, ZERO } from "../src/util/decimal.js";
import { BTCUSDT, d, makeRules } from "./fixtures.js";

/** Shaped exactly like a real `exchangeInfo` entry, including the filters we must honour. */
function rawSymbol(overrides: Partial<RawSymbol> = {}): RawSymbol {
	return {
		symbol: "BTCUSDT",
		status: "TRADING",
		baseAsset: "BTC",
		baseAssetPrecision: 8,
		quoteAsset: "USDT",
		quotePrecision: 8,
		quoteAssetPrecision: 8,
		orderTypes: ["LIMIT", "LIMIT_MAKER", "MARKET", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"],
		icebergAllowed: true,
		ocoAllowed: true,
		quoteOrderQtyMarketAllowed: true,
		isSpotTradingAllowed: true,
		isMarginTradingAllowed: true,
		permissionSets: [["SPOT", "MARGIN"]],
		filters: [
			{ filterType: "PRICE_FILTER", minPrice: "0.01000000", maxPrice: "1000000.00000000", tickSize: "0.01000000" },
			{ filterType: "LOT_SIZE", minQty: "0.00001000", maxQty: "9000.00000000", stepSize: "0.00001000" },
			{ filterType: "MARKET_LOT_SIZE", minQty: "0.00000000", maxQty: "100.00000000", stepSize: "0.00000000" },
			{
				filterType: "NOTIONAL",
				minNotional: "5.00000000",
				applyMinToMarket: true,
				maxNotional: "9000000.00000000",
				applyMaxToMarket: false,
				avgPriceMins: 5,
			},
			{
				filterType: "PERCENT_PRICE_BY_SIDE",
				bidMultiplierUp: "5",
				bidMultiplierDown: "0.2",
				askMultiplierUp: "5",
				askMultiplierDown: "0.2",
				avgPriceMins: 5,
			},
			{ filterType: "MAX_NUM_ORDERS", maxNumOrders: 200 },
		],
		...overrides,
	};
}

describe("exchangeInfo parsing", () => {
	it("distils the filters a limit order must satisfy", () => {
		const rules = parseSymbolRules(rawSymbol());
		expect(rules).toBeDefined();
		if (!rules) return;
		expect(decToString(rules.tickSize)).toBe("0.01");
		expect(decToString(rules.stepSize)).toBe("0.00001");
		expect(decToString(rules.minNotional)).toBe("5");
		expect(decToString(rules.maxNotional)).toBe("9000000");
		expect(rules.pricePrecision).toBe(2);
		expect(rules.qtyPrecision).toBe(5);
		expect(decToString(rules.bidMultiplierUp)).toBe("5");
	});

	it("falls back to LOT_SIZE when MARKET_LOT_SIZE carries a zero step", () => {
		const rules = parseSymbolRules(rawSymbol());
		expect(decToString(rules?.marketStepSize ?? ZERO)).toBe("0.00001");
	});

	it("reads the legacy MIN_NOTIONAL filter when NOTIONAL is absent", () => {
		const legacy = rawSymbol({
			filters: [
				{ filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000", tickSize: "0.01" },
				{ filterType: "LOT_SIZE", minQty: "0.001", maxQty: "900", stepSize: "0.001" },
				{ filterType: "MIN_NOTIONAL", minNotional: "10.00000000", applyToMarket: true, avgPriceMins: 5 },
			],
		});
		const rules = parseSymbolRules(legacy);
		expect(decToString(rules?.minNotional ?? ZERO)).toBe("10");
		expect(rules?.applyMinToMarket).toBe(true);
		expect(decToString(rules?.maxNotional ?? ZERO)).toBe("0");
	});

	it("takes the larger minimum when both MIN_NOTIONAL and NOTIONAL are present", () => {
		const both = rawSymbol({
			filters: [
				{ filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000", tickSize: "0.01" },
				{ filterType: "LOT_SIZE", minQty: "0.001", maxQty: "900", stepSize: "0.001" },
				{ filterType: "MIN_NOTIONAL", minNotional: "10.00000000", applyToMarket: true, avgPriceMins: 5 },
				{ filterType: "NOTIONAL", minNotional: "5.00000000", applyMinToMarket: true, maxNotional: "900000" },
			],
		});
		expect(decToString(parseSymbolRules(both)?.minNotional ?? ZERO)).toBe("10");
	});

	it("skips markets that cannot carry a spot leg", () => {
		expect(parseSymbolRules(rawSymbol({ status: "BREAK" }))).toBeUndefined();
		expect(parseSymbolRules(rawSymbol({ status: "HALT" }))).toBeUndefined();
		expect(parseSymbolRules(rawSymbol({ status: "END_OF_DAY" }))).toBeUndefined();
		// CANCEL_ONLY permits cancels but not new orders, so it is not tradable for us.
		expect(parseSymbolRules(rawSymbol({ status: "CANCEL_ONLY" }))).toBeUndefined();
		expect(parseSymbolRules(rawSymbol({ isSpotTradingAllowed: false }))).toBeUndefined();
		expect(parseSymbolRules(rawSymbol({ orderTypes: ["MARKET"] }))).toBeUndefined();
		expect(parseSymbolRules(rawSymbol({ filters: [] }))).toBeUndefined();
	});

	it("builds a table and rejects an empty one", () => {
		const info: RawExchangeInfo = {
			timezone: "UTC",
			serverTime: 1,
			rateLimits: [],
			exchangeFilters: [],
			symbols: [rawSymbol(), rawSymbol({ symbol: "ETHUSDT", baseAsset: "ETH" }), rawSymbol({ status: "BREAK" })],
		};
		const table = parseExchangeInfo(info);
		expect([...table.keys()].sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
		expect(() => parseExchangeInfo({ ...info, symbols: [] })).toThrow(ExchangeInfoError);
	});
});

describe("rounding", () => {
	it("rounds a buy price up and a sell price down", () => {
		expect(decToString(roundPriceUp(BTCUSDT, d("100.005")))).toBe("100.01");
		expect(decToString(roundPriceDown(BTCUSDT, d("100.005")))).toBe("100");
	});

	it("always rounds quantity down", () => {
		expect(decToString(roundQtyDown(BTCUSDT, d("1.234569")))).toBe("1.23456");
		expect(decToString(roundQtyDown(BTCUSDT, d("0.000009")))).toBe("0");
	});

	it("formats at exactly the precision the filter allows", () => {
		expect(formatPrice(BTCUSDT, d("100"))).toBe("100.00");
		expect(formatQty(BTCUSDT, d("0.5"))).toBe("0.50000");
		// The classic failure: 1e-7 sent as scientific notation.
		expect(formatQty({ ...BTCUSDT, qtyPrecision: 8 }, d("0.0000001"))).toBe("0.00000010");
	});
});

describe("order validation", () => {
	it("accepts an order on the grid and above the minimum", () => {
		expect(validateLimitOrder(BTCUSDT, "BUY", d("100"), d("1"), d("100")).ok).toBe(true);
	});

	it("rejects a price off the tick grid", () => {
		const result = validateLimitOrder(BTCUSDT, "BUY", d("100.005"), d("1"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.filter).toBe("PRICE_FILTER");
	});

	it("rejects a quantity off the lot grid or below the minimum", () => {
		expect(validateLimitOrder(BTCUSDT, "BUY", d("100"), d("1.000001")).ok).toBe(false);
		expect(validateLimitOrder(BTCUSDT, "BUY", d("100"), d("0.000001")).ok).toBe(false);
		expect(validateLimitOrder(BTCUSDT, "BUY", d("100"), d("100000")).ok).toBe(false);
	});

	it("rejects a notional below the exchange minimum", () => {
		const result = validateLimitOrder(BTCUSDT, "BUY", d("100"), d("0.05"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.filter).toBe("NOTIONAL");
	});

	it("applies the side-specific percent-price bounds", () => {
		const tooHigh = validateLimitOrder(BTCUSDT, "BUY", d("600"), d("1"), d("100"));
		expect(tooHigh.ok).toBe(false);
		if (!tooHigh.ok) expect(tooHigh.filter).toBe("PERCENT_PRICE_BY_SIDE");

		const tooLow = validateLimitOrder(BTCUSDT, "SELL", d("10"), d("1"), d("100"));
		expect(tooLow.ok).toBe(false);

		// Without a reference price the multiplier check is skipped rather than guessed at.
		expect(validateLimitOrder(BTCUSDT, "BUY", d("600"), d("1")).ok).toBe(true);
	});

	it("rejects non-positive inputs", () => {
		expect(validateLimitOrder(BTCUSDT, "BUY", d("0"), d("1")).ok).toBe(false);
		expect(validateLimitOrder(BTCUSDT, "BUY", d("100"), d("0")).ok).toBe(false);
	});
});

describe("maxCompliantQty", () => {
	it("caps by the notional ceiling", () => {
		const capped = { ...BTCUSDT, maxNotional: d("1000") };
		expect(decToNumber(maxCompliantQty(capped, d("100"), d("50")))).toBeCloseTo(10, 6);
	});

	it("caps by maxQty", () => {
		const capped = { ...BTCUSDT, maxQty: d("2") };
		expect(decToString(maxCompliantQty(capped, d("100"), d("50")))).toBe("2");
	});

	it("passes a compliant quantity through unchanged", () => {
		expect(decToString(maxCompliantQty(BTCUSDT, d("100"), d("1.5")))).toBe("1.5");
	});
});

describe("doctor probe price", () => {
	/**
	 * Regression: the probe priced at bid*0.7 unconditionally, and the universe ranking makes a
	 * stablecoin bridge the LIKELY probe target. Real USDTUSD carries PRICE_FILTER minPrice 0.80
	 * and PERCENT_PRICE_BY_SIDE bidMultiplierDown 0.8, so the unclamped probe drew -1013 from the
	 * exchange and `doctor` reported FAIL on a perfectly healthy account and key.
	 */
	const stablePair = makeRules({
		symbol: "USDTUSD",
		baseAsset: "USDT",
		quoteAsset: "USD",
		tickSize: d("0.0001"),
		minPrice: d("0.8"),
		bidMultiplierDown: d("0.8"),
		pricePrecision: 4,
	});

	it("clamps above a tight-band symbol's floors while staying below the touch", () => {
		const bid = d("0.9996");
		const price = doctorProbePrice(stablePair, bid);
		// Above both floors, with the 2% margin over the percent band...
		expect(decToNumber(price)).toBeGreaterThanOrEqual(0.8);
		expect(decToNumber(price)).toBeGreaterThanOrEqual(0.9996 * 0.8 * 1.02);
		// ...but still below the bid, so the probe cannot cross even if placed by mistake.
		expect(decToNumber(price)).toBeLessThan(0.9996);
		// And it passes the same validator the executor uses.
		const check = validateLimitOrder(stablePair, "BUY", price, d("20"), bid);
		expect(check.ok).toBe(true);
	});

	it("keeps the plain bid*0.7 for symbols with the default wide bands", () => {
		const price = doctorProbePrice(BTCUSDT, d("100000"));
		expect(decToNumber(price)).toBeCloseTo(70_000, 0);
	});
});
