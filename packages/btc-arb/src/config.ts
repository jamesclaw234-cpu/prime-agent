import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { LogLevel } from "./util/logger.js";

/** Live trading is refused unless this exact value is present in the environment. */
export const LIVE_CONFIRMATION_PHRASE = "I_UNDERSTAND_THE_RISK";
export const LIVE_CONFIRMATION_ENV = "ARB_LIVE_CONFIRM";

export const BINANCE_MAINNET_REST = "https://api.binance.com";
export const BINANCE_MAINNET_WS = "wss://stream.binance.com:9443";
export const BINANCE_TESTNET_REST = "https://testnet.binance.vision";
export const BINANCE_TESTNET_WS = "wss://stream.testnet.binance.vision";

export interface BinanceConfig {
	readonly restBaseUrl: string;
	readonly wsBaseUrl: string;
	readonly apiKey?: string;
	readonly apiSecret?: string;
	/** Sent as `recvWindow`. Binance caps this at 60000ms; smaller is safer. */
	readonly recvWindowMs: number;
	readonly testnet: boolean;
	/** Streams per WebSocket connection. Binance allows 1024; smaller shards reconnect faster. */
	readonly streamsPerConnection: number;
	readonly requestTimeoutMs: number;
}

export interface UniverseConfig {
	/** Assets allowed to appear on the quote side of a market, e.g. USDT, BTC, BNB. */
	readonly quoteAssets: readonly string[];
	/** Optional base-asset whitelist. Empty means "any base asset quoted in `quoteAssets`". */
	readonly baseAssets: readonly string[];
	readonly excludeAssets: readonly string[];
	readonly excludeSymbols: readonly string[];
	/** Hard cap on markets subscribed. Guards against a runaway subscription list. */
	readonly maxSymbols: number;
	/** Only keep cycles that pass through this asset. Empty disables the filter. */
	readonly requireAsset: string;
}

export interface FeeConfig {
	/** Taker fee in basis points. Binance spot default is 10bps; 7.5bps with the BNB discount. */
	readonly takerBps: number;
	/**
	 * Pull the real commission rate from `GET /api/v3/account` at startup and override `takerBps`.
	 *
	 * The account's `commissionRates.taker` already reflects VIP tier and the BNB discount, so this
	 * is strictly better than guessing - but it needs credentials, so paper runs without keys fall
	 * back to `takerBps`.
	 */
	readonly autoDetect: boolean;
}

export interface DetectionConfig {
	/** Cycle length to enumerate. 3 is the classic triangle; 4 finds more but fills worse. */
	readonly maxCycleLength: number;
	/** Minimum post-rounding, post-fee edge required to act, in basis points. */
	readonly minNetEdgeBps: number;
	/** Reject any decision made on a book frame older than this. */
	readonly maxBookAgeMs: number;
	/** Float pre-screen threshold, set below `minNetEdgeBps` so screening never hides a real edge. */
	readonly screenMarginBps: number;
	/** Interval for the background n-leg negative-cycle sweep. Zero disables it. */
	readonly bellmanFordIntervalMs: number;
	/** Log every detection at or above this edge even when it is not executed. */
	readonly logEdgeBps: number;
}

export interface UnwindConfig {
	readonly enabled: boolean;
	readonly maxAttempts: number;
	/** Extra ticks of aggression when flattening; an unwind must fill, so it pays up. */
	readonly aggressionTicks: number;
}

