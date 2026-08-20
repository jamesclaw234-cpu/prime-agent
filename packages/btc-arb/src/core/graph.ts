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

	// Deterministic ordering for the uncapped case and inside groups below.
	selected.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

	const max = filter.maxSymbols ?? Number.POSITIVE_INFINITY;
	if (selected.length <= max) return { selected, rejected, capped: false };

	// The cap has to drop something, and two earlier orderings both failed at this in ways that
	// only showed up against a real venue. Alphabetical truncation deleted USDCUSD/USDCUSDT/USDTUSD
	// - the bridge markets that make stablecoin cycles exist - because they sort last. Per-market
	// connectivity ranking then failed one step later: every dual-quoted asset's markets tie on the
	// connectivity score, the tiebreak groups them BY QUOTE rather than by asset, and a cap landing
	// inside a block keeps one leg of each asset's pair. A single kept leg makes its base asset
	// degree-1, dead-end pruning deletes it, and the slot is wasted - in a two-quote universe that
	// pruned the ENTIRE selection to zero cycles.
	//
	// The invariant a cap must preserve is therefore about ASSETS, not markets: keep either enough
	// of an asset's markets to leave it again, or none of them. So markets between two quote assets
	// (the hubs - few, and the reason cycles exist) are admitted first, and everything else is
	// admitted as whole per-base-asset groups, first-fit by how many quotes the asset trades
	// against. A group that does not fit is skipped in favour of smaller ones that do.
	const quoteSet = new Set<Asset>();
	for (const rule of selected) quoteSet.add(rule.quoteAsset);

	const bridges: SymbolRules[] = [];
	const groups = new Map<Asset, SymbolRules[]>();
	for (const rule of selected) {
		if (quoteSet.has(rule.baseAsset)) {
			bridges.push(rule);
		} else {
			const group = groups.get(rule.baseAsset);
			if (group) group.push(rule);
			else groups.set(rule.baseAsset, [rule]);
		}
	}

	const kept: SymbolRules[] = bridges.slice(0, max);
	const ranked = [...groups.values()].sort(
		(a, b) => b.length - a.length || (a[0].baseAsset < b[0].baseAsset ? -1 : 1),
	);
	// Multi-market groups first: a single-market asset is a guaranteed dead end, so those fill any
	// slots left over rather than displacing assets that can actually sit on a cycle.
	for (const wave of [ranked.filter((g) => g.length > 1), ranked.filter((g) => g.length === 1)]) {
		for (const group of wave) {
			if (kept.length + group.length > max) continue;
			kept.push(...group);
		}
	}

	const keptSymbols = new Set(kept.map((rule) => rule.symbol));
	for (const rule of selected) {
		if (!keptSymbols.has(rule.symbol)) rejected.set(rule.symbol, "over maxSymbols cap");
	}
	kept.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
	return { selected: kept, rejected, capped: true };
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
