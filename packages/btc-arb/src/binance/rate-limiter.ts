import { sleep } from "../util/backoff.js";

export interface WindowLimit {
	readonly name: string;
	/** Window length in milliseconds. */
	readonly intervalMs: number;
	/** Maximum units permitted inside one window. */
	readonly limit: number;
}

export interface RateLimiterOptions {
	readonly limits: readonly WindowLimit[];
	/**
	 * Fraction of each published limit this process will actually use.
	 *
	 * Never 1.0: the exchange counts weight the client cannot see (other processes on the same IP,
	 * requests already in flight), and crossing the line costs an IP ban, not a retry.
	 */
	readonly safetyFactor: number;
	readonly now?: () => number;
	readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface WindowState {
	readonly limit: WindowLimit;
	/** Timestamps and sizes of consumed units, oldest first. */
	readonly entries: { at: number; units: number }[];
	used: number;
}

export class RateLimitExceededError extends Error {
	constructor(
		message: string,
		readonly retryAfterMs: number,
	) {
		super(message);
		this.name = "RateLimitExceededError";
	}
}

/**
 * Sliding-window rate limiter covering several simultaneous budgets.
 *
 * Binance enforces request weight per minute, order counts per 10 seconds and per day, and raw
 * request counts, all at once. Each is modelled as its own window; `acquire` waits for the most
 * restrictive one.
 */
export class RateLimiter {
	private readonly windows: WindowState[];
	private readonly now: () => number;
	private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly safetyFactor: number;
	/** Set when the exchange explicitly told us to back off (HTTP 429 / 418). */
	private penaltyUntil = 0;

	constructor(options: RateLimiterOptions) {
		this.windows = options.limits.map((limit) => ({ limit, entries: [], used: 0 }));
		this.now = options.now ?? Date.now;
		this.sleepFn = options.sleepFn ?? sleep;
		this.safetyFactor = options.safetyFactor;
	}

	/**
	 * Replaces the budget set, preserving usage already recorded under the same window name.
	 *
	 * Called once at startup with the authoritative limits from `exchangeInfo`. Usage is carried
	 * over so a tighter published limit takes effect immediately rather than after a fresh window.
	 */
	replaceLimits(limits: readonly WindowLimit[]): void {
		const previous = new Map(this.windows.map((window) => [window.limit.name, window]));
		this.windows.length = 0;
		for (const limit of limits) {
			const existing = previous.get(limit.name);
			this.windows.push({
				limit,
				entries: existing ? [...existing.entries] : [],
				used: existing ? existing.used : 0,
			});
		}
	}

	private effectiveLimit(window: WindowState): number {
		return Math.max(1, Math.floor(window.limit.limit * this.safetyFactor));
	}

	private prune(at: number): void {
		for (const window of this.windows) {
			const cutoff = at - window.limit.intervalMs;
			let removed = 0;
			while (removed < window.entries.length && window.entries[removed].at <= cutoff) {
				window.used -= window.entries[removed].units;
				removed++;
			}
			if (removed > 0) window.entries.splice(0, removed);
		}
	}

	/** Milliseconds to wait before `units` of `budget` would fit, or 0 if it fits now. */
	private delayFor(budgets: Readonly<Record<string, number>>, at: number): number {
		let delay = Math.max(0, this.penaltyUntil - at);
		for (const window of this.windows) {
			const units = budgets[window.limit.name] ?? 0;
			if (units <= 0) continue;
			const capacity = this.effectiveLimit(window);
			if (units > capacity) {
				throw new RateLimitExceededError(
					`a single request needs ${units} units of ${window.limit.name} but the budget is ${capacity}`,
					0,
				);
			}
			if (window.used + units <= capacity) continue;
			// Wait until enough of the oldest entries age out of the window.
			let freed = 0;
			const needed = window.used + units - capacity;
			for (const entry of window.entries) {
				freed += entry.units;
				if (freed >= needed) {
					delay = Math.max(delay, entry.at + window.limit.intervalMs - at + 1);
					break;
				}
			}
		}
		return delay;
	}

	/**
	 * Reserves capacity, waiting if necessary.
	 *
	 * `budgets` maps window names to units, e.g. `{ REQUEST_WEIGHT: 20, RAW_REQUESTS: 1 }`.
	 */
	async acquire(budgets: Readonly<Record<string, number>>, signal?: AbortSignal): Promise<void> {
		for (;;) {
			if (signal?.aborted) throw new Error("rate limiter wait aborted");
			const at = this.now();
			this.prune(at);
			const delay = this.delayFor(budgets, at);
			if (delay <= 0) {
				for (const window of this.windows) {
					const units = budgets[window.limit.name] ?? 0;
					if (units <= 0) continue;
					window.entries.push({ at, units });
					window.used += units;
				}
				return;
			}
			await this.sleepFn(delay, signal);
		}
	}

