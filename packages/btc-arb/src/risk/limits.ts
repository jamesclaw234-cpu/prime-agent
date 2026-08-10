import { existsSync } from "node:fs";
import type { RiskConfig } from "../config.js";
import type { CycleResult, MarketSymbol, Opportunity } from "../types.js";
import { type Dec, decAdd, decFromNumber, decGt, decIsNegative, decNeg, decToNumber, ZERO } from "../util/decimal.js";
import { type Logger, silentLogger } from "../util/logger.js";

export type RiskDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

const ALLOWED: RiskDecision = { allowed: true };

/** Prefix identifying the one halt reason that is scoped to a single UTC day. */
const DAILY_LOSS_HALT = "daily loss limit";

function deny(reason: string): RiskDecision {
	return { allowed: false, reason };
}

export interface RiskManagerOptions {
	readonly config: RiskConfig;
	readonly logger?: Logger;
	readonly now?: () => number;
	/** Injected for tests so the kill switch can be simulated without touching the filesystem. */
	readonly fileExists?: (path: string) => boolean;
}

export interface RiskSnapshot {
	readonly halted: boolean;
	readonly haltReason?: string;
	readonly openCycles: number;
	readonly dailyPnl: number;
	readonly cyclesToday: number;
	readonly consecutiveFailures: number;
	readonly errorsInWindow: number;
	readonly cooldownSymbols: number;
	readonly day: string;
}

/**
 * The layer that decides whether a detected opportunity is allowed to become an order.
 *
 * Every guard here exists because of a specific way an automated trader loses money without a
 * human noticing: a stale feed it keeps trading on, a signal that repeats and repeats because the
 * book is broken, a bug that fires a thousand orders a second, a bad day it trades all the way to
 * the bottom of. Refusing to trade is always an available and often correct answer.
 */
export class RiskManager {
	private readonly logger: Logger;
	private readonly now: () => number;
	private readonly fileExists: (path: string) => boolean;

	/**
	 * Every reason trading is currently halted.
	 *
	 * A set rather than a single string: a stranded-inventory halt raised while a daily-loss halt
	 * is already active must survive the UTC rollover that clears the daily one.
	 */
	private readonly haltReasons = new Set<string>();
	private openCycles = 0;
	private cyclesToday = 0;
	private dailyPnl: Dec = ZERO;
	private consecutiveFailures = 0;
	private lastCycleStartedAt = 0;
	private reservedOrders = 0;
	private currentDay: string;
	private readonly errorTimestamps: number[] = [];
	private readonly orderTimestamps: number[] = [];
	private readonly cooldownUntil = new Map<MarketSymbol, number>();
	private clockSkewMs = 0;
	private dataHealthy = true;
	private lastKillSwitchCheck = 0;

	constructor(private readonly options: RiskManagerOptions) {
		this.logger = options.logger ?? silentLogger();
		this.now = options.now ?? Date.now;
		this.fileExists = options.fileExists ?? existsSync;
		this.currentDay = utcDay(this.now());
	}

	/** Latest measured offset between local and exchange clocks. */
	setClockSkew(skewMs: number): void {
		this.clockSkewMs = skewMs;
	}

	/** Set false when the market data feed is disconnected or stale. */
	setDataHealthy(healthy: boolean): void {
		if (this.dataHealthy !== healthy) {
			this.logger.warn("market data health changed", { healthy });
		}
		this.dataHealthy = healthy;
	}

	get isHalted(): boolean {
		return this.haltReasons.size > 0;
	}

	get reason(): string | undefined {
		return this.haltReasons.size === 0 ? undefined : [...this.haltReasons].join("; ");
	}

	halt(reason: string): void {
		if (this.haltReasons.has(reason)) return;
		this.haltReasons.add(reason);
		this.logger.error("trading halted", { reason, activeReasons: this.haltReasons.size });
	}

	/** Clears a halt. Deliberately manual: an automatic resume defeats the purpose of halting. */
	resume(): void {
		this.haltReasons.clear();
		this.consecutiveFailures = 0;
		this.errorTimestamps.length = 0;
		this.logger.warn("trading resumed by operator");
	}

