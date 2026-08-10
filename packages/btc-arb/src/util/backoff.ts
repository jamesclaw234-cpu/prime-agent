export interface BackoffOptions {
	readonly initialMs: number;
	readonly maxMs: number;
	readonly factor: number;
	/** Fraction of the delay replaced by uniform jitter, 0 to 1. */
	readonly jitter: number;
	readonly random?: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
	initialMs: 500,
	maxMs: 30_000,
	factor: 2,
	jitter: 0.5,
};

/**
 * Exponential backoff with jitter.
 *
 * Jitter matters more than usual here: a WebSocket shard fleet that all reconnects on the same
 * schedule will trip Binance's per-IP connection rate limit and lock every shard out at once.
 */
export class Backoff {
	private attempt = 0;
	private readonly random: () => number;

	constructor(private readonly options: BackoffOptions = DEFAULT_BACKOFF) {
		this.random = options.random ?? Math.random;
	}

	/** Consumes one attempt and returns the delay to wait. */
	next(): number {
		const raw = Math.min(this.options.maxMs, this.options.initialMs * this.options.factor ** this.attempt);
		this.attempt++;
		const jitterSpan = raw * this.options.jitter;
		return Math.round(raw - jitterSpan + this.random() * jitterSpan * 2) || 1;
	}

	/** Number of consecutive failures recorded so far. */
	get attempts(): number {
		return this.attempt;
	}

	reset(): void {
		this.attempt = 0;
	}
}

/** Promise-based sleep that resolves early when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(finish, ms);
		function finish(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		}
		signal?.addEventListener("abort", finish, { once: true });
	});
}
