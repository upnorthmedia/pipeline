/**
 * Python's built-in `round(float, ndigits)`.
 *
 * `api/src/services/analytics.py` rounds every number it puts into the edit
 * prompt, so the port has to agree with Python on ties. It cannot: JavaScript's
 * `Math.round` breaks ties upward and `Number.prototype.toFixed` breaks them
 * away from zero, while Python breaks them to even. The disagreement is not
 * theoretical for this pipeline. `avg_sentence_length` is `word_count /
 * sentence_count`, so a 405 word draft with 20 sentences is exactly 20.25 and
 * Python prints `20.2` where `toFixed(1)` prints `20.3`.
 *
 * Ties are decided against the double's exact binary value rather than its
 * decimal rendering, which is why this works in `BigInt` rather than in
 * floating point: a double is an exact tie at `n` decimals only when it is
 * `odd / 2**k` for `k <= n + 1`, and every other value has to round by its true
 * remainder, not by a re-parsed approximation of it.
 */
// `tsconfig.json` targets ES2017, where BigInt *literals* (`0n`) are a type
// error even though the BigInt type itself is available through `lib: esnext`.
// Naming the constants keeps the port out of the app-wide compiler settings.
const ZERO = BigInt(0)
const ONE = BigInt(1)
const TWO = BigInt(2)
const TEN = BigInt(10)
const SIGN_SHIFT = BigInt(63)
const EXPONENT_SHIFT = BigInt(52)
const EXPONENT_MASK = BigInt(0x7ff)
const FRACTION_MASK = (ONE << EXPONENT_SHIFT) - ONE
const IMPLICIT_BIT = ONE << EXPONENT_SHIFT

export function pythonRound(value: number, ndigits: number): number {
  if (!Number.isFinite(value)) return value
  if (ndigits < 0) throw new RangeError(`pythonRound: negative ndigits ${ndigits}`)

  const bits = doubleBits(value)
  const negative = bits >> SIGN_SHIFT === ONE
  const biasedExponent = Number((bits >> EXPONENT_SHIFT) & EXPONENT_MASK)
  const fraction = bits & FRACTION_MASK

  // |value| = mantissa * 2 ** exponent, exactly.
  const mantissa = biasedExponent === 0 ? fraction : fraction | IMPLICIT_BIT
  const exponent = biasedExponent === 0 ? -1074 : biasedExponent - 1075

  const scale = TEN ** BigInt(ndigits)
  let numerator = mantissa * scale
  let denominator = ONE
  if (exponent >= 0) numerator <<= BigInt(exponent)
  else denominator = ONE << BigInt(-exponent)

  let quotient = numerator / denominator
  const remainder = (numerator % denominator) * TWO
  if (remainder > denominator || (remainder === denominator && quotient % TWO !== ZERO)) {
    quotient += ONE
  }

  // `Number(string)` is correctly rounded, the same conversion CPython runs on
  // the decimal it produces, so the two land on the same double.
  const digits = quotient.toString().padStart(ndigits + 1, "0")
  const decimal =
    ndigits === 0
      ? digits
      : `${digits.slice(0, digits.length - ndigits)}.${digits.slice(digits.length - ndigits)}`
  return Number(negative ? `-${decimal}` : decimal)
}

const scratch = new DataView(new ArrayBuffer(8))

function doubleBits(value: number): bigint {
  scratch.setFloat64(0, value)
  return scratch.getBigUint64(0)
}