	/**
	 * Polls the kill-switch file.
	 *
	 * A file is the right interface here: it works over SSH, from a cron job, from a monitoring
	 * alert, and from a human who has never read the source. Creating it stops trading within one
	 * poll interval without needing the process to be signalled or restarted.
	 */
	checkKillSwitch(): void {
		const now = this.now();
		if (now - this.lastKillSwitchCheck < this.options.config.killSwitchPollMs) return;
		this.lastKillSwitchCheck = now;
		if (!this.options.config.killSwitchFile) return;
		if (this.fileExists(this.options.config.killSwitchFile)) {
			this.halt(`kill switch file present: ${this.options.config.killSwitchFile}`);
		}
	}

	private rolloverDay(now: number): void {
		const day = utcDay(now);
		if (day === this.currentDay) return;
		this.logger.info("risk counters rolled over", {
			previousDay: this.currentDay,
			pnl: decToNumber(this.dailyPnl),
			cycles: this.cyclesToday,
		});
		this.currentDay = day;
		this.dailyPnl = ZERO;
		this.cyclesToday = 0;
		// A daily-loss halt is scoped to its day. Every other reason survives the rollover, which
		// is why the reasons are tracked individually rather than as one collapsed string.
		for (const reason of this.haltReasons) {
			if (reason.startsWith(DAILY_LOSS_HALT)) this.haltReasons.delete(reason);
		}
	}

	private pruneWindows(now: number): void {
		const errorCutoff = now - this.options.config.errorWindowMs;
		while (this.errorTimestamps.length > 0 && this.errorTimestamps[0] < errorCutoff) this.errorTimestamps.shift();
		const orderCutoff = now - 1000;
		while (this.orderTimestamps.length > 0 && this.orderTimestamps[0] < orderCutoff) this.orderTimestamps.shift();
	}

	/** Every guard, evaluated in cheapest-first order. */
	canStartCycle(opportunity: Opportunity): RiskDecision {
		const now = this.now();
		this.rolloverDay(now);
		this.pruneWindows(now);
		this.checkKillSwitch();

		const config = this.options.config;

		if (this.isHalted) return deny(this.reason ?? "halted");
		if (!this.dataHealthy) return deny("market data feed is unhealthy");
		if (Math.abs(this.clockSkewMs) > config.maxClockSkewMs) {
			return deny(`clock skew ${this.clockSkewMs}ms exceeds ${config.maxClockSkewMs}ms`);
		}
		if (this.openCycles > 0 && this.openCycles >= this.maxConcurrent) {
			return deny("maximum concurrent cycles reached");
		}
		if (now - this.lastCycleStartedAt < config.minTimeBetweenCyclesMs) {
			return deny("minimum interval between cycles not elapsed");
		}
		if (config.maxCyclesPerDay > 0 && this.cyclesToday >= config.maxCyclesPerDay) {
			return deny("daily cycle cap reached");
		}
		if (decIsNegative(this.dailyPnl) && decGt(decNeg(this.dailyPnl), decFromNumber(config.maxDailyLoss))) {
			this.halt(`${DAILY_LOSS_HALT} of ${config.maxDailyLoss} reached`);
			return deny("daily loss limit reached");
		}
		if (this.consecutiveFailures >= config.maxConsecutiveFailures) {
			this.halt(`${this.consecutiveFailures} consecutive failed cycles`);
			return deny("too many consecutive failures");
		}
		if (this.errorTimestamps.length >= config.maxErrorsInWindow) {
			this.halt(`${this.errorTimestamps.length} errors within ${config.errorWindowMs}ms`);
			return deny("error rate circuit breaker tripped");
		}

		for (const plan of opportunity.legs) {
			const until = this.cooldownUntil.get(plan.leg.symbol);
			if (until !== undefined && until > now) return deny(`${plan.leg.symbol} is in cooldown`);
		}

		// Each leg is one order; refuse when the whole cycle would not fit the per-second budget.
		if (this.orderTimestamps.length + opportunity.legs.length > config.maxOrdersPerSecond) {
			return deny("order rate budget exhausted");
		}

		return ALLOWED;
	}

