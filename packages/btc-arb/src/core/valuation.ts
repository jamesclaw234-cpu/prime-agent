import type { Asset } from "../types.js";
import { type Dec, decDiv, decIsPositive, decMul, ONE } from "../util/decimal.js";
import type { BookStore } from "./book.js";
import type { MarketGraph } from "./graph.js";

/**
 * Converts amounts between assets for risk limits and PnL reporting.
 *
 * Marks are deliberately conservative - an asset is valued at the price you would actually receive
 * for selling it (the bid), never the mid. A limit expressed in USDT should bind on the amount you
 * could realise, not on an optimistic mark.
 */
export class Valuation {
	constructor(
		private readonly store: BookStore,
		private readonly graph: MarketGraph,
		private readonly accountingAsset: Asset,
		/** Assets tried as an intermediate hop when no direct market exists. */
		private readonly bridges: readonly Asset[] = ["USDT", "BTC", "BNB", "ETH"],
	) {}

	/** Units of the accounting asset obtainable per unit of `asset`, or `undefined` if unknown. */
	rate(asset: Asset): Dec | undefined {
		if (asset === this.accountingAsset) return ONE;
		const direct = this.directRate(asset, this.accountingAsset);
		if (direct) return direct;

		for (const bridge of this.bridges) {
			if (bridge === asset || bridge === this.accountingAsset) continue;
			const first = this.directRate(asset, bridge);
			if (!first) continue;
			const second = this.directRate(bridge, this.accountingAsset);
			if (!second) continue;
			return decMul(first, second);
		}
		return undefined;
	}

	private directRate(from: Asset, to: Asset): Dec | undefined {
		for (const edge of this.graph.edgesFrom(from)) {
			if (edge.toAsset !== to) continue;
			const book = this.store.get(edge.symbol);
			if (!book) continue;
			// SELL realises the bid; BUY of `to` with `from` realises 1/ask.
			const rate = edge.side === "SELL" ? book.bid : decDiv(ONE, book.ask);
			if (decIsPositive(rate)) return rate;
		}
		return undefined;
	}

	/** Converts `amount` of `asset` into the accounting asset. */
	convert(amount: Dec, asset: Asset): Dec | undefined {
		const rate = this.rate(asset);
		return rate === undefined ? undefined : decMul(amount, rate);
	}

	/** Converts `amount` of the accounting asset into `asset`. */
	convertFrom(amount: Dec, asset: Asset): Dec | undefined {
		const rate = this.rate(asset);
		if (rate === undefined || !decIsPositive(rate)) return undefined;
		return decDiv(amount, rate);
	}
}
