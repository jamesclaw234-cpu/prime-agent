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

	it("switches both hosts for testnet", () => {
		const testnet = loadConfig({ env: { ARB_TESTNET: "1" } });
		expect(testnet.binance.restBaseUrl).toBe(BINANCE_TESTNET_REST);
		expect(testnet.binance.wsBaseUrl).toBe(BINANCE_TESTNET_WS);
	});

	it("refuses a testnet run that straddles two environments", () => {
		// Pinning one host for latency and leaving the other at its default is an ordinary thing to
		// do, and would otherwise place real mainnet orders priced off testnet market data.
		expect(() =>
			loadConfig({
				env: { ARB_TESTNET: "1" },
				overrides: { binance: { restBaseUrl: "https://api-gcp.binance.com" } },
			}),
		).toThrow(/straddle|pin both hosts/);
	});

	it("accepts a testnet run with both hosts pinned to testnet", () => {
		const config = loadConfig({
			env: { ARB_TESTNET: "1" },
			overrides: {
				binance: {
					restBaseUrl: "https://testnet.binance.vision",
					wsBaseUrl: "wss://stream.testnet.binance.vision",
				},
			},
		});
		expect(config.binance.restBaseUrl).toContain("testnet");
		expect(config.binance.wsBaseUrl).toContain("testnet");
	});

	it("refuses a plaintext endpoint, which would put the API key and signature on the wire", () => {
		expect(() => loadConfig({ env: {}, overrides: { binance: { restBaseUrl: "http://api.binance.com" } } })).toThrow(
			/must use https:/,
		);
		expect(() => loadConfig({ env: {}, overrides: { binance: { wsBaseUrl: "ws://stream.binance.com" } } })).toThrow(
			/must use wss:/,
		);
		// A local mock server is the one legitimate plaintext case.
		expect(() =>
			loadConfig({
				env: {},
				overrides: { binance: { restBaseUrl: "http://localhost:8080", wsBaseUrl: "ws://127.0.0.1:8081" } },
			}),
		).not.toThrow();
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
		// Binance's own matching-engine timeout is 10s; aborting sooner turns a slow but successful
		// order into an ambiguous one that halts the bot.
		["an order timeout below the exchange's own", { binance: { orderTimeoutMs: 5000 } }],
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

describe("shipped config profiles", () => {
	// The profiles are documentation people copy verbatim. A profile that no longer validates is a
	// broken instruction, so they are loaded here rather than trusted to stay correct.
	const profiles = [
		"arb.config.example.json",
		"binance-us.config.json",
		"binance-us.live.config.json",
		"mock.config.json",
	];

	for (const profile of profiles) {
		it(`${profile} loads and validates`, () => {
			const file = join(import.meta.dirname, "..", profile);
			expect(() => loadConfig({ file, env: {} })).not.toThrow();
		});
	}

	it("the Binance.US profile points both hosts at Binance.US", () => {
		const config = loadConfig({ file: join(import.meta.dirname, "..", "binance-us.config.json"), env: {} });
		expect(config.binance.restBaseUrl).toBe("https://api.binance.us");
		expect(config.binance.wsBaseUrl).toBe("wss://stream.binance.us:9443");
		expect(config.mode).toBe("paper");
	});

	it("the mock profile can only ever reach a loopback address", () => {
		// It is the one shipped profile with plaintext hosts. If a hostname other than loopback ever
		// appeared here, the https guard would be bypassed against a real venue.
		const config = loadConfig({ file: join(import.meta.dirname, "..", "mock.config.json"), env: {} });
		expect(new URL(config.binance.restBaseUrl).hostname).toBe("127.0.0.1");
		expect(new URL(config.binance.wsBaseUrl).hostname).toBe("127.0.0.1");
		expect(config.mode).toBe("paper");
	});

	it("the live profile is armed in config but still needs the other three gate conditions", () => {
		const config = loadConfig({ file: join(import.meta.dirname, "..", "binance-us.live.config.json"), env: {} });
		expect(config.mode).toBe("live");
		// Risk caps sized for a small account: the daily halt must be a fraction of it, not larger.
		expect(config.risk.maxDailyLoss).toBe(2);
		expect(config.risk.maxCyclesPerDay).toBe(50);
		// mode alone opens nothing: no flag, no confirmation phrase, no credentials.
		expect(evaluateLiveGate(config, {}, false).allowed).toBe(false);
	});

	it("refuses --testnet against Binance.US, which has no testnet", () => {
		// Binance.US publishes no testnet. The environment guard catches the mistake rather than
		// letting a run straddle a testnet host and a live one.
		expect(() =>
			loadConfig({
				file: join(import.meta.dirname, "..", "binance-us.config.json"),
				env: { ARB_TESTNET: "1" },
			}),
		).toThrow(/testnet is enabled but/);
	});
});

describe("adaptive book freshness", () => {
	it("treats a ceiling at or below the base window as no widening", () => {
		// Raising `maxBookAgeMs` past the shipped ceiling is ordinary; it must not become an error,
		// and the tighter of the two is always what applies.
		const config = loadConfig({
			env: {},
			overrides: { detection: { maxBookAgeMs: 60_000, maxBookAgeCeilingMs: 10_000 } },
		});
		expect(config.detection.maxBookAgeMs).toBe(60_000);
		expect(config.detection.maxBookAgeCeilingMs).toBe(10_000);
	});

	it("accepts zero as the documented way to hold every symbol to one window", () => {
		expect(
			loadConfig({ env: {}, overrides: { detection: { maxBookAgeCeilingMs: 0 } } }).detection.maxBookAgeCeilingMs,
		).toBe(0);
	});

	it("rejects a negative ceiling", () => {
		expect(() => loadConfig({ env: {}, overrides: { detection: { maxBookAgeCeilingMs: -1 } } })).toThrow(ConfigError);
	});
});