	/** Upper bound on concurrent cycles, supplied by the execution config through the bot. */
	private maxConcurrent = 1;

	setMaxConcurrentCycles(value: number): void {
		this.maxConcurrent = Math.max(1, value);
	}

	onCycleStart(opportunity: Opportunity): void {
		const now = this.now();
		this.openCycles++;
		this.cyclesToday++;
		this.lastCycleStartedAt = now;
		// Reserve the planned legs up front; `recordOrder` then accounts for anything extra the
		// executor sends, which in practice means unwind retries.
		for (let i = 0; i < opportunity.legs.length; i++) this.orderTimestamps.push(now);
		this.reservedOrders = opportunity.legs.length;
	}

	/**
	 * Records one outbound order.
	 *
	 * The first calls of a cycle are already covered by the reservation `onCycleStart` made, so
	 * only the surplus is added. Without this an unwinding cycle can emit several times its planned
	 * order count while the per-second budget still believes it sent three.
	 */
	recordOrder(): void {
		if (this.reservedOrders > 0) {
			this.reservedOrders--;
			return;
		}
		this.orderTimestamps.push(this.now());
	}

	/**
	 * Records the outcome of a cycle.
	 *
	 * `pnlInAccountingAsset` is passed separately because a cycle's PnL is denominated in its own
	 * start asset, and the daily loss limit is not.
	 */
	onCycleResult(result: CycleResult, pnlInAccountingAsset: Dec): void {
		const now = this.now();
		this.openCycles = Math.max(0, this.openCycles - 1);
		this.dailyPnl = decAdd(this.dailyPnl, pnlInAccountingAsset);

		const failed = result.outcome !== "completed";
		if (failed) {
			this.consecutiveFailures++;
			for (const fill of result.fills) this.cool(fill.leg.symbol, now);
		} else {
			this.consecutiveFailures = 0;
		}

		// Keyed off the structured field, not the outcome label: a cycle can strand inventory while
		// its outcome records the cause that got it there, such as a missed leg or a deadline.
		if (result.strandedAsset) {
			for (const fill of result.fills) this.cool(fill.leg.symbol, now);
			if (this.options.config.haltOnStranded) {
				this.halt(`inventory stranded in ${result.strandedAsset}`);
			}
		}
		if (result.outcome === "error") this.onError(result.error ?? "cycle error");

		if (
			decIsNegative(this.dailyPnl) &&
			decGt(decNeg(this.dailyPnl), decFromNumber(this.options.config.maxDailyLoss))
		) {
			this.halt(`daily loss limit of ${this.options.config.maxDailyLoss} reached`);
		}
	}

	private cool(symbol: MarketSymbol, now: number): void {
		if (this.options.config.symbolCooldownMs <= 0) return;
		this.cooldownUntil.set(symbol, now + this.options.config.symbolCooldownMs);
	}

	onError(_reason: string): void {
		this.errorTimestamps.push(this.now());
	}

	/** Releases a cycle slot when the cycle never started, e.g. it was denied after `onCycleStart`. */
	releaseSlot(): void {
		this.openCycles = Math.max(0, this.openCycles - 1);
	}

	snapshot(): RiskSnapshot {
		const now = this.now();
		this.pruneWindows(now);
		let cooling = 0;
		for (const until of this.cooldownUntil.values()) if (until > now) cooling++;
		return {
			halted: this.isHalted,
			haltReason: this.reason,
			openCycles: this.openCycles,
			dailyPnl: decToNumber(this.dailyPnl),
			cyclesToday: this.cyclesToday,
			consecutiveFailures: this.consecutiveFailures,
			errorsInWindow: this.errorTimestamps.length,
			cooldownSymbols: cooling,
			day: this.currentDay,
		};
	}
}

function utcDay(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}
