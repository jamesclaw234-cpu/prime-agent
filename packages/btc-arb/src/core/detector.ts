import type { Cycle, MarketSymbol, Opportunity, SymbolRules } from "../types.js";
import type { Dec } from "../util/decimal.js";
import { type Logger, silentLogger } from "../util/logger.js";
import type { BookStore } from "./book.js";
import type { CycleIndex } from "./cycles.js";
import type { FeeModel } from "./pricing.js";
import { quoteCycle } from "./pricing.js";
import { planOpportunity, type SizingInputs } from "./sizing.js";
import type { Valuation } from "./valuation.js";

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
	readonly onRejected?: (cycle: Cycle, screenedEdgeBps: number, reason: string) => void;
}

export interface DetectorStats {
	readonly ticks: number;
	readonly cyclesScreened: number;
	readonly screenPasses: number;
	readonly planned: number;
	readonly rejected: number;
	readonly lastScreenPassAt: number;
	readonly rejectionsByReason: Readonly<Record<string, number>>;
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
	private readonly rejectionsByReason = new Map<string, number>();

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
		if (!quote) return;
		if (!skipScreen && quote.edgeBps < this.screenThresholdBps) return;

		this.screenPasses++;
		this.lastScreenPassAt = now;

		const budget = this.options.inputBudget(cycle.startAsset);
		if (!budget) {
			this.recordRejection(cycle, quote.edgeBps, "no budget for the start asset");
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
			this.recordRejection(cycle, quote.edgeBps, result.reason);
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

	private recordRejection(cycle: Cycle, screenedEdgeBps: number, reason: string): void {
		this.rejected++;
		// Reasons carry numbers; bucket on the stable prefix so the histogram stays readable.
		const bucket = reason.split(":")[0].slice(0, 60);
		this.rejectionsByReason.set(bucket, (this.rejectionsByReason.get(bucket) ?? 0) + 1);
		if (this.options.logEdgeBps > 0 && screenedEdgeBps >= this.options.logEdgeBps) {
			this.logger.debug("opportunity rejected", {
				cycle: cycle.id,
				screenedBps: round2(screenedEdgeBps),
				reason,
			});
		}
		this.options.onRejected?.(cycle, screenedEdgeBps, reason);
	}

	stats(): DetectorStats {
		return {
			ticks: this.ticks,
			cyclesScreened: this.cyclesScreened,
			screenPasses: this.screenPasses,
			planned: this.planned,
			rejected: this.rejected,
			lastScreenPassAt: this.lastScreenPassAt,
			rejectionsByReason: Object.fromEntries(this.rejectionsByReason),
		};
	}
}

function round2(value: number): number {
	return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
