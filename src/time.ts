export const MADRID_TIME_ZONE = 'Europe/Madrid'

const MADRID_PARTS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: MADRID_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const MADRID_LOCAL_PARSE_CACHE_MAX = 1_024
const madridLocalParseCache = new Map<string, Date | null>()

type MadridDateTimeParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function numericPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  return Number(parts.find((part) => part.type === type)?.value ?? Number.NaN)
}

function cacheParseResult(key: string, value: Date | null): void {
  if (madridLocalParseCache.size >= MADRID_LOCAL_PARSE_CACHE_MAX) {
    madridLocalParseCache.clear()
  }
  madridLocalParseCache.set(key, value)
}

function parseDateYmd(raw: string): {
  year: number
  month: number
  day: number
} | null {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day))
    return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  return { year, month, day }
}

function parseTimeHm(raw: string): { hour: number; minute: number } | null {
  const match = raw.match(/^(\d{2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23) return null
  if (minute < 0 || minute > 59) return null
  return { hour, minute }
}

export function madridParts(date: Date): MadridDateTimeParts {
  const parts = MADRID_PARTS_FORMATTER.formatToParts(date)
  return {
    year: numericPart(parts, 'year'),
    month: numericPart(parts, 'month'),
    day: numericPart(parts, 'day'),
    hour: numericPart(parts, 'hour'),
    minute: numericPart(parts, 'minute'),
    second: numericPart(parts, 'second'),
  }
}

export function parseMadridLocalDateTime(
  dateYmd: string,
  timeHm: string,
): Date | null {
  const cacheKey = `${dateYmd}T${timeHm}`
  const cached = madridLocalParseCache.get(cacheKey)
  if (cached !== undefined) {
    return cached ? new Date(cached.getTime()) : null
  }

  const datePart = parseDateYmd(dateYmd)
  const timePart = parseTimeHm(timeHm)
  if (!datePart || !timePart) {
    cacheParseResult(cacheKey, null)
    return null
  }

  const nominalUtcMs = Date.UTC(
    datePart.year,
    datePart.month - 1,
    datePart.day,
    timePart.hour,
    timePart.minute,
    0,
    0,
  )

  // Match a local Europe/Madrid timestamp by scanning the nearby UTC window.
  // This keeps behavior deterministic across host timezones and DST changes.
  const scanStart = nominalUtcMs - 4 * 60 * 60 * 1000
  const scanEnd = nominalUtcMs + 4 * 60 * 60 * 1000

  let bestMs: number | null = null
  let bestDelta = Number.POSITIVE_INFINITY

  for (let ms = scanStart; ms <= scanEnd; ms += 60 * 1000) {
    const p = madridParts(new Date(ms))
    if (
      p.year === datePart.year &&
      p.month === datePart.month &&
      p.day === datePart.day &&
      p.hour === timePart.hour &&
      p.minute === timePart.minute
    ) {
      const delta = Math.abs(ms - nominalUtcMs)
      if (delta < bestDelta) {
        bestDelta = delta
        bestMs = ms
      }
    }
  }

  if (bestMs == null) {
    cacheParseResult(cacheKey, null)
    return null
  }

  const parsed = new Date(bestMs)
  cacheParseResult(cacheKey, parsed)
  return new Date(parsed.getTime())
}
