/**
 * Fixed-point decimal arithmetic backed by BigInt.
 *
 * Every monetary value in this package - prices, quantities, fees, PnL - is a `Dec`: a BigInt
 * scaled by 10^18. Binary floating point cannot represent 0.1 exactly, and an arbitrage cycle
 * multiplies three prices together and compares the result against 1.0 with a margin measured in
 * basis points. Float error at that margin is the difference between a profitable trade and a
 * losing one, so floats are used only for fast screening (see `core/pricing.ts`) and never for a
 * decision that sends an order.
 *
 * `Dec` is branded so a raw BigInt cannot be passed where a scaled value is expected.
 */

declare const DEC_BRAND: unique symbol;

/** A decimal number, stored as an integer scaled by 10^`DEC_DECIMALS`. */
export type Dec = bigint & { readonly [DEC_BRAND]: true };

export const DEC_DECIMALS = 18;

/** The scale factor: `1` as a `Dec`. */
export const DEC_ONE = 10n ** BigInt(DEC_DECIMALS);
export const ZERO = 0n as Dec;
export const ONE = DEC_ONE as Dec;

const POW10: readonly bigint[] = Array.from({ length: DEC_DECIMALS + 1 }, (_, i) => 10n ** BigInt(i));

/** Matches an optionally signed decimal with an optional exponent, e.g. `-1.25`, `1E-8`, `.5`. */
const NUMERIC = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export class DecimalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DecimalError";
	}
}

/**
 * Parses a decimal string into a `Dec`.
 *
 * Fraction digits beyond `DEC_DECIMALS` are truncated toward zero rather than rejected: exchange
 * payloads occasionally carry more precision than they can actually trade, and truncation toward
 * zero can only ever under-state a value we hold.
 */
export function decFromString(input: string): Dec {
	const text = input.trim();
	if (text.length === 0) throw new DecimalError("empty decimal string");
	const match = NUMERIC.exec(text);
	if (!match) throw new DecimalError(`not a decimal number: ${JSON.stringify(input)}`);

	const [, sign, intPart = "", fracPart = "", expPart] = match;
	if (intPart.length === 0 && fracPart.length === 0) {
		throw new DecimalError(`not a decimal number: ${JSON.stringify(input)}`);
	}

	// Shift the decimal point by the exponent, then re-split into integer and fraction digits.
	const exponent = expPart ? Number.parseInt(expPart, 10) : 0;
	if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
		throw new DecimalError(`exponent out of range: ${JSON.stringify(input)}`);
	}

	const digits = intPart + fracPart;
	// Position of the decimal point measured in digits from the right.
	let pointFromRight = fracPart.length - exponent;

	let scaled: bigint;
	if (pointFromRight > DEC_DECIMALS) {
		const drop = pointFromRight - DEC_DECIMALS;
		if (drop >= digits.length) {
			scaled = 0n;
		} else {
			scaled = BigInt(digits.slice(0, digits.length - drop));
		}
		pointFromRight = DEC_DECIMALS;
	} else {
		scaled = digits.length === 0 ? 0n : BigInt(digits);
	}

	const shift = DEC_DECIMALS - pointFromRight;
	if (shift > 0) scaled *= 10n ** BigInt(shift);
	return (sign === "-" ? -scaled : scaled) as Dec;
}

/** Parses a decimal string, returning `undefined` instead of throwing. */
export function decTryFromString(input: string): Dec | undefined {
	try {
		return decFromString(input);
	} catch {
		return undefined;
	}
}

/**
 * Converts a JS number to a `Dec`.
 *
 * Only safe for values that originate as decimal literals (config, test fixtures). Never use this
 * on a value derived from float arithmetic on prices - route those through `decFromString`.
 */
export function decFromNumber(value: number): Dec {
	if (!Number.isFinite(value)) throw new DecimalError(`not a finite number: ${value}`);
	return decFromString(value.toFixed(DEC_DECIMALS));
}

/** Builds a `Dec` from an integer count of the smallest unit, e.g. `decFromScaled(5n)` is 5e-18. */
export function decFromScaled(scaled: bigint): Dec {
	return scaled as Dec;
}

/** A rate expressed in basis points, e.g. `decFromBps(10)` is 0.001. */
export function decFromBps(bps: number): Dec {
	return decDiv(decFromNumber(bps), decFromNumber(10_000));
}

/** Expresses `value` in basis points as a float, for logging and thresholds. */
export function decToBps(value: Dec): number {
	return decToNumber(decMul(value, decFromNumber(10_000)));
}

export function decAdd(a: Dec, b: Dec): Dec {
	return (a + b) as Dec;
}

export function decSub(a: Dec, b: Dec): Dec {
	return (a - b) as Dec;
}

export function decNeg(a: Dec): Dec {
	return -a as Dec;
}

export function decAbs(a: Dec): Dec {
	return (a < 0n ? -a : a) as Dec;
}

/** Truncates toward zero, mirroring BigInt division. */
function divTruncate(numerator: bigint, denominator: bigint): bigint {
	return numerator / denominator;
}

/** Rounds toward negative infinity. */
function divFloor(numerator: bigint, denominator: bigint): bigint {
	const quotient = numerator / denominator;
	const remainder = numerator % denominator;
	if (remainder !== 0n && numerator < 0n !== denominator < 0n) return quotient - 1n;
	return quotient;
}