export interface ExecutionConfig {
	/** Master switch. False means detect and log only, in either mode. */
	readonly enabled: boolean;
	/** Assets a cycle may start from. Cycles are rotated so leg 1 spends one of these. */
	readonly startAssets: readonly string[];
	readonly maxNotionalPerCycle: number;
	readonly minNotionalPerCycle: number;
	/** Fraction of visible top-of-book size to consume, 0 to 1. Above ~0.5 the fill rate collapses. */
	readonly depthUtilization: number;
	/** Ticks through the touch for the limit price. Zero prices at the touch and often misses. */
	readonly aggressionTicks: number;
	/**
	 * Reject cycles that lose money if every leg fills at its limit price rather than the touch.
	 *
	 * A marketable IOC normally fills at the resting touch and gets price improvement, but the
	 * limit is the worst it can do. Requiring the worst case to break even is what makes
	 * `aggressionTicks` safe to raise.
	 */
	readonly requireNonNegativeWorstCase: boolean;
	/** Wall-clock budget for the whole cycle. Exceeding it aborts and unwinds. */
	readonly cycleDeadlineMs: number;
	readonly maxConcurrentCycles: number;
	readonly unwind: UnwindConfig;
}

export interface RiskConfig {
	/** Asset all limits and PnL are denominated in. */
	readonly accountingAsset: string;
	/** Halt for the rest of the UTC day after losing this much. */
	readonly maxDailyLoss: number;
	readonly maxConsecutiveFailures: number;
	readonly errorWindowMs: number;
	readonly maxErrorsInWindow: number;
	readonly symbolCooldownMs: number;
	readonly maxOrdersPerSecond: number;
	/** Refuse to trade when measured clock skew exceeds this. */
	readonly maxClockSkewMs: number;
	readonly minTimeBetweenCyclesMs: number;
	/** Touching this file halts trading within one poll interval. */
	readonly killSwitchFile: string;
	readonly killSwitchPollMs: number;
	/** Halt entirely when a cycle leaves inventory the unwind could not flatten. */
	readonly haltOnStranded: boolean;
	/** Maximum cycles per UTC day. Zero disables the cap. */
	readonly maxCyclesPerDay: number;
}

export interface PaperConfig {
	readonly startingBalances: Readonly<Record<string, number>>;
	/** Simulated round-trip latency applied before a fill is evaluated. */
	readonly latencyMs: number;
	/** Probability a marketable order finds its quote at all. Models queue and race losses. */
	readonly fillProbability: number;
	/** Price degradation applied to every fill, in basis points. Models adverse selection. */
	readonly adverseSelectionBps: number;
	/** Fraction of displayed size a single order is assumed to be able to take. */
	readonly depthConsumptionRatio: number;
	/** Seed for the deterministic PRNG. Zero uses a random seed. */
	readonly seed: number;
}

export interface ObservabilityConfig {
	readonly logLevel: LogLevel;
	readonly logFile: string;
	readonly ledgerFile: string;
	readonly metricsIntervalMs: number;
	readonly dashboard: boolean;
	/** Write every book update to this file for later replay. Empty disables recording. */
	readonly recordFile: string;
}

