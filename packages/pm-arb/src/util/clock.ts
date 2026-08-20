/**
 * Server clock synchronisation.
 *
 * Binance rejects a signed request whose `timestamp` falls outside `recvWindow` of the matching
 * engine's clock (error -1021). Container clocks drift, so every signed request is stamped with
 * local time plus a measured offset rather than raw local time.
 */
export class ServerClock {
	private offsetMs = 0;
	private lastSyncAt = 0;
	private lastRoundTripMs = 0;
	private samples = 0;

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Records one `GET /api/v3/time` sample.
	 *
	 * The offset assumes a symmetric round trip, so half the elapsed time is attributed to the
	 * response leg. Samples with an unusually long round trip are noisy; the caller decides whether
	 * to keep them via `maxRoundTripMs`.
	 */
	observe(requestSentAt: number, serverTimeMs: number, responseReceivedAt: number): void {
		const roundTrip = responseReceivedAt - requestSentAt;
		const localMidpoint = requestSentAt + roundTrip / 2;
		this.offsetMs = Math.round(serverTimeMs - localMidpoint);
		this.lastRoundTripMs = roundTrip;
		this.lastSyncAt = responseReceivedAt;
		this.samples++;
	}

	/** Local time corrected onto the exchange's clock. */
	timestamp(): number {
		return this.now() + this.offsetMs;
	}

	get offset(): number {
		return this.offsetMs;
	}

	get roundTripMs(): number {
		return this.lastRoundTripMs;
	}

	get synced(): boolean {
		return this.samples > 0;
	}

	/** Milliseconds since the last successful sync, or `Infinity` if never synced. */
	ageMs(): number {
		return this.samples === 0 ? Number.POSITIVE_INFINITY : this.now() - this.lastSyncAt;
	}
}

/**
 * Monotonic millisecond timer, immune to wall-clock adjustments.
 *
 * Latency measurements and deadlines use this; only the exchange-facing `timestamp` field uses
 * wall-clock time.
 */
export function monotonicNow(): number {
	return Number(process.hrtime.bigint() / 1_000_000n);
}
