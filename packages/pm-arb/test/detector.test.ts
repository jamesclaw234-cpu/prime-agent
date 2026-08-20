import { describe, expect, it } from "vitest";
import { BookStore, bookFromWire, type TopOfBook } from "../src/core/book.js";
import { Detector, type Opportunity } from "../src/core/detector.js";
import { makeFeeModel, setEdgePerDollar, takerFeePerShare, ZERO_FEES } from "../src/core/fees.js";
import { decFromString as d, decToNumber } from "../src/util/decimal.js";

const NOW = 1_000_000;

function makeBook(slug: string, bid: string, ask: string, bidQty = "100", askQty = "100"): TopOfBook {
	return {
		slug,
		bid: d(bid),
		bidQty: d(bidQty),
		ask: d(ask),
		askQty: d(askQty),
		transactTimeMs: NOW,
		receivedAt: NOW,
	};
}

function harness(
	books: TopOfBook[],
	events: { eventSlug: string; marketSlugs: string[] }[],
	minNet = 0.001,
	minSets = 1,
) {
	const store = new BookStore(() => NOW);
	for (const book of books) store.apply(book);
	const found: Opportunity[] = [];
	const detector = new Detector({
		store,
		events,
		fee: makeFeeModel("0.05", "0.0125"),
		minNetPerSet: minNet,
		minSets,
		maxBookAgeMs: 5000,
		maxBookAgeCeilingMs: 0,
		now: () => NOW,
		onOpportunity: (opportunity) => found.push(opportunity),
	});
	return { detector, found, store };
}

describe("fee model", () => {
	it("charges rate x p x (1-p) per share, worst at the mid", () => {
		const fee = makeFeeModel("0.05", "0.0125");
		// 0.05 x 0.5 x 0.5 = 0.0125 dollars.
		expect(decToNumber(takerFeePerShare(fee, d("0.5")))).toBeCloseTo(0.0125, 12);
		// 0.05 x 0.05 x 0.95 = 0.002375 - the tails are nearly free.
		expect(decToNumber(takerFeePerShare(fee, d("0.05")))).toBeCloseTo(0.002375, 12);
	});

	it("computes gross fee-independently and net with every leg charged", () => {
		const fee = makeFeeModel("0.05", "0.0125");
		const { gross, net } = setEdgePerDollar(fee, [d("0.48"), d("0.49")]);
		expect(decToNumber(gross)).toBeCloseTo(0.03, 12);
		// fees: 0.05x0.48x0.52 + 0.05x0.49x0.51 = 0.012480 + 0.012495
		expect(decToNumber(net)).toBeCloseTo(0.03 - 0.01248 - 0.012495, 12);
	});
});

describe("pair detection", () => {
	it("never fires on a unified book, where the pair costs one dollar plus the spread", () => {
		// LONG ask 0.47, SHORT mirrored ask 1-0.44=0.56: pair sum 1.03, gross -0.03. This is the
		// experiment that settles the unified-book question from data.
		const { detector, found } = harness([makeBook("alpha", "0.44", "0.47")], []);
		detector.onBookUpdate("alpha");
		expect(found).toHaveLength(0);
		const stats = detector.stats();
		expect(stats.bestGrossPair).toBeCloseTo(-0.03, 9);
	});
});

describe("event detection", () => {
	const EVENT = [{ eventSlug: "election", marketSlugs: ["cand-a", "cand-b", "cand-c"] }];

	it("fires when the outcome asks sum below one dollar minus fees", () => {
		// Asks: 0.30 + 0.33 + 0.30 = 0.93. Fees at the three prices are ~0.0105+0.0111+0.0105.
		const { detector, found } = harness(
			[
				makeBook("cand-a", "0.28", "0.30", "50", "40"),
				makeBook("cand-b", "0.31", "0.33", "50", "60"),
				makeBook("cand-c", "0.28", "0.30", "50", "25"),
			],
			EVENT,
		);
		detector.onBookUpdate("cand-a");
		expect(found).toHaveLength(1);
		expect(found[0].kind).toBe("event");
		expect(decToNumber(found[0].grossPerSet)).toBeCloseTo(0.07, 9);
		// Depth-bounded: the smallest displayed ask size caps the whole set.
		expect(found[0].maxSets).toBe(25);
	});

	it("stays quiet when fees eat the dislocation", () => {
		// Sum 0.98: 2 cents gross, but ~3.2 cents of fees across three mid-priced legs.
		const { detector, found } = harness(
			[makeBook("cand-a", "0.30", "0.32"), makeBook("cand-b", "0.31", "0.33"), makeBook("cand-c", "0.31", "0.33")],
			EVENT,
		);
		detector.onBookUpdate("cand-b");
		expect(found).toHaveLength(0);
		const stats = detector.stats();
		expect(stats.bestGrossEvent).toBeCloseTo(0.02, 9);
		expect(stats.bestNetEvent ?? 0).toBeLessThan(0);
	});

	it("refuses to price an event with any stale or missing leg", () => {
		const { detector, found, store } = harness(
			[makeBook("cand-a", "0.28", "0.30"), makeBook("cand-b", "0.31", "0.33")],
			EVENT,
		);
		void store;
		detector.onBookUpdate("cand-a");
		expect(found).toHaveLength(0);
		expect(detector.stats().staleSkips).toBeGreaterThan(0);
	});

	it("with zero fees, net equals gross - the fee model is the only wedge", () => {
		const store = new BookStore(() => NOW);
		store.apply(makeBook("cand-a", "0.28", "0.30"));
		store.apply(makeBook("cand-b", "0.31", "0.33"));
		store.apply(makeBook("cand-c", "0.28", "0.30"));
		const found: Opportunity[] = [];
		const detector = new Detector({
			store,
			events: EVENT,
			fee: ZERO_FEES,
			minNetPerSet: 0.001,
			maxBookAgeMs: 5000,
			maxBookAgeCeilingMs: 0,
			now: () => NOW,
			onOpportunity: (opportunity) => found.push(opportunity),
		});
		detector.onBookUpdate("cand-c");
		expect(found).toHaveLength(1);
		expect(decToNumber(found[0].netPerSet)).toBeCloseTo(decToNumber(found[0].grossPerSet), 12);
	});
});