export interface ArbConfig {
	readonly mode: "paper" | "live";
	readonly binance: BinanceConfig;
	readonly universe: UniverseConfig;
	readonly fees: FeeConfig;
	readonly detection: DetectionConfig;
	readonly execution: ExecutionConfig;
	readonly risk: RiskConfig;
	readonly paper: PaperConfig;
	readonly observability: ObservabilityConfig;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const stateDir = resolve(homedir(), ".prime", "btc-arb");

export const DEFAULT_CONFIG: ArbConfig = {
	mode: "paper",
	binance: {
		restBaseUrl: BINANCE_MAINNET_REST,
		wsBaseUrl: BINANCE_MAINNET_WS,
		recvWindowMs: 5000,
		testnet: false,
		streamsPerConnection: 64,
		requestTimeoutMs: 5000,
	},
	universe: {
		quoteAssets: ["USDT", "USDC", "FDUSD", "BTC", "ETH", "BNB"],
		baseAssets: [],
		excludeAssets: [],
		excludeSymbols: [],
		maxSymbols: 200,
		requireAsset: "",
	},
	fees: {
		takerBps: 10,
		autoDetect: true,
	},
	detection: {
		maxCycleLength: 3,
		minNetEdgeBps: 8,
		maxBookAgeMs: 1500,
		screenMarginBps: 2,
		bellmanFordIntervalMs: 1000,
		logEdgeBps: 0,
	},
	execution: {
		enabled: true,
		startAssets: ["USDT"],
		maxNotionalPerCycle: 200,
		minNotionalPerCycle: 20,
		depthUtilization: 0.5,
		aggressionTicks: 2,
		requireNonNegativeWorstCase: true,
		cycleDeadlineMs: 3000,
		maxConcurrentCycles: 1,
		unwind: {
			enabled: true,
			maxAttempts: 3,
			aggressionTicks: 10,
		},
	},
	risk: {
		accountingAsset: "USDT",
		maxDailyLoss: 50,
		maxConsecutiveFailures: 5,
		errorWindowMs: 60_000,
		maxErrorsInWindow: 20,
		symbolCooldownMs: 5000,
		maxOrdersPerSecond: 8,
		maxClockSkewMs: 1000,
		minTimeBetweenCyclesMs: 250,
		killSwitchFile: resolve(stateDir, "HALT"),
		killSwitchPollMs: 1000,
		haltOnStranded: true,
		maxCyclesPerDay: 0,
	},
	paper: {
		startingBalances: { USDT: 10_000 },
		latencyMs: 120,
		fillProbability: 0.7,
		adverseSelectionBps: 1,
		depthConsumptionRatio: 0.6,
		seed: 0,
	},
	observability: {
		logLevel: "info",
		logFile: resolve(stateDir, "arb.log.jsonl"),
		ledgerFile: resolve(stateDir, "ledger.jsonl"),
		metricsIntervalMs: 30_000,
		dashboard: true,
		recordFile: "",
	},
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges a partial override tree over a base config. Arrays replace rather than concatenate. */
function mergeInto(base: unknown, override: unknown, path: string): unknown {
	if (override === undefined) return base;
	if (isObject(base) && isObject(override)) {
		const merged: Json = { ...base };
		for (const [key, value] of Object.entries(override)) {
			if (!(key in base)) throw new ConfigError(`unknown config key: ${path ? `${path}.${key}` : key}`);
			merged[key] = mergeInto(base[key], value, path ? `${path}.${key}` : key);
		}
		return merged;
	}
	if (Array.isArray(base) && !Array.isArray(override)) {
		throw new ConfigError(`config key ${path} expects an array`);
	}
	if (!Array.isArray(base) && typeof base !== typeof override && base !== undefined) {
		// `startingBalances` is an open record, so only complain when the base is a concrete scalar.
		if (!isObject(base)) throw new ConfigError(`config key ${path} expects a ${typeof base}`);
	}
	return override;
}

export interface LoadConfigOptions {
	/** Path to a JSON config file. */
	readonly file?: string;
	/** Overrides applied after the file, e.g. from CLI flags. */
	readonly overrides?: Json;
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Loads, merges and validates configuration.
 *
 * Precedence, lowest first: defaults, config file, environment, explicit overrides. Secrets only
 * ever come from the environment - a config file that carries an API secret is rejected, because
 * config files get committed and secrets should not be.
 */
export function loadConfig(options: LoadConfigOptions = {}): ArbConfig {
	const env = options.env ?? process.env;
	let merged: unknown = DEFAULT_CONFIG;

	if (options.file) {
		const path = isAbsolute(options.file) ? options.file : resolve(process.cwd(), options.file);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new ConfigError(`cannot read config file ${path}: ${(error as Error).message}`);
		}
		if (!isObject(parsed)) throw new ConfigError(`config file ${path} must contain a JSON object`);
		const binance = parsed.binance;
		if (isObject(binance) && (binance.apiKey !== undefined || binance.apiSecret !== undefined)) {
			throw new ConfigError(
				`config file ${path} contains API credentials; set BINANCE_API_KEY and BINANCE_API_SECRET in the environment instead`,
			);
		}
		merged = mergeInto(merged, parsed, "");
	}

	merged = mergeInto(merged, envOverrides(env), "");
	if (options.overrides) merged = mergeInto(merged, options.overrides, "");

	const config = merged as ArbConfig;
	const withCredentials: ArbConfig = {
		...config,
		binance: {
			...config.binance,
			apiKey: env.BINANCE_API_KEY || config.binance.apiKey,
			apiSecret: env.BINANCE_API_SECRET || config.binance.apiSecret,
		},
	};
	const resolved = applyTestnet(withCredentials);
	validateConfig(resolved);
	return resolved;
}

function envOverrides(env: NodeJS.ProcessEnv): Json {
	const overrides: Json = {};
	if (env.ARB_MODE) {
		if (env.ARB_MODE !== "paper" && env.ARB_MODE !== "live") {
			throw new ConfigError(`ARB_MODE must be "paper" or "live", got ${JSON.stringify(env.ARB_MODE)}`);
		}
		overrides.mode = env.ARB_MODE;
	}
	if (env.ARB_TESTNET === "1" || env.ARB_TESTNET === "true") {
		overrides.binance = { testnet: true };
	}
	if (env.ARB_LOG_LEVEL) {
		overrides.observability = { logLevel: env.ARB_LOG_LEVEL };
	}
	return overrides;
}

/** Testnet selects its own hosts unless the operator pinned explicit URLs. */
function applyTestnet(config: ArbConfig): ArbConfig {
	if (!config.binance.testnet) return config;
	const rest = config.binance.restBaseUrl === BINANCE_MAINNET_REST ? BINANCE_TESTNET_REST : config.binance.restBaseUrl;
	const ws = config.binance.wsBaseUrl === BINANCE_MAINNET_WS ? BINANCE_TESTNET_WS : config.binance.wsBaseUrl;
	return { ...config, binance: { ...config.binance, restBaseUrl: rest, wsBaseUrl: ws } };
}

function requirePositive(value: number, path: string): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new ConfigError(`${path} must be a positive number, got ${JSON.stringify(value)}`);
	}
}

