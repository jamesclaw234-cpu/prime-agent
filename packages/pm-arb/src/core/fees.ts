import { type Dec, decFromString, decMul, decSub, ONE, ZERO } from "../util/decimal.js";

/**
 * Fee model for Polymarket US event contracts.
 *
 * The venue's taker fee scales with price uncertainty:
 *
 *     fee = shares x feeRate x p x (1 - p)
 *
 * worst at 50c (a 0.05 rate costs 1.25c per share there) and near zero at the tails. Makers are
 * REBATED at a separate rate - resting orders earn. Both rates live in config and nothing in this
 * package hardcodes them, because the last venue's fee assumption was off by 5x and the error was
 * invisible until measured. `doctor` verifies the configured rates against a real order preview,
 * and executed orders report `commissionsBasisPoints` to reconcile against.
 */
export interface FeeModel {
	/** Taker fee rate, e.g. 0.05. Applied as rate x p x (1-p) per share. */
	readonly takerRate: Dec;
	/** Maker rebate rate as a POSITIVE number, e.g. 0.0125; credited, not charged. */
	readonly makerRebateRate: Dec;
}

export function makeFeeModel(takerRate: string, makerRebateRate: string): FeeModel {
	return { takerRate: decFromString(takerRate), makerRebateRate: decFromString(makerRebateRate) };
}

export const ZERO_FEES: FeeModel = { takerRate: ZERO, makerRebateRate: ZERO };

/** Taker fee for ONE share at price `p`, in dollars. */
export function takerFeePerShare(fee: FeeModel, price: Dec): Dec {
	return decMul(decMul(fee.takerRate, price), decSub(ONE, price));
}

/**
 * Net edge, in dollars per set, of buying one share of every leg in `prices` when the set is
 * guaranteed to pay exactly $1 at settlement.
 *
 * Applies the taker fee to every leg. Positive means locked profit before size and fill risk;
 * the GROSS edge (1 - sum of prices) is reported separately because it is fee-independent - the
 * line that stays meaningful even if the configured rates turn out wrong.
 */
export function setEdgePerDollar(fee: FeeModel, prices: readonly Dec[]): { gross: Dec; net: Dec } {
	let cost = ZERO;
	let fees = ZERO;
	for (const price of prices) {
		cost = (cost + price) as Dec;
		fees = (fees + takerFeePerShare(fee, price)) as Dec;
	}
	const gross = decSub(ONE, cost);
	return { gross, net: decSub(gross, fees) };
}