describe("edge distribution", () => {
	it("reports how close the market came even when nothing fires", () => {
		const { detector } = harness(
			[makeBook("cand-a", "0.30", "0.32"), makeBook("cand-b", "0.31", "0.33"), makeBook("cand-c", "0.31", "0.33")],
			[{ eventSlug: "election", marketSlugs: ["cand-a", "cand-b", "cand-c"] }],
		);
		detector.scanAll();
		const stats = detector.stats();
		expect(stats.setsPriced).toBeGreaterThan(0);
		expect(Object.keys(stats.histogram).length).toBeGreaterThan(0);
		expect(stats.bestGrossEvent).toBeDefined();
	});
});

describe("executable depth", () => {
	// A dislocated 3-outcome event whose asks sum to 0.90: comfortably profitable after fees.
	const DISLOCATED = (thinAskQty: string) => [
		makeBook("cand-a", "0.28", "0.30", "100", thinAskQty),
		makeBook("cand-b", "0.28", "0.30"),
		makeBook("cand-c", "0.28", "0.30"),
	];
	const EVENT = [{ eventSlug: "election", marketSlugs: ["cand-a", "cand-b", "cand-c"] }];

	it("does not report depth below the venue's minimum order quantity as an opportunity", () => {
		// 3 displayed shares cannot form a legal 5-share-minimum order on ANY leg, so no window
		// existed - reporting one would tell the operator a lie at the summary's headline line.
		const thin = harness(DISLOCATED("3"), EVENT, 0.001, 5);
		thin.detector.scanAll();
		expect(thin.found).toHaveLength(0);

		const deep = harness(DISLOCATED("7"), EVENT, 0.001, 5);
		deep.detector.scanAll();
		expect(deep.found).toHaveLength(1);
		expect(deep.found[0].maxSets).toBe(7);
	});

	it("floors displayed shares in exact arithmetic: near-integer dust is not a share", () => {
		// 0.999999999999999999 shares rounds UP to 1.0 through a float, manufacturing an
		// executable share out of dust; BigInt floor division must report zero.
		const dusty = harness(DISLOCATED("0.999999999999999999"), EVENT, 0.001, 1);
		dusty.detector.scanAll();
		expect(dusty.found).toHaveLength(0);

		// And an exact large integer must not LOSE a share to float spacing: through a double,
		// 100000e18 floors to 99999. The other legs still cap maxSets; the leg itself must be exact.
		const large = harness(DISLOCATED("100000"), EVENT, 0.001, 1);
		large.detector.scanAll();
		expect(large.found).toHaveLength(1);
		const thickLeg = large.found[0].legs.find((leg) => leg.slug === "cand-a");
		expect(thickLeg?.availableShares).toBe(100_000);
	});
});

describe("wire book state", () => {
	const WIRE = {
		marketSlug: "alpha",
		bids: [{ px: { value: "0.44", currency: "USD" as const }, qty: "100" }],
		offers: [{ px: { value: "0.47", currency: "USD" as const }, qty: "100" }],
	};

	it("refuses to price a book whose market is not open", () => {
		// A suspended market keeps displaying its last quotes; nobody can trade them.
		expect(bookFromWire({ ...WIRE, state: "MARKET_STATE_SUSPENDED" }, NOW)).toBeUndefined();
		expect(bookFromWire({ ...WIRE, state: "MARKET_STATE_HALTED" }, NOW)).toBeUndefined();
		expect(bookFromWire({ ...WIRE, state: "MARKET_STATE_MATCH_AND_CLOSE_AUCTION" }, NOW)).toBeUndefined();
		// Open, or a payload that omits state entirely, prices normally.
		expect(bookFromWire({ ...WIRE, state: "MARKET_STATE_OPEN" }, NOW)).toBeDefined();
		expect(bookFromWire(WIRE, NOW)).toBeDefined();
	});
});
