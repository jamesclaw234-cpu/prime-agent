import type { Cycle, MarketSymbol, Opportunity, SymbolRules } from "../types.js";
import type { Dec } from "../util/decimal.js";
import { type Logger, silentLogger } from "../util/logger.js";
import type { BookStore } from "./book.js";
import type { CycleIndex } from "./cycles.js";
import type { FeeModel } from "./pricing.js";
import { quoteCycle } from "./pricing.js";
import { planOpportunity, type SizingInputs, type SizingRejection } from "./sizing.js";
import type { Valuation } from "./valuation.js";

/**
 * Every reason a screened cycle can be turned down, as a bounded set of stable keys.
 *
 * `no_budget` is the detector's own: the start asset has no spendable balance, which is decided
 * before sizing is even attempted.
 */
export type RejectionCode = SizingRejection | "no_budget";

export interface DetectorOptions {
	readonly store: BookStore;
	readonly index: CycleIndex;
	readonly rules: ReadonlyMap<MarketSymbol, SymbolRules>;
	readonly fee: FeeModel;
	readonly valuation?: Valuation;
	readonly logger?: Logger;
	readonly now?: () => number;

	readonly minNetEdgeBps: number;
	/** How far below `minNetEdgeBps` the float screen fires. Wider means fewer missed candidates. */
	readonly screenMarginBps: number;
	readonly maxBookAgeMs: number;
	readonly depthUtilization: number;
	readonly aggressionTicks: number;
	readonly requireNonNegativeWorstCase: boolean;
	/** Log any cycle whose screened edge clears this, even when it is later rejected. Zero disables. */
	readonly logEdgeBps: number;

	/** Supplies the spend cap for leg 1, in units of the cycle's start asset. */
	readonly inputBudget: (startAsset: string) => { max: Dec; min: Dec } | undefined;
	readonly onOpportunity: (opportunity: Opportunity, worstCaseEdgeBps: number) => void;
	readonly onRejected?: (cycle: Cycle, screenedEdgeBps: number, code: RejectionCode, reason: string) => void;
}

export interface DetectorStats {
	readonly ticks: number;
	readonly cyclesScreened: number;
	/** Evaluations that produced a price. The rest hit a stale or missing book and told us nothing. */
	readonly quotesPriced: number;
	readonly staleSkips: number;
	readonly screenPasses: number;
	readonly planned: number;
	readonly rejected: number;
	readonly lastScreenPassAt: number;
	readonly rejectionsByReason: Readonly<Record<string, number>>;
	/** Best net edge actually observed, in bps. `undefined` when nothing was ever priced. */
	readonly bestEdgeBps?: number;
	/** When that best edge was seen. A long run needs to know *when*, not only how much. */
	readonly bestEdgeAt?: number;
	/** Best edge seen per cycle, so a venue with one promising loop is not averaged into nothing. */
	readonly bestByCycle: Readonly<Record<string, number>>;
	/** Counts of priced edges by bps band, for seeing how far away the market actually is. */
	readonly edgeHistogram: Readonly<Record<string, number>>;
}

/**
 * Upper bounds of the edge bands reported by `stats()`.
 *
 * A run that finds nothing is the common case, and "nothing" is not one outcome: edges clustered
 * at 5bps mean a faster host or a better fee tier could change the answer, while edges at -40bps
 * mean no amount of tuning will. Without this the two are the same zero.
 */
const EDGE_BANDS: readonly number[] = [-100, -50, -20, -10, -5, -2, -1, 0, 1, 2, 4, 6, 8];

function bandLabel(index: number): string {
	if (index === 0) return `<${EDGE_BANDS[0]}`;
	if (index === EDGE_BANDS.length) return `>=${EDGE_BANDS[EDGE_BANDS.length - 1]}`;
	return `${EDGE_BANDS[index - 1]}..${EDGE_BANDS[index]}`;
}

/**
 * Turns book updates into executable opportunities.
 *
 * Every incoming tick re-prices only the cycles that touch the updated market, using the float
 * screen. The screen fires a little below the real threshold so that rounding in the fast path can
 * never hide a candidate that exact arithmetic would have accepted; everything that fires is then
 * re-derived exactly by `planOpportunity`, which rejects the large majority of them.
 */
export class Detector {
	private readonly logger: Logger;
	private readonly now: () => number;
	private readonly screenThresholdBps: number;
	private ticks = 0;
	private cyclesScreened = 0;
	private screenPasses = 0;
	private planned = 0;
	private rejected = 0;
	private lastScreenPassAt = 0;
	private quotesPriced = 0;
	private staleSkips = 0;
	private bestEdgeBps = Number.NEGATIVE_INFINITY;
	private bestEdgeAt = 0;
	private readonly rejectionsByReason = new Map<string, number>();
	// Both are bounded by the cycle table, which is enumerated once at startup, and by a fixed band
	// count - neither can grow without limit over a 24/7 run.
	private readonly bestByCycle = new Map<string, number>();
	private readonly edgeBands = new Float64Array(EDGE_BANDS.length + 1);

	constructor(private readonly options: DetectorOptions) {
		this.logger = options.logger ?? silentLogger();
		this.now = options.now ?? Date.now;
		this.screenThresholdBps = options.minNetEdgeBps - options.screenMarginBps;
	}

