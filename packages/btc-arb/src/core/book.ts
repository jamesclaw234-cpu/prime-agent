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
		this.books.set(book.symbol, book);
		this.updates++;
		return true;
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
