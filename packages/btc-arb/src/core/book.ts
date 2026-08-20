import type { RawBookTickerStream } from "../binance/types.js";
import type { MarketSymbol, TopOfBook } from "../types.js";
import { type Dec, decFromString, decIsPositive, decToNumber } from "../util/decimal.js";

/**
 * In-memory best bid/offer for every subscribed market.
 *
 * Each entry carries both exact `Dec` values and float mirrors. The floats drive the screening
 * pass that runs on every tick; the `Dec` values drive every decision that can send an order.
 */
export class BookStore {
	private readonly books = new Map<MarketSymbol, TopOfBook>();
	/** Smoothed gap between updates, per symbol. Bounded by the symbol count, like `books`. */
	private readonly cadence = new Map<MarketSymbol, number>();
	private updates = 0;
	private stale = 0;

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Applies a frame, rejecting out-of-order updates.
	 *
	 * Binance's `updateId` increases monotonically per symbol. Frames can arrive out of order after
	 * a reconnect, when the snapshot and the live stream race; accepting an older frame would price
	 * a cycle off a book that no longer exists.
	 */
	apply(book: TopOfBook): boolean {
		const existing = this.books.get(book.symbol);
		if (existing && book.updateId > 0 && existing.updateId > 0 && book.updateId <= existing.updateId) {
			this.stale++;
			return false;
		}
		if (existing) {
			// Exponentially smoothed, so one quiet stretch does not permanently widen the window and
			// one burst does not permanently narrow it.
			const gap = book.receivedAt - existing.receivedAt;
			if (gap > 0) {
				const previous = this.cadence.get(book.symbol);
				this.cadence.set(book.symbol, previous === undefined ? gap : previous * 0.8 + gap * 0.2);
			}
		}
		this.books.set(book.symbol, book);
		this.updates++;
		return true;
	}

	/**
	 * How long this symbol typically goes between updates, in milliseconds.
	 *
	 * `bookTicker` pushes only when the book *changes*, so on a thin market a quote standing
	 * untouched for thirty seconds is current rather than stale - the exchange has nothing new to
	 * say about it. Judging every symbol by one global window therefore discards most of the data
	 * on exactly the venues where each observation is scarcest.
	 */
	cadenceOf(symbol: MarketSymbol): number | undefined {
		return this.cadence.get(symbol);
	}

	/**
	 * The age past which this symbol's book should not be trusted.
	 *
	 * Never tighter than `base`, never wider than `ceiling`, and in between it follows the symbol's
	 * own rhythm. A dead socket is not this function's job: the feed's own watchdog covers it, and
	 * a combined stream cannot lose one symbol while the others keep flowing.
	 */
	ageLimitFor(symbol: MarketSymbol, base: number, ceiling: number): number {
		if (ceiling <= base) return base;
		const typical = this.cadence.get(symbol);
		if (typical === undefined) return base;
		return Math.min(ceiling, Math.max(base, typical * 4));
	}

	get(symbol: MarketSymbol): TopOfBook | undefined {
		return this.books.get(symbol);
	}

	has(symbol: MarketSymbol): boolean {
		return this.books.has(symbol);
	}

	get size(): number {
		return this.books.size;
	}

	get updateCount(): number {
		return this.updates;
	}

	get staleCount(): number {
		return this.stale;
	}

	symbols(): MarketSymbol[] {
		return [...this.books.keys()];
	}

	entries(): IterableIterator<[MarketSymbol, TopOfBook]> {
		return this.books.entries();
	}

	/** Age in milliseconds of the freshest frame for `symbol`, or `Infinity` when absent. */
	ageOf(symbol: MarketSymbol): number {
		const book = this.books.get(symbol);
		return book ? this.now() - book.receivedAt : Number.POSITIVE_INFINITY;
	}

	/** Symbols with no frame newer than `maxAgeMs`. Used by the health check, not the hot path. */
	staleSymbols(maxAgeMs: number): MarketSymbol[] {
		const cutoff = this.now() - maxAgeMs;
		const result: MarketSymbol[] = [];
		for (const [symbol, book] of this.books) {
			if (book.receivedAt < cutoff) result.push(symbol);
		}
		return result;
	}

	clear(): void {
		this.books.clear();
	}
}

/**
 * Converts a `@bookTicker` frame into a `TopOfBook`.
 *
 * Returns `undefined` for a crossed or empty book: a bid at or above the ask is either a transient
 * artefact of a very fast market or a malformed frame, and either way it is not something to build
 * an order on.
 */
export function bookFromStream(raw: RawBookTickerStream, receivedAt: number): TopOfBook | undefined {
	const bid = decFromString(raw.b);
	const bidQty = decFromString(raw.B);
	const ask = decFromString(raw.a);
	const askQty = decFromString(raw.A);
	if (!decIsPositive(bid) || !decIsPositive(ask) || !decIsPositive(bidQty) || !decIsPositive(askQty)) {
		return undefined;
	}
	if (bid >= ask) return undefined;
	return makeBook(raw.s, bid, bidQty, ask, askQty, raw.u, receivedAt);
}

/** Builds a `TopOfBook`, deriving the float mirrors so callers cannot forget to keep them in sync. */
export function makeBook(
	symbol: MarketSymbol,
	bid: Dec,
	bidQty: Dec,
	ask: Dec,
	askQty: Dec,
	updateId: number,
	receivedAt: number,
): TopOfBook {
	return {
		symbol,
		bid,
		bidQty,
		ask,
		askQty,
		updateId,
		receivedAt,
		bidNum: decToNumber(bid),
		bidQtyNum: decToNumber(bidQty),
		askNum: decToNumber(ask),
		askQtyNum: decToNumber(askQty),
	};
}
