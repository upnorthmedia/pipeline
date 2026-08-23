/**
 * `days: int = Query(30, ge=1, le=365)`, the window parameter three of the four
 * endpoints in `api/src/api/analytics.py` declare identically.
 *
 * Starlette's `QueryParams.get()` returns the *last* value of a repeated key
 * where `URLSearchParams.get()` returns the first, so the raw value is taken
 * off `getAll()`; this is the same divergence recorded under 5.3c-i for
 * `?stage=`. Unlike `stage`, `days` is a required `int` once present, so
 * `?days=` is a 422 rather than a fallback to the default.
 */
import { parseInt422, unprocessableRequest, type ValidationErrorDetail } from "../pydantic"

export const DAY_MS = 24 * 60 * 60 * 1000

export function parseDays(url: URL): number | Response {
  const raw = url.searchParams.getAll("days").at(-1)
  if (raw === undefined) return 30
  const issues: ValidationErrorDetail[] = []
  const days = parseInt422(raw, "days", 30, 1, 365, issues)
  if (issues.length > 0) return unprocessableRequest(issues)
  return days
}
