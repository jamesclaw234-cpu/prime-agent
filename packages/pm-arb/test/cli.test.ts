import { describe, expect, it } from "vitest";
import { buildUniverse, parseArgs } from "../src/cli.js";
import type { EventDetail } from "../src/venue/types.js";

describe("parseArgs", () => {
	it("parses a command with options", () => {
		const args = parseArgs(["scan", "--config", "x.json", "--duration", "60", "--min-net", "0.01"]);
		expect(args.command).toBe("scan");
		expect(args.configFile).toBe("x.json");
		expect(args.durationSec).toBe(60);
		expect(args.minNet).toBe(0.01);
	});

	it("rejects unknown options and dangling values", () => {
		expect(() => parseArgs(["scan", "--nope"])).toThrow(/unknown option/);
		expect(() => parseArgs(["scan", "--config"])).toThrow(/needs a value/);
		expect(() => parseArgs(["scan", "extra"])).toThrow(/unexpected argument/);
		expect(() => parseArgs(["scan", "--duration", "-5"])).toThrow(/positive/);
	});
});

function event(slug: string, liquidity: number, marketSlugs: string[], closed = false): EventDetail {
	return {
		slug,
		liquidity,
		closed,
		markets: marketSlugs.map((market) => ({ slug: market, eventSlug: slug })),
	};
}

describe("buildUniverse", () => {
	it("ranks by liquidity and keeps events whole", () => {
		const universe = buildUniverse([event("small", 10, ["s1", "s2"]), event("big", 100, ["b1", "b2", "b3"])], 10, 10);
		expect(universe.groups.map((group) => group.eventSlug)).toEqual(["big", "small"]);
		expect(universe.slugs).toEqual(["b1", "b2", "b3", "s1", "s2"]);
		expect(universe.skippedEvents).toEqual([]);
	});

	it("never subscribes part of an event: one that does not fit is skipped and REPORTED", () => {
		const universe = buildUniverse(
			[event("big", 100, ["b1", "b2", "b3", "b4"]), event("small", 50, ["s1", "s2"])],
			10,
			3,
		);
		// The four-market event cannot fit a three-market budget; a partial subscription would
		// leave its sum permanently unevaluable, so it is skipped whole and named in the report.
		expect(universe.groups.map((group) => group.eventSlug)).toEqual(["small"]);
		expect(universe.slugs).toEqual(["s1", "s2"]);
		expect(universe.skippedEvents).toEqual(["big"]);
	});

	it("drops closed events and closed markets", () => {
		const closedEvent = event("gone", 100, ["g1"], true);
		const mixed: EventDetail = {
			slug: "mixed",
			liquidity: 50,
			markets: [
				{ slug: "open-market", eventSlug: "mixed" },
				{ slug: "closed-market", eventSlug: "mixed", closed: true },
			],
		};
		const universe = buildUniverse([closedEvent, mixed], 10, 10);
		expect(universe.slugs).toEqual(["open-market"]);
	});

	it("caps the number of events", () => {
		const universe = buildUniverse([event("a", 3, ["a1"]), event("b", 2, ["b1"]), event("c", 1, ["c1"])], 2, 10);
		expect(universe.groups).toHaveLength(2);
		expect(universe.slugs).toEqual(["a1", "b1"]);
	});

	it("does not double-subscribe a market shared between events", () => {
		const universe = buildUniverse(
			[event("first", 2, ["shared", "f1"]), event("second", 1, ["shared", "s1"])],
			10,
			10,
		);
		expect(universe.slugs).toEqual(["shared", "f1", "s1"]);
		// Both groups still evaluate their full leg set.
		expect(universe.groups[1].marketSlugs).toEqual(["shared", "s1"]);
	});
});
