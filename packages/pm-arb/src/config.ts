import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LogLevel } from "./util/logger.js";

/**
 * Configuration for the Polymarket US scanner.
 *
 * Scan-first by design: this package currently detects and measures, and does not place orders.
 * Execution arrives only after two venue properties are settled from real data - whether the book
 * is unified across LONG/SHORT, and whether matched pairs net capital-free - because both were
 * left as marked assumptions rather than guesses. Credentials are environment-only, same policy
 * as btc-arb: a config file carrying them is rejected at load.
 */

export const KEY_ID_ENV = "POLYMARKET_KEY_ID";
export const SECRET_KEY_ENV = "POLYMARKET_SECRET_KEY";

export interface VenueConfig {
	readonly gatewayBaseUrl: string;
	readonly apiBaseUrl: string;
	readonly keyId?: string;
	readonly secretKey?: string;
	readonly requestTimeoutMs: number;
}

export interface UniverseConfig {
	/** Most liquid events first; each contributes its outcome markets. */
	readonly maxEvents: number;
	/** Hard cap on subscribed markets across all events (10 per WS connection). */
	readonly maxMarkets: number;
}

export interface FeesConfig {
	/** Taker rate in the venue's rate x p x (1-p) formula. Verify with doctor; never trust. */
	readonly takerRate: string;
	readonly makerRebateRate: string;
}

export interface DetectionConfig {
	/** Net dollars per $1 set required to report an opportunity. */
	readonly minNetPerSet: number;
	readonly maxBookAgeMs: number;
	readonly maxBookAgeCeilingMs: number;
}

export interface ObservabilityConfig {
	readonly logLevel: LogLevel;
	readonly metricsIntervalMs: number;
}

export interface PmArbConfig {
	readonly venue: VenueConfig;
	readonly universe: UniverseConfig;
	readonly fees: FeesConfig;
	readonly detection: DetectionConfig;
	readonly observability: ObservabilityConfig;
}

export const DEFAULT_CONFIG: PmArbConfig = {
	venue: {
		gatewayBaseUrl: "https://gateway.polymarket.us",
		apiBaseUrl: "https://api.polymarket.us",
		requestTimeoutMs: 5000,
	},
	universe: {
		maxEvents: 12,
		maxMarkets: 40,
	},
	fees: {
		takerRate: "0.05",
		makerRebateRate: "0.0125",
	},
	detection: {
		minNetPerSet: 0.005,
		maxBookAgeMs: 10_000,
		// Prediction markets sit untouched for minutes; their own cadence governs, capped here.
		maxBookAgeCeilingMs: 120_000,
	},
	observability: {
		logLevel: "info",
		metricsIntervalMs: 30_000,
	},
};

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export interface LoadConfigOptions {
	readonly file?: string;
	readonly overrides?: unknown;
	readonly env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): PmArbConfig {
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
		const venue = parsed.venue;
		if (isObject(venue) && (venue.keyId !== undefined || venue.secretKey !== undefined)) {
			throw new ConfigError(
				`config file ${path} contains API credentials; set ${KEY_ID_ENV} and ${SECRET_KEY_ENV} in the environment instead`,
			);
		}
		merged = mergeInto(merged, parsed, "");
	}
	if (options.overrides !== undefined) merged = mergeInto(merged, options.overrides, "");

	const config = merged as PmArbConfig;
	const withCreds: PmArbConfig = {
		...config,
		venue: {
			...config.venue,
			keyId: env[KEY_ID_ENV] || undefined,
			secretKey: env[SECRET_KEY_ENV] || undefined,
		},
	};
	validateConfig(withCreds);
	return withCreds;
}

export function validateConfig(config: PmArbConfig): void {
	for (const [name, url] of [
		["venue.gatewayBaseUrl", config.venue.gatewayBaseUrl],
		["venue.apiBaseUrl", config.venue.apiBaseUrl],
	] as const) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new ConfigError(`${name} is not a valid URL: ${url}`);
		}
		const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
		if (parsed.protocol !== "https:" && !local) {
			throw new ConfigError(`${name} must use https: outside localhost`);
		}
	}
	requirePositive(config.venue.requestTimeoutMs, "venue.requestTimeoutMs");
	requirePositive(config.universe.maxEvents, "universe.maxEvents");
	requirePositive(config.universe.maxMarkets, "universe.maxMarkets");
	requirePositive(config.detection.maxBookAgeMs, "detection.maxBookAgeMs");
	requireNonNegative(config.detection.maxBookAgeCeilingMs, "detection.maxBookAgeCeilingMs");
	requireNonNegative(config.detection.minNetPerSet, "detection.minNetPerSet");
	for (const [name, value] of [
		["fees.takerRate", config.fees.takerRate],
		["fees.makerRebateRate", config.fees.makerRebateRate],
	] as const) {
		const rate = Number(value);
		if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
			throw new ConfigError(`${name} must be a rate between 0 and 1, got ${value}`);
		}
	}
	if (!["debug", "info", "warn", "error"].includes(config.observability.logLevel)) {
		throw new ConfigError(`observability.logLevel is not a known level: ${config.observability.logLevel}`);
	}
}

function requirePositive(value: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number`);
}

function requireNonNegative(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new ConfigError(`${name} must be a non-negative number`);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge with unknown-key rejection, so a typo fails loudly instead of silently defaulting. */
function mergeInto(base: unknown, override: unknown, path: string): unknown {
	if (!isObject(base) || !isObject(override)) return override;
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const fullPath = path ? `${path}.${key}` : key;
		if (!(key in base)) throw new ConfigError(`unknown config key: ${fullPath}`);
		result[key] = mergeInto(base[key], value, fullPath);
	}
	return result;
}
