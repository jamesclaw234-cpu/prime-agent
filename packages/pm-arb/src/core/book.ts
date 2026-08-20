import { type Dec, decIsPositive, decTryFromString } from "../util/decimal.js";
import type { MarketBook } from "../venue/types.js";

/** Market identifier on this venue: the slug, e.g. "btc-100k-2026". */
export type MarketSlug = string;

/**
 * Top of one market's LONG-side book, in exact decimals.
 *
 * A prediction market's book quotes the LONG (YES) side; prices are dollar strings in (0, 1).
 * Whether SHORT liquidity appears mirrored into this book (a SHORT bid at q surfacing as a LONG
 * offer at 1-q) is a venue property the detector must NOT assume either way - it changes which
 * arbitrage primitives can exist at all, and it is verifiable against one live book. Until
 * verified, detection uses only what is directly quoted here.
 */
export interface TopOfBook {
	readonly slug: MarketSlug;
	readonly bid: Dec;
	readonly bidQty: Dec;
	readonly ask: Dec;
	readonly askQty: Dec;
	/** Exchange transact time in ms since epoch, 0 when the venue omitted it. */
	readonly transactTimeMs: number;
	/** Local arrival time; freshness decisions use this, never the exchange clock. */
	readonly receivedAt: number;
}

/**
 * Latest book per market, with per-market update cadence.
 *
 * The cadence machinery is ported from the btc-arb BookStore for the same reason it exists there:
 * feeds push on change, so a quiet market's book is current rather than stale, and judging every
 * market by one global freshness window discards most of the data on exactly the venues where
 * each observation is scarcest. Prediction markets are quiet most of the time by nature.
 */
export class BookStore {
	private readonly books = new Map<MarketSlug, TopOfBook>();
	private readonly cadence = new Map<MarketSlug, number>();
	private updates = 0;
	private stale = 0;

	constructor(private readonly now: () => number = Date.now) {}

	/** Applies a book, rejecting regressions in exchange transact time after a reconnect race. */
	apply(book: TopOfBook): boolean {
		const existing = this.books.get(book.slug);
		if (
			existing &&
			book.transactTimeMs > 0 &&
			existing.transactTimeMs > 0 &&
			book.transactTimeMs < existing.transactTimeMs
		) {
			this.stale++;
			return false;
		}
		if (existing) {
			const gap = book.receivedAt - existing.receivedAt;
			if (gap > 0) {
				const previous = this.cadence.get(book.slug);
				this.cadence.set(book.slug, previous === undefined ? gap : previous * 0.8 + gap * 0.2);
			}
		}
		this.books.set(book.slug, book);
		this.updates++;
		return true;
	}

	get(slug: MarketSlug): TopOfBook | undefined {
		return this.books.get(slug);
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

	cadenceOf(slug: MarketSlug): number | undefined {
		return this.cadence.get(slug);
	}

	/** Age past which a market's book should not be trusted: its own rhythm, clamped. */
	ageLimitFor(slug: MarketSlug, base: number, ceiling: number): number {
		if (ceiling <= base) return base;
		const typical = this.cadence.get(slug);
		if (typical === undefined) return base;
		return Math.min(ceiling, Math.max(base, typical * 4));
	}

	entries(): IterableIterator<[MarketSlug, TopOfBook]> {
		return this.books.entries();
	}
}

/**
 * Converts a wire book (REST snapshot or WS MARKET_DATA payload - same shape) to a TopOfBook.
 *
 * Returns undefined for an empty or crossed book: an empty side means there is nothing to price
 * against, and a crossed book from the wire means the message is torn or the market is in an
 * auction state - either way, not a book to trade on.
 */
export function bookFromWire(raw: MarketBook, receivedAt: number): TopOfBook | undefined {
	const slug = raw.marketSlug;
	if (!slug) return undefined;
	const bestBid = raw.bids?.[0];
	const bestOffer = raw.offers?.[0];
	if (!bestBid || !bestOffer) return undefined;
	const bid = decTryFromString(bestBid.px.value);
	const bidQty = decTryFromString(bestBid.qty);
	const ask = decTryFromString(bestOffer.px.value);
	const askQty = decTryFromString(bestOffer.qty);
	if (!bid || !bidQty || !ask || !askQty) return undefined;
	if (!decIsPositive(bid) || !decIsPositive(ask) || bid >= ask) return undefined;
	const transactTimeMs = raw.transactTime ? Date.parse(raw.transactTime) || 0 : 0;
	return { slug, bid, bidQty, ask, askQty, transactTimeMs, receivedAt };
}
