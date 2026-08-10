import { describe, expect, it } from "vitest";
import {
	DEC_DECIMALS,
	DecimalError,
	decAdd,
	decCeilToStep,
	decDiv,
	decDivCeil,
	decFloorToStep,
	decFromBps,
	decFromNumber,
	decFromString,
	decIsOnStep,
	decMul,
	decMulCeil,
	decScaleOf,
	decSub,
	decSum,
	decToBps,
	decToFixed,
	decToNumber,
	decToString,
	decTryFromString,
	ONE,
	ZERO,
} from "../src/util/decimal.js";

const d = decFromString;

describe("parsing", () => {
	it("parses plain decimals exactly", () => {
		expect(decToString(d("1"))).toBe("1");
		expect(decToString(d("0.1"))).toBe("0.1");
		expect(decToString(d("60001.12345678"))).toBe("60001.12345678");
		expect(decToString(d("-0.00000001"))).toBe("-0.00000001");
		expect(decToString(d("0"))).toBe("0");
		expect(decToString(d("-0"))).toBe("0");
	});

	it("accepts the formats Binance and config files actually produce", () => {
		expect(decToString(d("  1.5  "))).toBe("1.5");
		expect(decToString(d("+2.25"))).toBe("2.25");
		expect(decToString(d(".5"))).toBe("0.5");
		expect(decToString(d("5."))).toBe("5");
		expect(decToString(d("1e-8"))).toBe("0.00000001");
		expect(decToString(d("1E3"))).toBe("1000");
		expect(decToString(d("0.00000000"))).toBe("0");
	});

	it("rejects anything that is not a number", () => {
		expect(() => d("abc")).toThrow(DecimalError);
		expect(() => d("")).toThrow(DecimalError);
		expect(() => d("1.2.3")).toThrow(DecimalError);
		expect(() => d(".")).toThrow(DecimalError);
		expect(decTryFromString("nope")).toBeUndefined();
	});

	it("truncates excess precision toward zero rather than rejecting it", () => {
		const value = d(`0.${"1".repeat(DEC_DECIMALS + 4)}`);
		expect(decToFixed(value, DEC_DECIMALS)).toBe(`0.${"1".repeat(DEC_DECIMALS)}`);
	});

	it("survives a round trip through the float mirror for realistic prices", () => {
		for (const text of ["60001.12", "0.05000100", "3000.10", "0.00001234"]) {
			expect(decToNumber(d(text))).toBeCloseTo(Number(text), 8);
		}
	});
});

describe("arithmetic", () => {
	it("adds and subtracts exactly where floats do not", () => {
		// 0.1 + 0.2 !== 0.3 in binary floating point.
		expect(decToString(decAdd(d("0.1"), d("0.2")))).toBe("0.3");
		expect(decToString(decSub(d("0.3"), d("0.1")))).toBe("0.2");
		expect(decToString(decSum([d("0.1"), d("0.2"), d("0.3")]))).toBe("0.6");
	});

	it("multiplies and divides with the documented rounding direction", () => {
		expect(decToString(decMul(d("1.5"), d("2")))).toBe("3");
		expect(decToString(decDiv(d("1"), d("3")))).toBe("0.333333333333333333");
		// Truncation toward zero never invents value.
		expect(decMul(d("0.000000000000000001"), d("0.5"))).toBe(ZERO);
		expect(decToString(decMulCeil(d("0.000000000000000001"), d("0.5")))).toBe("0.000000000000000001");
		expect(decToString(decDivCeil(d("1"), d("3")))).toBe("0.333333333333333334");
	});

	it("refuses to divide by zero", () => {
		expect(() => decDiv(ONE, ZERO)).toThrow(DecimalError);
	});

	it("converts basis points both ways", () => {
		expect(decToString(decFromBps(10))).toBe("0.001");
		expect(decToString(decFromBps(7.5))).toBe("0.00075");
		expect(decToBps(d("0.001"))).toBeCloseTo(10, 9);
	});
});

describe("step rounding", () => {
	it("floors to the lot grid", () => {
		expect(decToString(decFloorToStep(d("1.23456789"), d("0.001")))).toBe("1.234");
		expect(decToString(decFloorToStep(d("1.999"), d("1")))).toBe("1");
		expect(decToString(decFloorToStep(d("0.0009"), d("0.001")))).toBe("0");
	});

	it("floors toward negative infinity, not toward zero", () => {
		expect(decToString(decFloorToStep(d("-1.5"), d("1")))).toBe("-2");
		expect(decToString(decCeilToStep(d("-1.5"), d("1")))).toBe("-1");
	});

	it("ceils to the tick grid", () => {
		expect(decToString(decCeilToStep(d("1.2341"), d("0.001")))).toBe("1.235");
		expect(decToString(decCeilToStep(d("1.234"), d("0.001")))).toBe("1.234");
	});

	it("recognises values already on the grid", () => {
		expect(decIsOnStep(d("1.234"), d("0.001"))).toBe(true);
		expect(decIsOnStep(d("1.2345"), d("0.001"))).toBe(false);
	});

	it("rejects a non-positive step", () => {
		expect(() => decFloorToStep(d("1"), ZERO)).toThrow(DecimalError);
	});
});

describe("formatting for the wire", () => {
	it("derives fraction digits from the step size", () => {
		expect(decScaleOf(d("0.01"))).toBe(2);
		expect(decScaleOf(d("0.00000001"))).toBe(8);
		expect(decScaleOf(d("1"))).toBe(0);
		expect(decScaleOf(d("10"))).toBe(0);
		expect(decScaleOf(d("0.0001"))).toBe(4);
	});

	it("never emits scientific notation, which Binance rejects", () => {
		const tiny = d("0.00000001");
		expect(Number(0.00000001).toString()).toBe("1e-8");
		expect(decToString(tiny)).toBe("0.00000001");
		expect(decToFixed(tiny, 8)).toBe("0.00000001");
	});

	it("pads and truncates to a fixed precision", () => {
		expect(decToFixed(d("1.5"), 4)).toBe("1.5000");
		expect(decToFixed(d("1.56789"), 2)).toBe("1.56");
		expect(decToFixed(d("1.9"), 0)).toBe("1");
		expect(decToFixed(d("-1.56789"), 2)).toBe("-1.56");
	});

	it("rejects an out-of-range precision", () => {
		expect(() => decToFixed(ONE, 19)).toThrow(DecimalError);
		expect(() => decToFixed(ONE, -1)).toThrow(DecimalError);
	});
});

describe("number conversion", () => {
	it("round-trips decimal literals", () => {
		expect(decToString(decFromNumber(1.5))).toBe("1.5");
		expect(decToString(decFromNumber(0.001))).toBe("0.001");
		expect(decToString(decFromNumber(0))).toBe("0");
	});

	it("rejects non-finite input", () => {
		expect(() => decFromNumber(Number.NaN)).toThrow(DecimalError);
		expect(() => decFromNumber(Number.POSITIVE_INFINITY)).toThrow(DecimalError);
	});
});
