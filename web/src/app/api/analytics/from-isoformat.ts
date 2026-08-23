/**
 * `datetime.fromisoformat(x).isoformat()`, the round trip `search_logs()` in
 * `api/src/api/analytics.py` performs on its `since` and `until` query
 * parameters before binding them.
 *
 * Both bounds are compared as *text* against `log_entry->>'ts'`, which is
 * itself `datetime.now(UTC).isoformat()`, so the normalisation is the whole
 * behaviour rather than a formatting detail. The dashboard sends
 * `new Date(...).toISOString()`, which ends in `Z` and carries three
 * fractional digits; CPython rewrites that to `+00:00` with six. Skipping the
 * rewrite would leave `...789Z` being compared against `...789012+00:00`, and
 * `Z` (0x5A) sorts above `+` (0x2B), so every entry inside the boundary second
 * would silently drop out of the window.
 *
 * The grammar below was pinned by running candidate strings through the same
 * CPython that serves the router, not read from a specification. CPython's
 * parser is looser than ISO 8601 in ways that matter here:
 *
 * - the date/time separator is any single character, not just `T`
 * - basic (`20260823`, `123456`) and extended (`2026-08-23`, `12:34:56`) forms
 *   are both accepted, but a component may not mix them
 * - week dates (`2026-W34-7`, `2026W347`) are accepted; ordinal dates are not
 * - a `[.,]` fraction is microseconds appended after whichever component came
 *   last, so `12:34.5` is `12:34:00.500000` rather than half a minute
 * - `Z` is accepted only uppercase and only as the final character
 * - an offset is rejected only for magnitude, never for its minute or second
 *   component: `+05:99` is a valid `+06:39`
 *
 * `data/from-isoformat-parity.json` holds the generated table and
 * `from-isoformat.test.ts` asserts every row of it.
 */

const FOUR_DIGITS = /^\d{4}/
const TWO_DIGITS = /^\d{2}$/
const ONE_DIGIT = /^\d$/

/** `hh`, `hh:mm`, `hh:mm:ss`, each optionally followed by a `[.,]` fraction. */
const EXTENDED = /^(\d{2})(?::(\d{2})(?::(\d{2}))?)?(?:[.,](\d+))?$/
/** The same, written without separators. */
const BASIC = /^(\d{2})(?:(\d{2})(?:(\d{2}))?)?(?:[.,](\d+))?$/

const DAY_MS = 24 * 60 * 60 * 1000
const US_PER_SECOND = 1_000_000
/** CPython requires an offset strictly inside +/- 24 hours. */
const MAX_OFFSET_SECONDS = 24 * 60 * 60

interface Fields {
  hour: number
  minute: number
  second: number
  microsecond: number
}

interface DatePart {
  year: number
  month: number
  day: number
  /** The index the date stopped at, which is where the separator sits. */
  index: number
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0")
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** `Date.UTC` maps years 0-99 into the 1900s, so the year is set separately. */
function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(2000, month - 1, day))
  date.setUTCFullYear(year)
  return date
}

/**
 * `datetime.date.fromisocalendar()`. Week 1 is the week containing 4 January,
 * so its Monday is the anchor. A week 53 that does not exist in the given ISO
 * year is rejected, which is checked by asserting that the week's Thursday
 * still falls inside that year.
 */
function fromIsoCalendar(year: number, week: number, weekday: number): DatePart | null {
  if (year < 1 || year > 9999) return null
  if (week < 1 || week > 53 || weekday < 1 || weekday > 7) return null

  const jan4 = utcDate(year, 1, 4)
  const jan4Weekday = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay()
  const week1Monday = jan4.getTime() - (jan4Weekday - 1) * DAY_MS

  const thursday = new Date(week1Monday + ((week - 1) * 7 + 3) * DAY_MS)
  if (thursday.getUTCFullYear() !== year) return null

  const target = new Date(week1Monday + ((week - 1) * 7 + (weekday - 1)) * DAY_MS)
  return {
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
    index: 0,
  }
}

/**
 * The leading date. Whether the extended or the basic form is in use is decided
 * by the character after the year and then held for the rest of the component,
 * which is why `2026-0823` and `202608-23` are both rejected.
 */
function parseDate(value: string): DatePart | null {
  if (value.length < 7) return null
  if (!FOUR_DIGITS.test(value)) return null
  const year = Number(value.slice(0, 4))

  let index = 4
  const extended = value[index] === "-"
  if (extended) index += 1

  if (value[index] === "W") {
    index += 1
    const week = value.slice(index, index + 2)
    if (!TWO_DIGITS.test(week)) return null
    index += 2

    let weekday = 1
    if (extended) {
      if (value[index] === "-") {
        const digit = value[index + 1]
        if (digit === undefined || !ONE_DIGIT.test(digit)) return null
        weekday = Number(digit)
        index += 2
      }
    } else if (value[index] !== undefined && ONE_DIGIT.test(value[index])) {
      weekday = Number(value[index])
      index += 1
    }

    const date = fromIsoCalendar(year, Number(week), weekday)
    return date === null ? null : { ...date, index }
  }

  const month = value.slice(index, index + 2)
  if (!TWO_DIGITS.test(month)) return null
  index += 2
  if (extended) {
    if (value[index] !== "-") return null
    index += 1
  }
  const day = value.slice(index, index + 2)
  if (!TWO_DIGITS.test(day)) return null
  index += 2

  if (year < 1 || year > 9999) return null
  if (Number(month) < 1 || Number(month) > 12) return null
  if (Number(day) < 1 || Number(day) > daysInMonth(year, Number(month))) return null
  return { year, month: Number(month), day: Number(day), index }
}

