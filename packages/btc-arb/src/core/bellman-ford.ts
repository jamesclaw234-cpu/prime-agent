import type { Asset, CycleLeg } from "../types.js";
import type { BookStore } from "./book.js";
import type { MarketGraph } from "./graph.js";
import { edgeRateNum, type FeeModel } from "./pricing.js";

export interface NegativeCycle {
	readonly startAsset: Asset;
	readonly legs: readonly CycleLeg[];
	/** Product of the fee-adjusted leg rates. Greater than 1 is a profit before sizing. */
	readonly multiple: number;
	readonly edgeBps: number;
}

interface WeightedEdge {
	readonly from: number;
	readonly to: number;
	readonly weight: number;
	readonly leg: CycleLeg;
}

export interface SweepOptions {
	readonly maxBookAgeMs: number;
	readonly now: number;
	/** Ignore cycles longer than this many legs; they rarely fill before the edge closes. */
	readonly maxLength: number;
	readonly maxResults: number;
	/** Discard results below this edge, measured before sizing. */
	readonly minEdgeBps: number;
}

/**
 * Background sweep for profitable cycles of any length.
 *
 * Taking `-ln(rate)` turns "product of rates greater than one" into "negative-weight cycle", which
 * Bellman-Ford finds without knowing the cycle's length in advance. The precomputed table in
 * `cycles.ts` handles the hot path because it is O(1) per tick; this runs on a timer to catch the
 * longer loops that table does not enumerate.
 *
 * The float logarithms are for discovery only. Anything found is handed to `planOpportunity`,
 * which re-derives it in exact arithmetic before an order is sent.
 */
export function findNegativeCycles(
	graph: MarketGraph,
	store: BookStore,
	fee: FeeModel,
	options: SweepOptions,
): NegativeCycle[] {
	const assets = graph.assets;
	const indexOf = new Map<Asset, number>();
	for (let i = 0; i < assets.length; i++) indexOf.set(assets[i], i);

	const edges: WeightedEdge[] = [];
	for (const asset of assets) {
		for (const edge of graph.edgesFrom(asset)) {
			const book = store.get(edge.symbol);
			if (!book) continue;
			if (options.now - book.receivedAt > options.maxBookAgeMs) continue;
			const rate = edgeRateNum(book, edge.side, fee.takerMultiplierNum);
			if (!(rate > 0) || !Number.isFinite(rate)) continue;
			const from = indexOf.get(edge.fromAsset);
			const to = indexOf.get(edge.toAsset);
			if (from === undefined || to === undefined) continue;
			edges.push({
				from,
				to,
				weight: -Math.log(rate),
				leg: { symbol: edge.symbol, side: edge.side, fromAsset: edge.fromAsset, toAsset: edge.toAsset },
			});
		}
	}
	if (edges.length === 0) return [];

	const count = assets.length;
	// Every vertex starts at distance zero, equivalent to a virtual source with zero-weight edges to
	// all of them. That surfaces negative cycles anywhere in the graph, not only those reachable
	// from one arbitrary root.
	const distance = new Float64Array(count);
	const predecessorEdge = new Int32Array(count).fill(-1);
	const predecessorNode = new Int32Array(count).fill(-1);

	for (let iteration = 0; iteration < count - 1; iteration++) {
		let relaxed = false;
		for (let e = 0; e < edges.length; e++) {
			const edge = edges[e];
			const candidate = distance[edge.from] + edge.weight;
			// The epsilon stops accumulated float noise from manufacturing a cycle out of a
			// break-even loop, which at three legs of near-1 rates is a real risk.
			if (candidate < distance[edge.to] - 1e-12) {
				distance[edge.to] = candidate;
				predecessorEdge[edge.to] = e;
				predecessorNode[edge.to] = edge.from;
				relaxed = true;
			}
		}
		if (!relaxed) return [];
	}

	// Any vertex still relaxable after |V|-1 passes is reachable from a negative cycle.
	const suspects: number[] = [];
	for (let e = 0; e < edges.length; e++) {
		const edge = edges[e];
		if (distance[edge.from] + edge.weight < distance[edge.to] - 1e-12) {
			predecessorEdge[edge.to] = e;
			predecessorNode[edge.to] = edge.from;
			suspects.push(edge.to);
		}
	}
	if (suspects.length === 0) return [];

	const results: NegativeCycle[] = [];
	const reported = new Set<string>();

	for (const suspect of suspects) {
		if (results.length >= options.maxResults) break;

		// Walking back |V| steps from a relaxable vertex always lands inside the cycle itself.
		let cursor = suspect;
		let derailed = false;
		for (let step = 0; step < count; step++) {
			const previous = predecessorNode[cursor];
			if (previous === -1) {
				derailed = true;
				break;
			}
			cursor = previous;
		}
		if (derailed) continue;

		const legs = extractCycle(cursor, predecessorEdge, predecessorNode, edges, count);
		if (!legs || legs.length < 3 || legs.length > options.maxLength) continue;

		let multiple = 1;
		let valid = true;
		for (const leg of legs) {
			const book = store.get(leg.symbol);
			if (!book) {
				valid = false;
				break;
			}
			multiple *= edgeRateNum(book, leg.side, fee.takerMultiplierNum);
		}
		if (!valid) continue;

		const edgeBps = (multiple - 1) * 10_000;
		if (!(edgeBps >= options.minEdgeBps)) continue;

		const startAsset = legs[0].fromAsset;
		const id = `${startAsset}>${legs.map((leg) => leg.toAsset).join(">")}`;
		if (reported.has(id)) continue;
		reported.add(id);
		results.push({ startAsset, legs, multiple, edgeBps });
	}

	return results;
}

/** Reconstructs the cycle containing `start` by following predecessor edges back to it. */
function extractCycle(
	start: number,
	predecessorEdge: Int32Array,
	predecessorNode: Int32Array,
	edges: readonly WeightedEdge[],
	maxSteps: number,
): CycleLeg[] | undefined {
	const legs: CycleLeg[] = [];
	let walker = start;
	for (let step = 0; step <= maxSteps; step++) {
		const edgeIndex = predecessorEdge[walker];
		if (edgeIndex === -1) return undefined;
		legs.push(edges[edgeIndex].leg);
		walker = predecessorNode[walker];
		if (walker === start) {
			legs.reverse();
			return legs;
		}
	}
	return undefined;
}
