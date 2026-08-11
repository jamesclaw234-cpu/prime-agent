import type { Asset, MarketSymbol, OrderSide, SymbolRules } from "../types.js";

/**
 * A directed conversion available on one market.
 *
 * Every spot market yields exactly two edges: selling the base into the bid, and buying the base
 * off the ask. Modelling both explicitly means the cycle search never has to reason about which
 * side of a pair it is on.
 */
export interface GraphEdge {
	readonly symbol: MarketSymbol;
	readonly side: OrderSide;
	readonly fromAsset: Asset;
	readonly toAsset: Asset;
	readonly rules: SymbolRules;
}

export interface UniverseFilter {
	readonly quoteAssets?: readonly string[];
	readonly baseAssets?: readonly string[];
	readonly excludeAssets?: readonly string[];
	readonly excludeSymbols?: readonly string[];
	readonly maxSymbols?: number;
}

/** Directed multigraph over assets, built from the tradable symbol table. */
export class MarketGraph {
	private readonly outgoing = new Map<Asset, GraphEdge[]>();
	private readonly bySymbol = new Map<MarketSymbol, GraphEdge[]>();
	private readonly assetSet = new Set<Asset>();

	constructor(rules: Iterable<SymbolRules>) {
		for (const rule of rules) {
			const sell: GraphEdge = {
				symbol: rule.symbol,
				side: "SELL",
				fromAsset: rule.baseAsset,
				toAsset: rule.quoteAsset,
				rules: rule,
			};
			const buy: GraphEdge = {
				symbol: rule.symbol,
				side: "BUY",
				fromAsset: rule.quoteAsset,
				toAsset: rule.baseAsset,
				rules: rule,
			};
			this.addEdge(sell);
			this.addEdge(buy);
		}
	}

	private addEdge(edge: GraphEdge): void {
		const list = this.outgoing.get(edge.fromAsset);
		if (list) list.push(edge);
		else this.outgoing.set(edge.fromAsset, [edge]);

		const symbolList = this.bySymbol.get(edge.symbol);
		if (symbolList) symbolList.push(edge);
		else this.bySymbol.set(edge.symbol, [edge]);

		this.assetSet.add(edge.fromAsset);
		this.assetSet.add(edge.toAsset);
	}

	get assets(): Asset[] {
		return [...this.assetSet];
	}

	get symbolCount(): number {
		return this.bySymbol.size;
	}

	get symbols(): MarketSymbol[] {
		return [...this.bySymbol.keys()];
	}

	edgesFrom(asset: Asset): readonly GraphEdge[] {
		return this.outgoing.get(asset) ?? [];
	}

	edgesForSymbol(symbol: MarketSymbol): readonly GraphEdge[] {
		return this.bySymbol.get(symbol) ?? [];
	}

	hasAsset(asset: Asset): boolean {
		return this.assetSet.has(asset);
	}
}

/**
 * Selects the markets the bot will subscribe to and trade.
 *
 * Restricting the universe is not just a performance concern: illiquid markets show wide,
 * frequently crossed top-of-book quotes that generate a stream of apparent arbitrage which cannot
 * actually be filled, so a smaller universe of liquid markets detects fewer and better signals.
 */
export function selectUniverse(
	rules: Iterable<SymbolRules>,
	filter: UniverseFilter,
): { selected: SymbolRules[]; rejected: Map<MarketSymbol, string>; capped: boolean } {
	const quoteAssets = filter.quoteAssets && filter.quoteAssets.length > 0 ? new Set(filter.quoteAssets) : undefined;
	const baseAssets = filter.baseAssets && filter.baseAssets.length > 0 ? new Set(filter.baseAssets) : undefined;
	const excludeAssets = new Set(filter.excludeAssets ?? []);
	const excludeSymbols = new Set(filter.excludeSymbols ?? []);

	const selected: SymbolRules[] = [];
	const rejected = new Map<MarketSymbol, string>();

	for (const rule of rules) {
		if (excludeSymbols.has(rule.symbol)) {
			rejected.set(rule.symbol, "symbol excluded");
			continue;
		}
		if (excludeAssets.has(rule.baseAsset) || excludeAssets.has(rule.quoteAsset)) {
			rejected.set(rule.symbol, "asset excluded");
			continue;
		}
		if (quoteAssets && !quoteAssets.has(rule.quoteAsset)) {
			rejected.set(rule.symbol, "quote asset not in universe");
			continue;
		}
		if (baseAssets && !baseAssets.has(rule.baseAsset) && !quoteAssets?.has(rule.baseAsset)) {
			rejected.set(rule.symbol, "base asset not in universe");
			continue;
		}
		selected.push(rule);
	}

	// Ordered by how connected each market's assets are, then by symbol for determinism.
	//
	// The cap has to drop *something*, and alphabetical order made that choice arbitrary in a way
	// that turned out to be actively harmful: on a USD/USDT venue the bridge markets are USDCUSD,
	// USDCUSDT and USDTUSD, which sort to the very end of the alphabet and were the first to be
	// cut. Those are the markets that make stablecoin cycles exist at all, so a binding cap deleted
	// precisely the routes most worth watching and left a table of leaf pairs.
	//
	// Ranked by the *less* connected of a market's two assets, not by the sum. To sit on a cycle you
	// must be able to leave whatever you arrive at, so an asset that appears in only one market is a
	// dead end however famous its counterpart is. Summing would score every leaf pair quoted in USD
	// as highly as the USD bridge itself, since both inherit the hub's degree.
	const degree = new Map<Asset, number>();
	for (const rule of selected) {
		degree.set(rule.baseAsset, (degree.get(rule.baseAsset) ?? 0) + 1);
		degree.set(rule.quoteAsset, (degree.get(rule.quoteAsset) ?? 0) + 1);
	}
	const score = (rule: SymbolRules): [number, number] => {
		const base = degree.get(rule.baseAsset) ?? 0;
		const quote = degree.get(rule.quoteAsset) ?? 0;
		return [Math.min(base, quote), base + quote];
	};
	selected.sort((a, b) => {
		const [aMin, aSum] = score(a);
		const [bMin, bSum] = score(b);
		return bMin - aMin || bSum - aSum || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
	});

	const max = filter.maxSymbols ?? Number.POSITIVE_INFINITY;
	if (selected.length > max) {
		for (const rule of selected.slice(max)) rejected.set(rule.symbol, "over maxSymbols cap");
		return { selected: selected.slice(0, max), rejected, capped: true };
	}
	return { selected, rejected, capped: false };
}

/**
 * Drops markets whose assets cannot participate in any cycle.
 *
 * An asset reachable by only one market is a dead end: you can enter it but never leave except by
 * reversing the same trade, which is a guaranteed loss of two taker fees. Subscribing to those
 * markets wastes stream slots and CPU.
 */
export function pruneDeadEnds(rules: readonly SymbolRules[]): SymbolRules[] {
	let current = [...rules];
	for (;;) {
		const degree = new Map<Asset, number>();
		for (const rule of current) {
			degree.set(rule.baseAsset, (degree.get(rule.baseAsset) ?? 0) + 1);
			degree.set(rule.quoteAsset, (degree.get(rule.quoteAsset) ?? 0) + 1);
		}
		const next = current.filter(
			(rule) => (degree.get(rule.baseAsset) ?? 0) >= 2 && (degree.get(rule.quoteAsset) ?? 0) >= 2,
		);
		if (next.length === current.length) return next;
		current = next;
	}
}
