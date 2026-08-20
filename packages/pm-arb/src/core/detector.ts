import { DEC_ONE, type Dec, decToNumber } from "../util/decimal.js";
import { type Logger, silentLogger } from "../util/logger.js";
import type { BookStore, MarketSlug, TopOfBook } from "./book.js";
import { type FeeModel, setEdgePerDollar } from "./fees.js";

/**
 * Detection for guaranteed-$1 share sets.
 *
 * Two primitives, deliberately separated by how much they assume:
 *
 * PAIR - one market's LONG at the ask plus its SHORT at the mirrored ask (1 - bid). That the pair
 * pays $1 is DEFINITIONAL: it is the same market, one side wins. No exclusivity assumption, no
 * venue trust. On a unified order book this can never be profitable (the cost is 1 + spread), so
 * the pair scan doubles as the experiment that settles whether the book is unified: a pair edge
 * distribution pinned below zero by exactly the spread IS the unified-book answer.
 *
 * EVENT - one LONG share of every outcome market in an event. This pays $1 only if the event's
 * markets are exhaustive and mutually exclusive, which the API does not attest. Detection reports
 * these always (measurement is free); anything downstream that would TRADE one must require the
 * event slug to appear in an operator-verified allowlist. An event grouping that is editorial
 * rather than logical would otherwise turn "arbitrage" into an unhedged short position.
 */

export interface EventGroup {
	readonly eventSlug: string;
	readonly marketSlugs: readonly MarketSlug[];
}

export type OpportunityKind = "pair" | "event";

export interface Opportunity {
	readonly kind: OpportunityKind;
	/** The pair's market slug, or the event slug. */
	readonly key: string;
	readonly legs: readonly { slug: MarketSlug; price: Dec; availableShares: number }[];
	/** Dollars of profit per $1 set, before fees. */
	readonly grossPerSet: Dec;
	/** Dollars of profit per $1 set, after taker fees on every leg. */
	readonly netPerSet: Dec;
	/** Whole sets executable at displayed depth. */
	readonly maxSets: number;
	readonly observedAt: number;
}

export interface DetectorOptions {
	readonly store: BookStore;
	readonly events: readonly EventGroup[];
	readonly fee: FeeModel;
	/** Net dollars per set required to report an opportunity, e.g. 0.005 = half a cent. */
	readonly minNetPerSet: number;
	/**
	 * Sets below this are not reported as opportunities: executing N sets means an N-share order
	 * on every leg, and the venue refuses orders under its minimum quantity - depth that cannot
	 * form a legal order is not an executable window. Defaults to 1 (no venue minimum).
	 */
	readonly minSets?: number;
	readonly maxBookAgeMs: number;
	readonly maxBookAgeCeilingMs: number;
	readonly onOpportunity?: (opportunity: Opportunity) => void;
	readonly logger?: Logger;
	readonly now?: () => number;
}

export interface DetectorStats {
	readonly ticks: number;
	readonly setsPriced: number;
	readonly staleSkips: number;
	readonly opportunities: number;
	/** Best NET edge seen per kind, in dollars per set, with when. */
	readonly bestNetPair?: number;
	readonly bestNetPairAt?: number;
	readonly bestNetEvent?: number;
	readonly bestNetEventAt?: number;
	/** Best GROSS edge per kind - fee-independent, the line that survives a wrong fee config. */
	readonly bestGrossPair?: number;
	readonly bestGrossEvent?: number;
	/** Counts of priced NET edges by cents band. */
	readonly histogram: Readonly<Record<string, number>>;
}

/** Band bounds in dollars-per-set. A run that finds nothing must still say how close it came. */
const BANDS: readonly number[] = [-0.1, -0.05, -0.02, -0.01, -0.005, 0, 0.005, 0.01, 0.02, 0.05];

function bandLabel(index: number): string {
	if (index === 0) return `<${BANDS[0]}`;
	if (index === BANDS.length) return `>=${BANDS[BANDS.length - 1]}`;
	return `${BANDS[index - 1]}..${BANDS[index]}`;
}

export class Detector {
	private readonly logger: Logger;
	private readonly now: () => number;
	private readonly marketToEvents = new Map<MarketSlug, EventGroup[]>();
	private ticks = 0;
	private setsPriced = 0;
	private staleSkips = 0;
	private opportunities = 0;
	private bestNetPair = Number.NEGATIVE_INFINITY;
	private bestNetPairAt = 0;
	private bestNetEvent = Number.NEGATIVE_INFINITY;
	private bestNetEventAt = 0;
	private bestGrossPair = Number.NEGATIVE_INFINITY;
	private bestGrossEvent = Number.NEGATIVE_INFINITY;
	private readonly bands = new Float64Array(BANDS.length + 1);

	constructor(private readonly options: DetectorOptions) {
		this.logger = options.logger ?? silentLogger();
		this.now = options.now ?? Date.now;
		for (const group of options.events) {
			for (const slug of group.marketSlugs) {
				const list = this.marketToEvents.get(slug);
				if (list) list.push(group);
				else this.marketToEvents.set(slug, [group]);
			}
		}
	}

	/** Re-prices everything the updated market touches: its own pair, and its events. */
	onBookUpdate(slug: MarketSlug): void {
		this.ticks++;
		const now = this.now();
		this.evaluatePair(slug, now);
		for (const group of this.marketToEvents.get(slug) ?? []) this.evaluateEvent(group, now);
	}