/**
 * `hh[:mm[:ss]][.ffffff]`, in either form. The fraction is microseconds
 * regardless of which component it follows, right-padded to six digits and
 * truncated past them.
 */
function parseFields(text: string): Fields | null {
  const match = EXTENDED.exec(text) ?? BASIC.exec(text)
  if (match === null) return null
  const [, hour, minute, second, fraction] = match
  return {
    hour: Number(hour),
    minute: minute === undefined ? 0 : Number(minute),
    second: second === undefined ? 0 : Number(second),
    microsecond: fraction === undefined ? 0 : Number(fraction.padEnd(6, "0").slice(0, 6)),
  }
}

/**
 * The trailing offset, as signed whole seconds plus signed microseconds kept
 * apart because CPython keeps them apart: `tzinfo_from_isoformat_results()`
 * returns UTC whenever the whole-second offset is zero, discarding a
 * sub-second remainder. That is why `-00:00:00.500000` reads back as `+00:00`
 * while `-00:00:01.500000` keeps its half second.
 */
function parseOffset(text: string): number | null {
  if (text === "Z") return 0

  const sign = text[0] === "-" ? -1 : 1
  const fields = parseFields(text.slice(1))
  if (fields === null) return null
  if (fields.hour > 99) return null

  const seconds = sign * (fields.hour * 3600 + fields.minute * 60 + fields.second)
  if (Math.abs(seconds) >= MAX_OFFSET_SECONDS) return null
  if (seconds === 0) return 0
  return seconds * US_PER_SECOND + sign * fields.microsecond
}

/** `datetime.timedelta`'s rendering inside `datetime.isoformat()`. */
function formatOffset(totalMicroseconds: number): string {
  const sign = totalMicroseconds < 0 ? "-" : "+"
  let rest = Math.abs(totalMicroseconds)
  const hours = Math.floor(rest / (3600 * US_PER_SECOND))
  rest -= hours * 3600 * US_PER_SECOND
  const minutes = Math.floor(rest / (60 * US_PER_SECOND))
  rest -= minutes * 60 * US_PER_SECOND
  const seconds = Math.floor(rest / US_PER_SECOND)
  const microseconds = rest - seconds * US_PER_SECOND

  let out = `${sign}${pad(hours, 2)}:${pad(minutes, 2)}`
  if (seconds !== 0 || microseconds !== 0) {
    out += `:${pad(seconds, 2)}`
    if (microseconds !== 0) out += `.${pad(microseconds, 6)}`
  }
  return out
}

/**
 * The normalised `isoformat()` string, or `null` where CPython would raise
 * `ValueError`. The caller decides what a rejection means; CPython's caller
 * lets it escape the handler.
 */
export function fromIsoFormat(value: string): string | null {
  const date = parseDate(value)
  if (date === null) return null

  let time: Fields = { hour: 0, minute: 0, second: 0, microsecond: 0 }
  let offset: number | null = null

  if (date.index !== value.length) {
    // Whatever sits at `index` is the separator, and any character will do.
    let body = value.slice(date.index + 1)
    if (body === "") return null

    let offsetText: string | null = null
    if (body.endsWith("Z")) {
      offsetText = "Z"
      body = body.slice(0, -1)
    } else {
      // A time holds only digits and `:.,`, so the first sign starts the offset.
      const signAt = body.search(/[+-]/)
      if (signAt >= 0) {
        offsetText = body.slice(signAt)
        body = body.slice(0, signAt)
      }
    }

    const fields = parseFields(body)
    if (fields === null) return null
    if (fields.hour > 23 || fields.minute > 59 || fields.second > 59) return null
    time = fields

    if (offsetText !== null) {
      offset = parseOffset(offsetText)
      if (offset === null && offsetText !== "Z") return null
    }
  }

  const day = `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`
  const clock = `${pad(time.hour, 2)}:${pad(time.minute, 2)}:${pad(time.second, 2)}`
  const fraction = time.microsecond === 0 ? "" : `.${pad(time.microsecond, 6)}`
  return `${day}T${clock}${fraction}${offset === null ? "" : formatOffset(offset)}`
}

/**
 * `datetime.now(UTC).isoformat()` for a JavaScript `Date`, which is how
 * `search_logs()` renders its default 90-day lower bound.
 *
 * A `Date` carries milliseconds where a `datetime` carries microseconds, so the
 * last three digits are always zero here. The value is only ever a lower bound
 * on a 90-day window, so the lost precision cannot change which rows match.
 */
export function toPythonUtcIsoFormat(date: Date): string {
  const iso = date.toISOString()
  const milliseconds = Number(iso.slice(20, 23))
  const fraction = milliseconds === 0 ? "" : `.${pad(milliseconds, 3)}000`
  return `${iso.slice(0, 19)}${fraction}+00:00`
}