function requireNonNegative(value: number, path: string): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new ConfigError(`${path} must be zero or greater, got ${JSON.stringify(value)}`);
	}
}

function requireFraction(value: number, path: string): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
		throw new ConfigError(`${path} must be in (0, 1], got ${JSON.stringify(value)}`);
	}
}

export function validateConfig(config: ArbConfig): void {
	if (config.mode !== "paper" && config.mode !== "live") {
		throw new ConfigError(`mode must be "paper" or "live", got ${JSON.stringify(config.mode)}`);
	}

	requirePositive(config.binance.recvWindowMs, "binance.recvWindowMs");
	if (config.binance.recvWindowMs > 60_000) throw new ConfigError("binance.recvWindowMs cannot exceed 60000");
	requirePositive(config.binance.requestTimeoutMs, "binance.requestTimeoutMs");
	if (config.binance.streamsPerConnection < 1 || config.binance.streamsPerConnection > 200) {
		throw new ConfigError("binance.streamsPerConnection must be between 1 and 200");
	}
	for (const [key, url] of [
		["binance.restBaseUrl", config.binance.restBaseUrl],
		["binance.wsBaseUrl", config.binance.wsBaseUrl],
	] as const) {
		try {
			new URL(url);
		} catch {
			throw new ConfigError(`${key} is not a valid URL: ${JSON.stringify(url)}`);
		}
	}

	if (config.universe.quoteAssets.length === 0) throw new ConfigError("universe.quoteAssets cannot be empty");
	if (config.universe.maxSymbols < 3) throw new ConfigError("universe.maxSymbols must be at least 3");

	requireNonNegative(config.fees.takerBps, "fees.takerBps");
	if (config.fees.takerBps > 500) throw new ConfigError("fees.takerBps above 500 is almost certainly a mistake");

	if (config.detection.maxCycleLength < 3 || config.detection.maxCycleLength > 4) {
		throw new ConfigError("detection.maxCycleLength must be 3 or 4");
	}
	requireNonNegative(config.detection.minNetEdgeBps, "detection.minNetEdgeBps");
	requirePositive(config.detection.maxBookAgeMs, "detection.maxBookAgeMs");
	requireNonNegative(config.detection.screenMarginBps, "detection.screenMarginBps");
	if (config.detection.screenMarginBps > config.detection.minNetEdgeBps) {
		throw new ConfigError("detection.screenMarginBps cannot exceed detection.minNetEdgeBps");
	}

	if (config.execution.startAssets.length === 0) throw new ConfigError("execution.startAssets cannot be empty");
	requirePositive(config.execution.maxNotionalPerCycle, "execution.maxNotionalPerCycle");
	requirePositive(config.execution.minNotionalPerCycle, "execution.minNotionalPerCycle");
	if (config.execution.minNotionalPerCycle > config.execution.maxNotionalPerCycle) {
		throw new ConfigError("execution.minNotionalPerCycle cannot exceed execution.maxNotionalPerCycle");
	}
	requireFraction(config.execution.depthUtilization, "execution.depthUtilization");
	requireNonNegative(config.execution.aggressionTicks, "execution.aggressionTicks");
	requirePositive(config.execution.cycleDeadlineMs, "execution.cycleDeadlineMs");
	if (config.execution.maxConcurrentCycles < 1) throw new ConfigError("execution.maxConcurrentCycles must be >= 1");
	requireNonNegative(config.execution.unwind.maxAttempts, "execution.unwind.maxAttempts");

	requirePositive(config.risk.maxDailyLoss, "risk.maxDailyLoss");
	requirePositive(config.risk.maxConsecutiveFailures, "risk.maxConsecutiveFailures");
	requirePositive(config.risk.maxOrdersPerSecond, "risk.maxOrdersPerSecond");
	requirePositive(config.risk.maxClockSkewMs, "risk.maxClockSkewMs");
	requireNonNegative(config.risk.minTimeBetweenCyclesMs, "risk.minTimeBetweenCyclesMs");
	if (!config.risk.accountingAsset) throw new ConfigError("risk.accountingAsset cannot be empty");

	requireNonNegative(config.paper.latencyMs, "paper.latencyMs");
	if (config.paper.fillProbability <= 0 || config.paper.fillProbability > 1) {
		throw new ConfigError("paper.fillProbability must be in (0, 1]");
	}
	requireFraction(config.paper.depthConsumptionRatio, "paper.depthConsumptionRatio");
	requireNonNegative(config.paper.adverseSelectionBps, "paper.adverseSelectionBps");

	const levels: LogLevel[] = ["debug", "info", "warn", "error"];
	if (!levels.includes(config.observability.logLevel)) {
		throw new ConfigError(`observability.logLevel must be one of ${levels.join(", ")}`);
	}
}

