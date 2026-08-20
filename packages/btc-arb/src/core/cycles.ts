import type { Asset, Cycle, CycleLeg, MarketSymbol } from "../types.js";
import type { GraphEdge, MarketGraph } from "./graph.js";

export interface EnumerateOptions {
	/** Assets a cycle may start and end on. Empty means every asset in the graph. */
	readonly startAssets?: readonly Asset[];
	/** Number of legs. 3 is a classic triangle. */
	readonly maxLength: number;
	/** Keep only cycles that pass through this asset. Empty disables the filter. */
	readonly requireAsset?: string;
	/** Safety valve: stop enumerating past this many cycles. */
	readonly maxCycles?: number;
}

function legFromEdge(edge: GraphEdge): CycleLeg {
	return { symbol: edge.symbol, side: edge.side, fromAsset: edge.fromAsset, toAsset: edge.toAsset };
}

function cycleId(startAsset: Asset, legs: readonly CycleLeg[]): string {
	return `${startAsset}>${legs.map((leg) => leg.toAsset).join(">")}`;
}

/**
 * Enumerates every simple conversion cycle up to `maxLength` legs.
 *
 * Done once at startup. The result is a static table: the set of cycles only changes when the
 * exchange lists or delists a market, so the hot path re-prices a fixed list instead of searching.
 *
 * Cycles are enumerated per start asset, which keeps rotations of the same loop distinct. That is
 * deliberate - `USDT>BTC>ETH>USDT` and `BTC>ETH>USDT>BTC` need different inventory and clear
 * different fee hurdles, so they are genuinely different opportunities.
 */
export function enumerateCycles(graph: MarketGraph, options: EnumerateOptions): Cycle[] {
	const maxLength = Math.max(2, options.maxLength);
	const maxCycles = options.maxCycles ?? 200_000;
	const starts = options.startAssets && options.startAssets.length > 0 ? options.startAssets : graph.assets;
	const required = options.requireAsset ?? "";

	const cycles: Cycle[] = [];
	const seen = new Set<string>();

	for (const start of starts) {
		if (!graph.hasAsset(start)) continue;
		const visited = new Set<Asset>([start]);
		const path: CycleLeg[] = [];

		const walk = (current: Asset): void => {
			if (cycles.length >= maxCycles) return;
			const remaining = maxLength - path.length;
			if (remaining <= 0) return;

			for (const edge of graph.edgesFrom(current)) {
				if (cycles.length >= maxCycles) return;

				if (edge.toAsset === start) {
					// A closed loop. Two legs would be a round trip on one market: always a loss.
					if (path.length + 1 < 3) continue;
					path.push(legFromEdge(edge));
					const legs = [...path];
					path.pop();
					if (required && !legs.some((leg) => leg.fromAsset === required || leg.toAsset === required)) {
						continue;
					}
					const id = cycleId(start, legs);
					if (!seen.has(id)) {
						seen.add(id);
						cycles.push({ id, startAsset: start, legs });
					}
					continue;
				}

				if (remaining <= 1) continue;
				if (visited.has(edge.toAsset)) continue;

				visited.add(edge.toAsset);
				path.push(legFromEdge(edge));
				walk(edge.toAsset);
				path.pop();
				visited.delete(edge.toAsset);
			}
		};

		walk(start);
	}

	return cycles;
}

/**
 * Reverse index from market to the cycles that touch it.
 *
 * This is what makes the scan incremental: a `bookTicker` frame for one symbol only invalidates
 * the cycles containing that symbol, so a tick costs work proportional to that symbol's cycle
 * count rather than to the whole cycle table.
 */
export class CycleIndex {
	private readonly bySymbol = new Map<MarketSymbol, Cycle[]>();

	constructor(readonly cycles: readonly Cycle[]) {
		for (const cycle of cycles) {
			// A cycle can touch the same market twice; index it once so it is not re-priced twice.
			const symbols = new Set(cycle.legs.map((leg) => leg.symbol));
			for (const symbol of symbols) {
				const list = this.bySymbol.get(symbol);
				if (list) list.push(cycle);
				else this.bySymbol.set(symbol, [cycle]);
			}
		}
	}

	cyclesFor(symbol: MarketSymbol): readonly Cycle[] {
		return this.bySymbol.get(symbol) ?? [];
	}

	get symbolCount(): number {
		return this.bySymbol.size;
	}

	get size(): number {
		return this.cycles.length;
	}

	/** Markets that appear in at least one cycle. Everything else is not worth subscribing to. */
	usedSymbols(): MarketSymbol[] {
		return [...this.bySymbol.keys()];
	}

	/** Largest number of cycles a single market invalidates - the worst case cost of one tick. */
	maxFanout(): number {
		let max = 0;
		for (const list of this.bySymbol.values()) max = Math.max(max, list.length);
		return max;
	}
}