	scanAll(): void {
		const now = this.now();
		const seen = new Set<string>();
		for (const [slug] of this.marketToEvents) {
			this.evaluatePair(slug, now);
		}
		for (const group of this.options.events) {
			if (seen.has(group.eventSlug)) continue;
			seen.add(group.eventSlug);
			this.evaluateEvent(group, now);
		}
	}

	private fresh(slug: MarketSlug, now: number): TopOfBook | undefined {
		const book = this.options.store.get(slug);
		if (!book) return undefined;
		const limit = this.options.store.ageLimitFor(slug, this.options.maxBookAgeMs, this.options.maxBookAgeCeilingMs);
		if (now - book.receivedAt > limit) return undefined;
		return book;
	}

	private evaluatePair(slug: MarketSlug, now: number): void {
		const book = this.fresh(slug, now);
		if (!book) {
			this.staleSkips++;
			return;
		}
		// LONG at the ask; SHORT at the mirrored ask (1 - bid). If the venue turns out to quote
		// SHORT independently, this understates nothing - the mirrored price is what a unified
		// engine guarantees is available, and an independent SHORT book only improves on it.
		const shortAsk = (10n ** 18n - book.bid) as Dec;
		const legs = [
			{ slug, price: book.ask, availableShares: wholeShares(book.askQty) },
			{ slug, price: shortAsk, availableShares: wholeShares(book.bidQty) },
		];
		this.record("pair", slug, legs, now);
	}

	private evaluateEvent(group: EventGroup, now: number): void {
		if (group.marketSlugs.length < 2) return;
		const legs: { slug: MarketSlug; price: Dec; availableShares: number }[] = [];
		for (const slug of group.marketSlugs) {
			const book = this.fresh(slug, now);
			if (!book) {
				this.staleSkips++;
				return;
			}
			legs.push({ slug, price: book.ask, availableShares: wholeShares(book.askQty) });
		}
		this.record("event", group.eventSlug, legs, now);
	}

	private record(
		kind: OpportunityKind,
		key: string,
		legs: readonly { slug: MarketSlug; price: Dec; availableShares: number }[],
		now: number,
	): void {
		this.setsPriced++;
		const { gross, net } = setEdgePerDollar(
			this.options.fee,
			legs.map((leg) => leg.price),
		);
		const netNum = decToNumber(net);
		const grossNum = decToNumber(gross);

		if (kind === "pair") {
			if (netNum > this.bestNetPair) {
				this.bestNetPair = netNum;
				this.bestNetPairAt = now;
			}
			if (grossNum > this.bestGrossPair) this.bestGrossPair = grossNum;
		} else {
			if (netNum > this.bestNetEvent) {
				this.bestNetEvent = netNum;
				this.bestNetEventAt = now;
			}
			if (grossNum > this.bestGrossEvent) this.bestGrossEvent = grossNum;
		}

		let band = BANDS.length;
		for (let i = 0; i < BANDS.length; i++) {
			if (netNum < BANDS[i]) {
				band = i;
				break;
			}
		}
		this.bands[band]++;

		if (netNum < this.options.minNetPerSet) return;
		const maxSets = Math.min(...legs.map((leg) => leg.availableShares));
		if (maxSets < Math.max(1, this.options.minSets ?? 1)) return;

		this.opportunities++;
		const opportunity: Opportunity = {
			kind,
			key,
			legs,
			grossPerSet: gross,
			netPerSet: net,
			maxSets,
			observedAt: now,
		};
		this.logger.info("opportunity", {
			kind,
			key,
			netPerSet: netNum,
			grossPerSet: grossNum,
			maxSets,
		});
		this.options.onOpportunity?.(opportunity);
	}

	stats(): DetectorStats {
		return {
			ticks: this.ticks,
			setsPriced: this.setsPriced,
			staleSkips: this.staleSkips,
			opportunities: this.opportunities,
			bestNetPair: this.bestNetPair === Number.NEGATIVE_INFINITY ? undefined : this.bestNetPair,
			bestNetPairAt: this.bestNetPairAt || undefined,
			bestNetEvent: this.bestNetEvent === Number.NEGATIVE_INFINITY ? undefined : this.bestNetEvent,
			bestNetEventAt: this.bestNetEventAt || undefined,
			bestGrossPair: this.bestGrossPair === Number.NEGATIVE_INFINITY ? undefined : this.bestGrossPair,
			bestGrossEvent: this.bestGrossEvent === Number.NEGATIVE_INFINITY ? undefined : this.bestGrossEvent,
			histogram: Object.fromEntries(
				[...this.bands]
					.map((count, index) => ({ label: bandLabel(index), count }))
					.filter((entry) => entry.count > 0)
					.map((entry) => [entry.label, entry.count]),
			),
		};
	}
}

/**
 * Displayed depth in whole shares; fractional dust in a quote is not an executable share.
 *
 * Floored in BigInt, not via decToNumber: the float conversion rounds 0.999999999999999999 up to
 * exactly 1.0 (double spacing at 1e18 is 128), manufacturing an executable share from dust, and
 * rounds exact large depths like 100000 DOWN a share. Integer division cannot do either.
 */
function wholeShares(qty: Dec): number {
	return Number((qty as bigint) / DEC_ONE);
}