	/** True when `budgets` could be reserved immediately. Used to skip work rather than queue it. */
	canAcquire(budgets: Readonly<Record<string, number>>): boolean {
		const at = this.now();
		this.prune(at);
		try {
			return this.delayFor(budgets, at) <= 0;
		} catch {
			return false;
		}
	}

	/**
	 * Aligns the window covering `intervalMs` in the given family with the exchange's own counter.
	 *
	 * Families exist because Binance publishes the order count under one header name for several
	 * intervals at once - a 10-second budget and a daily budget are both `X-MBX-ORDER-COUNT-*` -
	 * so the interval is what identifies the window, not the name.
	 */
	syncUsageByInterval(family: string, intervalMs: number, used: number): void {
		const target = this.windows.find(
			(window) => window.limit.intervalMs === intervalMs && belongsToFamily(window.limit.name, family),
		);
		if (target) this.syncUsedWeight(target.limit.name, used);
	}

	/**
	 * Aligns local accounting with the exchange's own counter.
	 *
	 * The header is authoritative and includes usage this process cannot see, so it is treated as
	 * a floor on our own tally, never a reason to relax it.
	 */
	syncUsedWeight(windowName: string, used: number): void {
		const window = this.windows.find((w) => w.limit.name === windowName);
		if (!window || !Number.isFinite(used) || used < 0) return;
		if (used <= window.used) return;
		const at = this.now();
		const delta = used - window.used;
		window.entries.push({ at, units: delta });
		window.used = used;
	}

	/** Records an explicit back-off instruction from HTTP 429 or 418. */
	penalize(retryAfterMs: number): void {
		this.penaltyUntil = Math.max(this.penaltyUntil, this.now() + Math.max(0, retryAfterMs));
	}

	get penaltyRemainingMs(): number {
		return Math.max(0, this.penaltyUntil - this.now());
	}

	snapshot(): Record<string, { used: number; limit: number }> {
		const at = this.now();
		this.prune(at);
		const result: Record<string, { used: number; limit: number }> = {};
		for (const window of this.windows) {
			result[window.limit.name] = { used: window.used, limit: this.effectiveLimit(window) };
		}
		return result;
	}
}

/** True when a window name belongs to a header family, e.g. ORDERS_DAY is in the ORDERS family. */
function belongsToFamily(windowName: string, family: string): boolean {
	return windowName === family || windowName.startsWith(`${family}_`);
}

export const WEIGHT = "REQUEST_WEIGHT";
export const ORDERS = "ORDERS";
export const ORDERS_DAY = "ORDERS_DAY";
export const RAW_REQUESTS = "RAW_REQUESTS";

/**
 * Conservative defaults matching Binance Spot's published limits.
 *
 * These are replaced at startup by the `rateLimits` array from `exchangeInfo`, which is
 * authoritative and occasionally changes.
 */
export const DEFAULT_LIMITS: readonly WindowLimit[] = [
	{ name: WEIGHT, intervalMs: 60_000, limit: 6000 },
	{ name: ORDERS, intervalMs: 10_000, limit: 50 },
	{ name: ORDERS_DAY, intervalMs: 86_400_000, limit: 160_000 },
	{ name: RAW_REQUESTS, intervalMs: 300_000, limit: 61_000 },
];

/**
 * Rebuilds the limit set from the `rateLimits` array in `exchangeInfo`.
 *
 * The published numbers change, and the exchange tells us the current ones on every startup, so
 * the constants above are only a bootstrap. Anything unrecognised is carried through unchanged.
 */
export function limitsFromExchangeInfo(
	rateLimits: readonly { rateLimitType: string; interval: string; intervalNum: number; limit: number }[],
): WindowLimit[] {
	const intervalMs: Record<string, number> = { SECOND: 1000, MINUTE: 60_000, HOUR: 3_600_000, DAY: 86_400_000 };
	const result: WindowLimit[] = [];
	for (const entry of rateLimits) {
		const unit = intervalMs[entry.interval];
		if (!unit || !Number.isFinite(entry.limit) || entry.limit <= 0) continue;
		// Binance reports the daily order cap under the same `ORDERS` type as the 10-second cap;
		// they are separate budgets and must not collapse into one window.
		const name = entry.rateLimitType === "ORDERS" && entry.interval === "DAY" ? ORDERS_DAY : entry.rateLimitType;
		result.push({ name, intervalMs: unit * Math.max(1, entry.intervalNum), limit: entry.limit });
	}
	return result.length > 0 ? result : [...DEFAULT_LIMITS];
}