export interface LiveGateResult {
	readonly allowed: boolean;
	readonly reasons: readonly string[];
}

/**
 * Decides whether live order placement is permitted.
 *
 * Live mode is deliberately hard to enter by accident: the config must ask for it, the operator
 * must set an explicit confirmation phrase in the environment, credentials must be present, and
 * the caller must have passed `--live`. Any missing condition downgrades the run to paper rather
 * than aborting, so a mis-set environment variable costs a paper session, not capital.
 */
export function evaluateLiveGate(
	config: ArbConfig,
	env: NodeJS.ProcessEnv = process.env,
	cliLiveFlag = false,
): LiveGateResult {
	const reasons: string[] = [];
	if (config.mode !== "live") reasons.push('config mode is not "live"');
	if (!cliLiveFlag) reasons.push("the --live flag was not passed");
	if (env[LIVE_CONFIRMATION_ENV] !== LIVE_CONFIRMATION_PHRASE) {
		reasons.push(`${LIVE_CONFIRMATION_ENV} is not set to ${LIVE_CONFIRMATION_PHRASE}`);
	}
	if (!config.binance.apiKey) reasons.push("BINANCE_API_KEY is not set");
	if (!config.binance.apiSecret) reasons.push("BINANCE_API_SECRET is not set");
	return { allowed: reasons.length === 0, reasons };
}
