/**
 * Python's `str(float)`, which is what an f-string interpolates.
 *
 * `edit_node` prints three of `compute_analytics`'s floats straight into the
 * prompt, and Python's float repr always carries a decimal point where
 * JavaScript's does not: a keyword density of exactly zero renders as `0.0%` in
 * Python and `0%` in JavaScript. The golden fixture
 * `how-to-choose-a-crm-for-a-small-team` contains `- **crm comparison:** 0.0%`,
 * so this is a real difference in the bytes the provider sees, not a hypothetical.
 *
 * Both languages otherwise print the shortest decimal string that round-trips,
 * so the only other divergence is the exponent threshold: Python switches to
 * scientific notation below `1e-4` and writes a two-digit exponent (`1e-05`),
 * JavaScript switches below `1e-7` and writes one digit (`1e-7`). Every value
 * that reaches this function has been through `pythonRound(x, 1)` or
 * `pythonRound(x, 2)`, so the smallest non-zero magnitude possible is `0.01`
 * and the exponent form is unreachable. It is deliberately not implemented
 * rather than guessed at.
 */
export function pythonFloat(value: number): string {
  // `-0.0` is reachable: Python's `round(-0.01, 1)` is `-0.0` and prints with
  // its sign, while `String(-0)` drops it.
  const text = Object.is(value, -0) ? "-0" : String(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}
