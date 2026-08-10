import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Asset, CycleOutcome, CycleResult } from "../types.js";
import { type Dec, decAdd, decIsNegative, decToNumber, decToString, ZERO } from "../util/decimal.js";
import { type Logger, silentLogger } from "../util/logger.js";

export interface LedgerOptions {
	readonly file?: string;
	readonly accountingAsset: Asset;
	readonly logger?: Logger;
	readonly now?: () => number;
}

export interface LedgerSummary {
	readonly cycles: number;
	readonly completed: number;
	readonly byOutcome: Readonly<Record<string, number>>;
	/** Realised PnL in the accounting asset. */
	readonly realizedPnl: number;
	readonly grossProfit: number;
	readonly grossLoss: number;
	readonly winRate: number;
	/** Realised minus expected: how much worse execution was than the signal. */
	readonly totalSlippage: number;
	readonly avgSlippageBps: number;
	readonly volume: number;
	readonly commissionsByAsset: Readonly<Record<string, string>>;
	readonly strandedByAsset: Readonly<Record<string, string>>;
	readonly pnlByStartAsset: Readonly<Record<string, string>>;
}

/**
 * Append-only record of every cycle the bot attempted.
 *
 * Written as JSONL before anything is aggregated, because the aggregate is a convenience and the
 * record is the evidence. A cycle that fails halfway is written with exactly the same schema as
 * one that completes - the failures are the interesting rows.
 */
export class Ledger {
	private readonly logger: Logger;
	private readonly now: () => number;
	private fileBroken = false;

	private cycles = 0;
	private completed = 0;
	private readonly byOutcome = new Map<CycleOutcome, number>();
	private realizedPnl: Dec = ZERO;
	private grossProfit: Dec = ZERO;
	private grossLoss: Dec = ZERO;
	private wins = 0;
	private totalSlippage: Dec = ZERO;
	private slippageBpsSum = 0;
	private slippageSamples = 0;
	private volume: Dec = ZERO;
	private readonly commissions = new Map<Asset, Dec>();
	private readonly stranded = new Map<Asset, Dec>();
	private readonly pnlByStartAsset = new Map<Asset, Dec>();

	constructor(private readonly options: LedgerOptions) {
		this.logger = options.logger ?? silentLogger();
		this.now = options.now ?? Date.now;
		if (options.file) {
			try {
				mkdirSync(dirname(options.file), { recursive: true });
			} catch (error) {
				// Losing the audit trail silently is worse than losing it loudly: the ledger is the
				// only durable record of what the bot actually traded.
				this.fileBroken = true;
				this.logger.error("ledger directory is not writable; no trade record will be persisted", {
					file: options.file,
					error: (error as Error).message,
				});
			}
		}
	}

	/**
	 * Records one cycle.
	 *
	 * `pnlInAccountingAsset` is supplied by the caller rather than derived here: converting a
	 * cycle's start-asset PnL into the accounting asset needs a live book, which the ledger
	 * deliberately does not depend on.
	 */
	record(result: CycleResult, pnlInAccountingAsset: Dec, notionalInAccountingAsset: Dec): void {
		this.cycles++;
		this.byOutcome.set(result.outcome, (this.byOutcome.get(result.outcome) ?? 0) + 1);
		if (result.outcome === "completed") this.completed++;

		this.realizedPnl = decAdd(this.realizedPnl, pnlInAccountingAsset);
		this.volume = decAdd(this.volume, notionalInAccountingAsset);
		if (decIsNegative(pnlInAccountingAsset)) {
			this.grossLoss = decAdd(this.grossLoss, pnlInAccountingAsset);
		} else {
			this.grossProfit = decAdd(this.grossProfit, pnlInAccountingAsset);
			if (pnlInAccountingAsset > ZERO) this.wins++;
		}

		this.pnlByStartAsset.set(
			result.realizedPnlAsset,
			decAdd(this.pnlByStartAsset.get(result.realizedPnlAsset) ?? ZERO, result.realizedPnl),
		);