/** Rounds toward positive infinity. */
function divCeil(numerator: bigint, denominator: bigint): bigint {
	const quotient = numerator / denominator;
	const remainder = numerator % denominator;
	if (remainder !== 0n && numerator < 0n === denominator < 0n) return quotient + 1n;
	return quotient;
}

/** Multiplies, truncating toward zero. All trading quantities are non-negative, so this is a floor. */
export function decMul(a: Dec, b: Dec): Dec {
	return divTruncate(a * b, DEC_ONE) as Dec;
}

/** Multiplies, rounding away from zero. Use where under-stating a cost would be unsafe. */
export function decMulCeil(a: Dec, b: Dec): Dec {
	return divCeil(a * b, DEC_ONE) as Dec;
}

/** Divides, truncating toward zero. */
export function decDiv(a: Dec, b: Dec): Dec {
	if (b === 0n) throw new DecimalError("division by zero");
	return divTruncate(a * DEC_ONE, b) as Dec;
}

/** Divides, rounding away from zero. */
export function decDivCeil(a: Dec, b: Dec): Dec {
	if (b === 0n) throw new DecimalError("division by zero");
	return divCeil(a * DEC_ONE, b) as Dec;
}

export function decCmp(a: Dec, b: Dec): -1 | 0 | 1 {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

export function decLt(a: Dec, b: Dec): boolean {
	return a < b;
}

export function decLte(a: Dec, b: Dec): boolean {
	return a <= b;
}

export function decGt(a: Dec, b: Dec): boolean {
	return a > b;
}

export function decGte(a: Dec, b: Dec): boolean {
	return a >= b;
}

export function decEq(a: Dec, b: Dec): boolean {
	return a === b;
}

export function decIsZero(a: Dec): boolean {
	return a === 0n;
}

export function decIsPositive(a: Dec): boolean {
	return a > 0n;
}

export function decIsNegative(a: Dec): boolean {
	return a < 0n;
}

export function decMin(a: Dec, b: Dec): Dec {
	return a <= b ? a : b;
}

export function decMax(a: Dec, b: Dec): Dec {
	return a >= b ? a : b;
}

export function decMinOf(values: readonly Dec[]): Dec {
	if (values.length === 0) throw new DecimalError("decMinOf of empty list");
	let result = values[0];
	for (let i = 1; i < values.length; i++) result = decMin(result, values[i]);
	return result;
}

/**
 * Rounds `value` down to the nearest multiple of `step`, toward negative infinity.
 *
 * This is the direction required for order quantities: sending more than the exchange's LOT_SIZE
 * grid allows is rejected, and sending more than we actually hold is a failed leg.
 */
export function decFloorToStep(value: Dec, step: Dec): Dec {
	if (step <= 0n) throw new DecimalError("step must be positive");
	return (divFloor(value, step) * step) as Dec;
}

/** Rounds `value` up to the nearest multiple of `step`, toward positive infinity. */
export function decCeilToStep(value: Dec, step: Dec): Dec {
	if (step <= 0n) throw new DecimalError("step must be positive");
	return (divCeil(value, step) * step) as Dec;
}

/** True when `value` sits exactly on the `step` grid. */
export function decIsOnStep(value: Dec, step: Dec): boolean {
	if (step <= 0n) throw new DecimalError("step must be positive");
	return value % step === 0n;
}

/**
 * Number of fraction digits implied by a step size, e.g. `0.001` yields 3.
 *
 * Binance rejects an order whose quantity or price carries more fraction digits than the relevant
 * filter's step, so this drives outbound formatting.
 */
export function decScaleOf(step: Dec): number {
	if (step <= 0n) throw new DecimalError("step must be positive");
	for (let digits = 0; digits < DEC_DECIMALS; digits++) {
		if (step % POW10[DEC_DECIMALS - digits] === 0n) return digits;
	}
	return DEC_DECIMALS;
}

/** Renders `value` with exactly `digits` fraction digits, truncating toward zero. */
export function decToFixed(value: Dec, digits: number): string {
	if (!Number.isInteger(digits) || digits < 0 || digits > DEC_DECIMALS) {
		throw new DecimalError(`digits out of range: ${digits}`);
	}
	const negative = value < 0n;
	const magnitude = negative ? -value : value;
	const truncated = magnitude / POW10[DEC_DECIMALS - digits];
	const divisor = POW10[digits];
	const whole = truncated / divisor;
	const fraction = truncated % divisor;
	const sign = negative && truncated !== 0n ? "-" : "";
	if (digits === 0) return `${sign}${whole}`;
	return `${sign}${whole}.${fraction.toString().padStart(digits, "0")}`;
}

/**
 * Renders `value` as a plain decimal string with no exponent and no trailing zeros.
 *
 * Binance rejects scientific notation in order parameters, which is exactly what
 * `Number.prototype.toString` produces for small quantities such as 1e-7.
 */
export function decToString(value: Dec): string {
	const full = decToFixed(value, DEC_DECIMALS);
	if (!full.includes(".")) return full;
	const trimmed = full.replace(/0+$/, "").replace(/\.$/, "");
	return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

/**
 * Converts to a JS number. Lossy above ~15 significant digits - display, screening and metrics
 * only, never order sizing.
 */
export function decToNumber(value: Dec): number {
	return Number(value) / Number(DEC_ONE);
}

/** Sums a list, returning zero for an empty list. */
export function decSum(values: readonly Dec[]): Dec {
	let total = 0n;
	for (const value of values) total += value;
	return total as Dec;
}
