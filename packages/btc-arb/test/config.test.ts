import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import {
	BINANCE_MAINNET_REST,
	BINANCE_TESTNET_REST,
	BINANCE_TESTNET_WS,
	ConfigError,
	DEFAULT_CONFIG,
	evaluateLiveGate,
	LIVE_CONFIRMATION_ENV,
	LIVE_CONFIRMATION_PHRASE,
	loadConfig,
	validateConfig,
} from "../src/config.js";

function writeConfig(contents: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "btc-arb-config-"));
	const file = join(dir, "arb.json");
	writeFileSync(file, JSON.stringify(contents));
	return file;
}

describe("loading", () => {
	it("returns the defaults with no file and no environment", () => {
		const config = loadConfig({ env: {} });
		expect(config.mode).toBe("paper");
		expect(config.binance.restBaseUrl).toBe(BINANCE_MAINNET_REST);
		expect(config.detection.minNetEdgeBps).toBe(DEFAULT_CONFIG.detection.minNetEdgeBps);
	});

	it("deep-merges a partial file over the defaults", () => {
		const file = writeConfig({ detection: { minNetEdgeBps: 25 }, execution: { maxNotionalPerCycle: 500 } });
		const config = loadConfig({ file, env: {} });
		expect(config.detection.minNetEdgeBps).toBe(25);
		// Untouched siblings survive the merge.
		expect(config.detection.maxBookAgeMs).toBe(DEFAULT_CONFIG.detection.maxBookAgeMs);
		expect(config.execution.maxNotionalPerCycle).toBe(500);
		expect(config.execution.aggressionTicks).toBe(DEFAULT_CONFIG.execution.aggressionTicks);
	});

	it("replaces arrays rather than concatenating them", () => {
		const file = writeConfig({ universe: { quoteAssets: ["USDT"] } });
		expect(loadConfig({ file, env: {} }).universe.quoteAssets).toEqual(["USDT"]);
	});

	it("rejects an unknown key instead of silently ignoring it", () => {
		const file = writeConfig({ detection: { minNetEdgeBpsTypo: 25 } });
		expect(() => loadConfig({ file, env: {} })).toThrow(/unknown config key: detection.minNetEdgeBpsTypo/);
	});

	it("refuses a config file that carries API credentials", () => {
		const file = writeConfig({ binance: { apiKey: "leaked", apiSecret: "also-leaked" } });
		expect(() => loadConfig({ file, env: {} })).toThrow(/credentials/);
	});

	it("reports an unreadable or malformed file clearly", () => {
		expect(() => loadConfig({ file: "/nope/missing.json", env: {} })).toThrow(ConfigError);
		const dir = mkdtempSync(join(tmpdir(), "btc-arb-config-"));
		const file = join(dir, "bad.json");
		writeFileSync(file, "{not json");
		expect(() => loadConfig({ file, env: {} })).toThrow(/cannot read config file/);
	});

	it("takes credentials only from the environment", () => {
		const config = loadConfig({ env: { BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" } });
		expect(config.binance.apiKey).toBe("k");
		expect(config.binance.apiSecret).toBe("s");
	});

	it("switches hosts for testnet without clobbering an explicit override", () => {
		const testnet = loadConfig({ env: { ARB_TESTNET: "1" } });
		expect(testnet.binance.restBaseUrl).toBe(BINANCE_TESTNET_REST);
		expect(testnet.binance.wsBaseUrl).toBe(BINANCE_TESTNET_WS);

		const pinned = loadConfig({
			env: { ARB_TESTNET: "1" },
			overrides: { binance: { restBaseUrl: "https://custom.example" } },
		});
		expect(pinned.binance.restBaseUrl).toBe("https://custom.example");
	});

	it("rejects an invalid ARB_MODE", () => {
		expect(() => loadConfig({ env: { ARB_MODE: "yolo" } })).toThrow(/ARB_MODE/);
		expect(loadConfig({ env: { ARB_MODE: "live" } }).mode).toBe("live");
	});
});

describe("validation", () => {
	const bad: [string, Record<string, unknown>][] = [
		["negative edge threshold", { detection: { minNetEdgeBps: -1 } }],
		["screen margin above the threshold", { detection: { minNetEdgeBps: 5, screenMarginBps: 10 } }],
		["cycle length outside 3 or 4", { detection: { maxCycleLength: 5 } }],
		["zero book age", { detection: { maxBookAgeMs: 0 } }],
		["depth utilization above one", { execution: { depthUtilization: 1.5 } }],
		["min notional above max", { execution: { minNotionalPerCycle: 500, maxNotionalPerCycle: 100 } }],
		["empty start assets", { execution: { startAssets: [] } }],
		["empty quote assets", { universe: { quoteAssets: [] } }],
		["recvWindow above the exchange cap", { binance: { recvWindowMs: 90_000 } }],
		["an invalid base URL", { binance: { restBaseUrl: "not a url" } }],
		["an absurd fee", { fees: { takerBps: 900 } }],
		["fill probability above one", { paper: { fillProbability: 2 } }],
		["an unknown log level", { observability: { logLevel: "loud" } }],
	];

	for (const [name, overrides] of bad) {
		it(`rejects ${name}`, () => {
			expect(() => loadConfig({ env: {}, overrides })).toThrow(ConfigError);
		});
	}

	it("accepts the shipped defaults", () => {
		expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
	});
});

describe("live gate", () => {
	const live = { ...DEFAULT_CONFIG, mode: "live" as const };
	const withKeys = { ...live, binance: { ...live.binance, apiKey: "k", apiSecret: "s" } };
	const confirmed = { [LIVE_CONFIRMATION_ENV]: LIVE_CONFIRMATION_PHRASE };

	it("opens only when every condition is met", () => {
		expect(evaluateLiveGate(withKeys, confirmed, true).allowed).toBe(true);
	});

	it("stays shut for paper mode", () => {
		const gate = evaluateLiveGate(DEFAULT_CONFIG, confirmed, true);
		expect(gate.allowed).toBe(false);
		expect(gate.reasons.join(" ")).toContain('not "live"');
	});

	it("stays shut without the CLI flag", () => {
		expect(evaluateLiveGate(withKeys, confirmed, false).allowed).toBe(false);
	});

	it("stays shut without the confirmation phrase", () => {
		expect(evaluateLiveGate(withKeys, {}, true).allowed).toBe(false);
		expect(evaluateLiveGate(withKeys, { [LIVE_CONFIRMATION_ENV]: "yes" }, true).allowed).toBe(false);
	});

	it("stays shut without credentials", () => {
		const gate = evaluateLiveGate(live, confirmed, true);
		expect(gate.allowed).toBe(false);
		expect(gate.reasons.some((r) => r.includes("BINANCE_API_KEY"))).toBe(true);
		expect(gate.reasons.some((r) => r.includes("BINANCE_API_SECRET"))).toBe(true);
	});

	it("lists every unmet condition, not just the first", () => {
		const gate = evaluateLiveGate(DEFAULT_CONFIG, {}, false);
		expect(gate.reasons.length).toBeGreaterThanOrEqual(4);
	});
});

describe("argument parsing", () => {
	it("parses a command with flags", () => {
		const args = parseArgs(["run", "--live", "--min-edge", "15", "--duration", "60", "--no-dashboard"]);
		expect(args.command).toBe("run");
		expect(args.live).toBe(true);
		expect(args.minEdgeBps).toBe(15);
		expect(args.durationSec).toBe(60);
		expect(args.dashboard).toBe(false);
	});

	it("defaults to paper and the dashboard", () => {
		const args = parseArgs(["scan"]);
		expect(args.live).toBe(false);
		expect(args.dashboard).toBe(true);
		expect(args.testnet).toBe(false);
	});

	it("rejects unknown options and missing values", () => {
		expect(() => parseArgs(["run", "--wat"])).toThrow(/unknown option/);
		expect(() => parseArgs(["run", "--min-edge"])).toThrow(/requires a value/);
		expect(() => parseArgs(["run", "--min-edge", "abc"])).toThrow(/expects a number/);
		expect(() => parseArgs(["run", "extra"])).toThrow(/unexpected argument/);
	});

	it("recognises help", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["-h"]).help).toBe(true);
	});
});