		this.totalSlippage = decAdd(this.totalSlippage, result.slippage);
		if (result.amountIn > ZERO) {
			this.slippageBpsSum += (decToNumber(result.slippage) / decToNumber(result.amountIn)) * 10_000;
			this.slippageSamples++;
		}

		for (const fill of [...result.fills, ...result.unwindFills]) {
			for (const commission of fill.commissions) {
				this.commissions.set(
					commission.asset,
					decAdd(this.commissions.get(commission.asset) ?? ZERO, commission.amount),
				);
			}
		}

		if (result.strandedAsset && result.strandedAmount) {
			this.stranded.set(
				result.strandedAsset,
				decAdd(this.stranded.get(result.strandedAsset) ?? ZERO, result.strandedAmount),
			);
		}

		this.append(result, pnlInAccountingAsset, notionalInAccountingAsset);
	}

	private append(result: CycleResult, pnl: Dec, notional: Dec): void {
		if (!this.options.file || this.fileBroken) return;
		const row = {
			ts: new Date(this.now()).toISOString(),
			opportunityId: result.opportunityId,
			cycle: result.cycleId,
			mode: result.mode,
			outcome: result.outcome,
			durationMs: result.finishedAt - result.startedAt,
			startAsset: result.realizedPnlAsset,
			amountIn: decToString(result.amountIn),
			amountOut: decToString(result.amountOut),
			realizedPnl: decToString(result.realizedPnl),
			expectedProfit: decToString(result.expectedProfit),
			slippage: decToString(result.slippage),
			pnlAccounting: decToString(pnl),
			notionalAccounting: decToString(notional),
			accountingAsset: this.options.accountingAsset,
			strandedAsset: result.strandedAsset,
			strandedAmount: result.strandedAmount ? decToString(result.strandedAmount) : undefined,
			needsReconciliation: result.needsReconciliation,
			error: result.error,
			legs: result.fills.map((fill) => ({
				symbol: fill.leg.symbol,
				side: fill.leg.side,
				requestedQty: decToString(fill.requestedQty),
				executedQty: decToString(fill.executedQty),
				quoteQty: decToString(fill.quoteQty),
				avgPrice: decToString(fill.avgPrice),
				status: fill.status,
				expiryReason: fill.expiryReason,
				orderId: fill.orderId,
				clientOrderId: fill.clientOrderId,
				latencyMs: fill.latencyMs,
				commissions: fill.commissions.map((c) => ({ asset: c.asset, amount: decToString(c.amount) })),
			})),
			unwind: result.unwindFills.map((fill) => ({
				symbol: fill.leg.symbol,
				side: fill.leg.side,
				executedQty: decToString(fill.executedQty),
				status: fill.status,
			})),
		};
		try {
			appendFileSync(this.options.file, `${JSON.stringify(row)}\n`);
		} catch (error) {
			this.fileBroken = true;
			this.logger.error("ledger write failed, continuing without persistence", {
				file: this.options.file,
				error: (error as Error).message,
			});
		}
	}

	summary(): LedgerSummary {
		return {
			cycles: this.cycles,
			completed: this.completed,
			byOutcome: Object.fromEntries(this.byOutcome),
			realizedPnl: decToNumber(this.realizedPnl),
			grossProfit: decToNumber(this.grossProfit),
			grossLoss: decToNumber(this.grossLoss),
			winRate: this.cycles === 0 ? 0 : this.wins / this.cycles,
			totalSlippage: decToNumber(this.totalSlippage),
			avgSlippageBps: this.slippageSamples === 0 ? 0 : this.slippageBpsSum / this.slippageSamples,
			volume: decToNumber(this.volume),
			commissionsByAsset: mapToStrings(this.commissions),
			strandedByAsset: mapToStrings(this.stranded),
			pnlByStartAsset: mapToStrings(this.pnlByStartAsset),
		};
	}
}

function mapToStrings(map: ReadonlyMap<Asset, Dec>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [asset, amount] of map) result[asset] = decToString(amount);
	return result;
}
