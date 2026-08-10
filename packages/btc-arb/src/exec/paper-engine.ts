import { roundQtyDown } from "../binance/filters.js";
import type { BookStore } from "../core/book.js";
import type { FeeModel } from "../core/pricing.js";
import type { Asset } from "../types.js";
import { sleep } from "../util/backoff.js";
import {
	type Dec,
	decAdd,
	decFromBps,
	decFromNumber,
	decGt,
	decIsPositive,
	decMax,
	decMin,
	decMul,
	decSub,
	ONE,
	ZERO,
} from "../util/decimal.js";
import type { ExecutionEngine, OrderOutcome, OrderRequest, SimpleFill } from "./engine.js";

export interface PaperEngineOptions {
	readonly store: BookStore;
	readonly fee: FeeModel;
	readonly startingBalances: Readonly<Record<string, number>>;
	readonly latencyMs: number;
	/** Probability a marketable order finds its quote at all. Models losing the race. */
	readonly fillProbability: number;
	/** Price degradation applied to every fill, in basis points. */
	readonly adverseSelectionBps: number;
	/** Fraction of displayed size one order is assumed able to take. */
	readonly depthConsumptionRatio: number;
	readonly seed: number;
	readonly now?: () => number;
	readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Deterministic PRNG, so a paper run is reproducible from its seed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Simulated execution against the live book.
 *
 * This exists to measure whether an edge survives contact with reality, so it is deliberately
 * pessimistic: orders are delayed before they are evaluated, fills are capped at a fraction of
 * displayed size, every fill is degraded by an adverse-selection haircut, and a configurable share
 * of orders simply miss.
 *
 * What it still cannot model, and what will therefore make paper results look better than live
 * results: queue position, market impact, and the fact that the quote you are hitting is often
 * pulled precisely because someone faster already acted on the same signal. Treat paper PnL as an
 * upper bound, not a forecast.
 */
export class PaperEngine implements ExecutionEngine {
	readonly mode = "paper" as const;
	private readonly balanceMap = new Map<Asset, Dec>();
	private readonly random: () => number;
	private readonly now: () => number;
	private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly adverse: Dec;
	private readonly depthRatio: Dec;
	private orderSeq = 0;
	private rejected = 0;
	private missed = 0;

	constructor(private readonly options: PaperEngineOptions) {
		for (const [asset, amount] of Object.entries(options.startingBalances)) {
			this.balanceMap.set(asset, decFromNumber(amount));
		}
		this.random = mulberry32(options.seed || 0x9e3779b9);
		this.now = options.now ?? Date.now;
		this.sleepFn = options.sleepFn ?? sleep;
		this.adverse = decFromBps(options.adverseSelectionBps);
		this.depthRatio = decFromNumber(Math.min(1, Math.max(0, options.depthConsumptionRatio)));
	}

	async balances(): Promise<ReadonlyMap<Asset, Dec>> {
		return new Map(this.balanceMap);
	}

	balanceOf(asset: Asset): Dec {
		return this.balanceMap.get(asset) ?? ZERO;
	}

	credit(asset: Asset, amount: Dec): void {
		this.balanceMap.set(asset, decAdd(this.balanceOf(asset), amount));
	}

	get stats(): { rejected: number; missed: number; orders: number } {
		return { rejected: this.rejected, missed: this.missed, orders: this.orderSeq };
	}

	async placeIoc(request: OrderRequest, signal?: AbortSignal): Promise<OrderOutcome> {
		const startedAt = this.now();
		this.orderSeq++;
		const orderId = `paper-${this.orderSeq}`;

		if (this.options.latencyMs > 0) await this.sleepFn(this.options.latencyMs, signal);

		const book = this.options.store.get(request.symbol);
		const empty = (status: string): OrderOutcome => ({
			orderId,
			clientOrderId: request.clientOrderId,
			status,
			executedQty: ZERO,
			quoteQty: ZERO,
			fills: [],
			latencyMs: this.now() - startedAt,
		});

		if (!book) return empty("REJECTED");

		// The book is re-read after the latency delay, so a quote that moved away during the wait
		// legitimately causes a miss - which is the single most important thing to simulate.
		const touch = request.side === "BUY" ? book.ask : book.bid;
		const crosses = request.side === "BUY" ? touch <= request.price : touch >= request.price;
		if (!crosses) {
			this.missed++;
			return empty("EXPIRED");
		}

		if (this.random() > this.options.fillProbability) {
			this.missed++;
			return empty("EXPIRED");
		}

		const displayed = request.side === "BUY" ? book.askQty : book.bidQty;
		const takeable = roundQtyDown(request.rules, decMul(displayed, this.depthRatio));
		let quantity = decMin(request.quantity, takeable);
		quantity = roundQtyDown(request.rules, quantity);
		if (!decIsPositive(quantity)) {
			this.missed++;
			return empty("EXPIRED");
		}

		// Degrade the fill, then clamp to the limit: a real IOC never fills worse than its limit.
		const degraded =
			request.side === "BUY" ? decMul(touch, decAdd(ONE, this.adverse)) : decMul(touch, decSub(ONE, this.adverse));
		const fillPrice = request.side === "BUY" ? decMin(degraded, request.price) : decMax(degraded, request.price);
		if (!decIsPositive(fillPrice)) return empty("REJECTED");

		const quoteQty = decMul(fillPrice, quantity);
		const spendAsset = request.side === "BUY" ? request.rules.quoteAsset : request.rules.baseAsset;
		const spendAmount = request.side === "BUY" ? quoteQty : quantity;
		const available = this.balanceOf(spendAsset);
		if (decGt(spendAmount, available)) {
			// Mirrors Binance error -2010: the account cannot fund the order.
			this.rejected++;
			return empty("REJECTED");
		}

		const receiveAsset = request.side === "BUY" ? request.rules.baseAsset : request.rules.quoteAsset;
		const grossReceive = request.side === "BUY" ? quantity : quoteQty;
		const commission = decMul(grossReceive, this.options.fee.takerRate);

		this.balanceMap.set(spendAsset, decSub(available, spendAmount));
		this.credit(receiveAsset, decSub(grossReceive, commission));

		const fill: SimpleFill = {
			price: fillPrice,
			qty: quantity,
			commission,
			commissionAsset: receiveAsset,
		};

		return {
			orderId,
			clientOrderId: request.clientOrderId,
			status: quantity === request.quantity ? "FILLED" : "PARTIALLY_FILLED",
			executedQty: quantity,
			quoteQty,
			fills: [fill],
			latencyMs: this.now() - startedAt,
		};
	}

	/** Total portfolio value in `asset`, using the supplied conversion. Used for reporting. */
	totalValue(convert: (amount: Dec, asset: Asset) => Dec | undefined): Dec {
		let total = ZERO;
		for (const [asset, amount] of this.balanceMap) {
			if (!decIsPositive(amount)) continue;
			const value = convert(amount, asset);
			if (value !== undefined) total = decAdd(total, value);
		}
		return total;
	}
}
