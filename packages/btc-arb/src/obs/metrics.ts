/**
 * Counters and latency distributions.
 *
 * Latency is kept as a bounded reservoir rather than a running mean: the mean hides exactly the
 * thing that matters for arbitrage, which is the tail. A p99 round trip of 800ms means one order
 * in a hundred arrives long after its signal expired.
 */
export class Metrics {
	private readonly counters = new Map<string, number>();
	private readonly gauges = new Map<string, number>();
	private readonly samples = new Map<string, number[]>();
	private readonly startedAt: number;

	constructor(
		private readonly sampleCapacity = 2048,
		private readonly now: () => number = Date.now,
	) {
		this.startedAt = this.now();
	}

	increment(name: string, delta = 1): void {
		this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
	}

	gauge(name: string, value: number): void {
		this.gauges.set(name, value);
	}

	/** Records a latency or size sample. The reservoir keeps the most recent `sampleCapacity`. */
	observe(name: string, value: number): void {
		if (!Number.isFinite(value)) return;
		let list = this.samples.get(name);
		if (!list) {
			list = [];
			this.samples.set(name, list);
		}
		list.push(value);
		if (list.length > this.sampleCapacity) list.shift();
	}

	counter(name: string): number {
		return this.counters.get(name) ?? 0;
	}

	/** Linear-interpolated percentile over the current reservoir. */
	percentile(name: string, quantile: number): number {
		const list = this.samples.get(name);
		if (!list || list.length === 0) return 0;
		const sorted = [...list].sort((a, b) => a - b);
		const position = Math.min(sorted.length - 1, Math.max(0, quantile * (sorted.length - 1)));
		const lower = Math.floor(position);
		const upper = Math.ceil(position);
		if (lower === upper) return sorted[lower];
		return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
	}

	mean(name: string): number {
		const list = this.samples.get(name);
		if (!list || list.length === 0) return 0;
		let total = 0;
		for (const value of list) total += value;
		return total / list.length;
	}

	get uptimeMs(): number {
		return this.now() - this.startedAt;
	}

	snapshot(): Record<string, number> {
		const result: Record<string, number> = { uptime_ms: this.uptimeMs };
		for (const [name, value] of this.counters) result[name] = value;
		for (const [name, value] of this.gauges) result[name] = value;
		for (const name of this.samples.keys()) {
			result[`${name}_p50`] = round2(this.percentile(name, 0.5));
			result[`${name}_p95`] = round2(this.percentile(name, 0.95));
			result[`${name}_p99`] = round2(this.percentile(name, 0.99));
			result[`${name}_mean`] = round2(this.mean(name));
		}
		return result;
	}
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