	/** Re-prices every cycle touching `symbol`. Called once per book frame. */
	onBookUpdate(symbol: MarketSymbol): void {
		this.ticks++;
		const cycles = this.options.index.cyclesFor(symbol);
		if (cycles.length === 0) return;
		const now = this.now();
		for (const cycle of cycles) this.evaluate(cycle, now);
	}

	/** Re-prices the whole table. Used on startup and by the `scan` command. */
	scanAll(): void {
		const now = this.now();
		for (const cycle of this.options.index.cycles) this.evaluate(cycle, now);
	}

	/** Prices a specific cycle without going through the screen. Used by the Bellman-Ford sweep. */
	evaluateDirect(cycle: Cycle): void {
		this.evaluate(cycle, this.now(), true);
	}

	private evaluate(cycle: Cycle, now: number, skipScreen = false): void {
		this.cyclesScreened++;
		const quote = quoteCycle(cycle, this.options.store, this.options.fee, now, this.options.maxBookAgeMs);
		if (!quote) {
			// No price at all - a book was missing or older than `maxBookAgeMs`. Counting this as
			// "screened and found nothing" would read as an absent edge when it is absent data.
			this.staleSkips++;
			return;
		}
		this.quotesPriced++;
		this.observeEdge(cycle, quote.edgeBps);
		if (!skipScreen && quote.edgeBps < this.screenThresholdBps) return;

		this.screenPasses++;
		this.lastScreenPassAt = now;

		const budget = this.options.inputBudget(cycle.startAsset);
		if (!budget) {
			this.recordRejection(cycle, quote.edgeBps, "no_budget", "no budget for the start asset");
			return;
		}

		const inputs: SizingInputs = {
			cycle,
			store: this.options.store,
			rules: this.options.rules,
			fee: this.options.fee,
			depthUtilization: this.options.depthUtilization,
			aggressionTicks: this.options.aggressionTicks,
			maxInput: budget.max,
			minInput: budget.min,
			minNetEdgeBps: this.options.minNetEdgeBps,
			requireNonNegativeWorstCase: this.options.requireNonNegativeWorstCase,
			now,
			maxBookAgeMs: this.options.maxBookAgeMs,
			valuation: this.options.valuation,
		};

		const result = planOpportunity(inputs);
		if (!result.ok) {
			this.recordRejection(cycle, quote.edgeBps, result.code, result.reason);
			return;
		}

		this.planned++;
		if (this.options.logEdgeBps > 0 && quote.edgeBps >= this.options.logEdgeBps) {
			this.logger.info("opportunity", {
				cycle: cycle.id,
				screenedBps: round2(quote.edgeBps),
				netBps: round2(result.opportunity.netEdgeBps),
				worstBps: round2(result.worstCaseEdgeBps),
				bookAgeMs: Math.round(quote.maxBookAgeMs),
			});
		}
		this.options.onOpportunity(result.opportunity, result.worstCaseEdgeBps);
	}

	/** Records where a priced edge landed, whether or not it was anywhere near tradable. */
	private observeEdge(cycle: Cycle, edgeBps: number): void {
		if (!Number.isFinite(edgeBps)) return;
		if (edgeBps > this.bestEdgeBps) {
			this.bestEdgeBps = edgeBps;
			this.bestEdgeAt = this.now();
		}
		const previous = this.bestByCycle.get(cycle.id);
		if (previous === undefined || edgeBps > previous) this.bestByCycle.set(cycle.id, edgeBps);

		let band = EDGE_BANDS.length;
		for (let i = 0; i < EDGE_BANDS.length; i++) {
			if (edgeBps < EDGE_BANDS[i]) {
				band = i;
				break;
			}
		}
		this.edgeBands[band]++;
	}

	private recordRejection(cycle: Cycle, screenedEdgeBps: number, code: RejectionCode, reason: string): void {
		this.rejected++;
		// Grouped on the stable code, never on the message: the message embeds live numbers, so
		// using it as a key would grow this map without bound over a 24/7 run.
		this.rejectionsByReason.set(code, (this.rejectionsByReason.get(code) ?? 0) + 1);
		if (this.options.logEdgeBps > 0 && screenedEdgeBps >= this.options.logEdgeBps) {
			this.logger.debug("opportunity rejected", {
				cycle: cycle.id,
				screenedBps: round2(screenedEdgeBps),
				code,
				reason,
			});
		}
		this.options.onRejected?.(cycle, screenedEdgeBps, code, reason);
	}

	stats(): DetectorStats {
		return {
			ticks: this.ticks,
			cyclesScreened: this.cyclesScreened,
			screenPasses: this.screenPasses,
			planned: this.planned,
			rejected: this.rejected,
			lastScreenPassAt: this.lastScreenPassAt,
			quotesPriced: this.quotesPriced,
			staleSkips: this.staleSkips,
			bestEdgeBps: this.quotesPriced === 0 ? undefined : this.bestEdgeBps,
			bestEdgeAt: this.quotesPriced === 0 ? undefined : this.bestEdgeAt,
			bestByCycle: Object.fromEntries([...this.bestByCycle].map(([id, bps]) => [id, round2(bps)])),
			edgeHistogram: Object.fromEntries(
				[...this.edgeBands]
					.map((count, index) => ({ label: bandLabel(index), count }))
					.filter((band) => band.count > 0)
					.map((band) => [band.label, band.count]),
			),
			rejectionsByReason: Object.fromEntries(this.rejectionsByReason),
		};
	}
}

function round2(value: number): number {
	return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
