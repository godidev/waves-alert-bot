import type { AlertRule, SurfForecast } from './types.js'
import {
  degreesToCardinal,
  normalizeAngle,
  primaryPeriod,
  totalWaveHeight,
  windArrowFromDegrees,
} from './utils.js'
import { MADRID_TIME_ZONE, parseUtcDateTime } from './time.js'

export type TideEvent = {
  date: string
  hora: string
  altura: number
  tipo: 'pleamar' | 'bajamar' | string
}

export type CandidateMatch = {
  forecast: SurfForecast
  tideClass: 'low' | 'mid' | 'high' | null
  tideHeight: number | null
}

function isInRange(current: number, min: number, max: number): boolean {
  return current >= min && current <= max
}

function isWindInRange(current: number, min: number, max: number): boolean {
  if (min <= max) return current >= min && current <= max
  return current >= min || current <= max
}

export function matches(alert: AlertRule, f: SurfForecast): boolean {
  const wave = totalWaveHeight(f)
  const period = primaryPeriod(f)
  const energy = f.energy
  const windAngle = normalizeAngle(f.wind.angle)

  const inWave = alert.waveRanges?.length
    ? alert.waveRanges.some((r) => isInRange(wave, r.min, r.max))
    : isInRange(wave, alert.waveMin, alert.waveMax)
  const inPeriod = alert.periodRanges?.length
    ? alert.periodRanges.some((r) => isInRange(period, r.min, r.max))
    : isInRange(period, alert.periodMin, alert.periodMax)
  const inEnergy = energy >= alert.energyMin && energy <= alert.energyMax
  const inWind =
    !alert.windRanges?.length ||
    alert.windRanges.some((r) => isWindInRange(windAngle, r.min, r.max))

  return inWave && inPeriod && inEnergy && inWind
}

export interface MatchDetail {
  pass: boolean
  wave: boolean
  period: boolean
  energy: boolean
  wind: boolean
}

export function matchDetail(alert: AlertRule, f: SurfForecast): MatchDetail {
  const wave = totalWaveHeight(f)
  const period = primaryPeriod(f)
  const energy = f.energy
  const windAngle = normalizeAngle(f.wind.angle)

  const inWave = alert.waveRanges?.length
    ? alert.waveRanges.some((r) => isInRange(wave, r.min, r.max))
    : isInRange(wave, alert.waveMin, alert.waveMax)
  const inPeriod = alert.periodRanges?.length
    ? alert.periodRanges.some((r) => isInRange(period, r.min, r.max))
    : isInRange(period, alert.periodMin, alert.periodMax)
  const inEnergy = energy >= alert.energyMin && energy <= alert.energyMax
  const inWind =
    !alert.windRanges?.length ||
    alert.windRanges.some((r) => isWindInRange(windAngle, r.min, r.max))

  return {
    pass: inWave && inPeriod && inEnergy && inWind,
    wave: inWave,
    period: inPeriod,
    energy: inEnergy,
    wind: inWind,
  }
}

export function firstConsecutiveWindow(
  items: CandidateMatch[],
  minHours: number,
): {
  start: CandidateMatch
  end: CandidateMatch
  hours: number
  items: CandidateMatch[]
} | null {
  if (!items.length) return null

  const sorted = [...items].sort(
    (a, b) =>
      new Date(a.forecast.date).getTime() - new Date(b.forecast.date).getTime(),
  )

  let streakStart = 0
  let streakLen = 1

  for (let i = 1; i <= sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const isConsecutive =
      cur &&
      new Date(cur.forecast.date).getTime() -
        new Date(prev.forecast.date).getTime() ===
        60 * 60 * 1000

    if (isConsecutive) {
      streakLen++
      continue
    }

    if (streakLen >= minHours) {
      const endIndex = i - 1
      return {
        start: sorted[streakStart],
        end: sorted[endIndex],
        hours: streakLen,
        items: sorted.slice(streakStart, endIndex + 1),
      }
    }

    streakStart = i
    streakLen = 1
  }

  if (minHours <= 1)
    return { start: sorted[0], end: sorted[0], hours: 1, items: [sorted[0]] }
  return null
}

function parseTideDate(e: TideEvent): Date | null {
  return parseUtcDateTime(e.date, e.hora)
}

export function findNearestTides(
  target: Date,
  events: TideEvent[],
): {
  low: TideEvent | null
  high: TideEvent | null
} {
  const t = target.getTime()

  let low: TideEvent | null = null
  let high: TideEvent | null = null
  let lowDiff = Number.POSITIVE_INFINITY
  let highDiff = Number.POSITIVE_INFINITY

  for (const event of events) {
    const at = parseTideDate(event)
    if (!at) continue

    const diff = Math.abs(at.getTime() - t)
    const tipo = String(event.tipo || '').toLowerCase()

    if (tipo.includes('bajamar') && diff < lowDiff) {
      low = event
      lowDiff = diff
    }

    if (tipo.includes('pleamar') && diff < highDiff) {
      high = event
      highDiff = diff
    }
  }

  return { low, high }
}

function formatDay(date: Date): string {
  if (Number.isNaN(date.getTime())) return 'n/d'
  return date.toLocaleDateString('es-ES', {
    timeZone: MADRID_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

function formatHour(date: Date): string {
  if (Number.isNaN(date.getTime())) return '--:--'
  return date.toLocaleTimeString('es-ES', {
    timeZone: MADRID_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function tideBandLine(
  marker: string,
  label: 'Marea alta' | 'Marea baja',
  event: TideEvent,
  hourWidth: number,
  rightWidth: number,
): string {
  const icon = label === 'Marea alta' ? '⬆️' : '⬇️'
  const tideAt = parseTideDate(event)
  const hourText = tideAt ? formatHour(tideAt) : event.hora
  const hour = padEndDisplay(`${marker} ${hourText}`, hourWidth)
  const rightText = `${icon} ${label} (${event.altura.toFixed(2)}m)`
  const right = padCenterDisplay(rightText, rightWidth)
  return `${hour} | ${right}`
}

function subtleDividerLine(hourWidth: number, rightWidth: number): string {
  const hour = ' '.repeat(hourWidth)
  const pattern = '. '.repeat(Math.ceil(rightWidth / 2)).slice(0, rightWidth)
  return `${hour} | ${pattern}`.trimEnd()
}

function charDisplayWidth(ch: string): number {
  const cp = ch.codePointAt(0)
  if (cp == null) return 0

  // zero-width modifiers / joiners
  if (
    cp === 0x200d ||
    cp === 0xfe0e ||
    cp === 0xfe0f ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0
  }

  // East Asian wide/full-width + common emoji blocks
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x2600 && cp <= 0x26ff) ||
    (cp >= 0x2700 && cp <= 0x27bf) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2
  }

  return 1
}

function stringDisplayWidth(value: string): number {
  return Array.from(value).reduce((acc, ch) => acc + charDisplayWidth(ch), 0)
}

function padEndDisplay(value: string, width: number): string {
  const pad = Math.max(0, width - stringDisplayWidth(value))
  return `${value}${' '.repeat(pad)}`
}

function padStartDisplay(value: string, width: number): string {
  const pad = Math.max(0, width - stringDisplayWidth(value))
  return `${' '.repeat(pad)}${value}`
}

function padCenterDisplay(value: string, width: number): string {
  const pad = Math.max(0, width - stringDisplayWidth(value))
  const left = Math.floor(pad / 2)
  const right = pad - left
  return `${' '.repeat(left)}${value}${' '.repeat(right)}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function formatHourlyTable(
  forecasts: SurfForecast[],
  nearestTides: { low: TideEvent | null; high: TideEvent | null },
  highlightWindow?: { startMs: number; endMs: number },
  maxCols = 14,
): string | null {
  if (!forecasts.length) return null

  const GOOD_MARKER = '🟩'
  const CONTEXT_MARKER = '⬜️'

  const slice = [...forecasts]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, maxCols)

  const columns = [
    {
      header: 'Hora',
      values: slice.map((f) => {
        const at = new Date(f.date).getTime()
        const marker =
          highlightWindow &&
          at >= highlightWindow.startMs &&
          at <= highlightWindow.endMs
            ? GOOD_MARKER
            : CONTEXT_MARKER
        return `${marker} ${formatHour(new Date(f.date))}`
      }),
    },
    {
      header: 'm',
      values: slice.map((f) => totalWaveHeight(f).toFixed(1)),
    },
    {
      header: 'E',
      values: slice.map((f) => `${Math.round(f.energy)}`),
    },
    {
      header: 'V(km/h)',
      values: slice.map(
        (f) =>
          `${Math.round(f.wind.speed)}${windArrowFromDegrees(f.wind.angle)}`,
      ),
    },
    {
      header: 'T(s)',
      values: slice.map((f) => `${Math.round(primaryPeriod(f))}`),
    },
  ]

  const numericColumns = new Set([1, 2, 3, 4])

  const widths = columns.map((col) =>
    Math.max(
      stringDisplayWidth(col.header),
      ...col.values.map(stringDisplayWidth),
    ),
  )

  const fmt = (value: string, idx: number, header = false): string => {
    if (header) return padEndDisplay(value, widths[idx])
    if (numericColumns.has(idx)) return padStartDisplay(value, widths[idx])
    return padEndDisplay(value, widths[idx])
  }

  const header = columns
    .map((c, idx) => fmt(c.header, idx, true))
    .join(' | ')
    .trimEnd()
  const separator = widths
    .map((w) => '-'.repeat(w))
    .join(' | ')
    .trimEnd()
  const rows = slice.map((forecast, rowIdx) => ({
    at: new Date(forecast.date).getTime(),
    text: columns
      .map((c, colIdx) => fmt(c.values[rowIdx], colIdx))
      .join(' | ')
      .trimEnd(),
  }))

  const tideMarkers = [
    nearestTides.high
      ? {
          at: parseUtcDateTime(
            nearestTides.high.date,
            nearestTides.high.hora,
          )?.getTime(),
          event: nearestTides.high,
          label: 'Marea alta' as const,
        }
      : null,
    nearestTides.low
      ? {
          at: parseUtcDateTime(
            nearestTides.low.date,
            nearestTides.low.hora,
          )?.getTime(),
          event: nearestTides.low,
          label: 'Marea baja' as const,
        }
      : null,
  ]
    .filter(
      (
        row,
      ): row is {
        at: number | undefined
        event: TideEvent
        label: 'Marea alta' | 'Marea baja'
      } => Boolean(row),
    )
    .filter(
      (
        row,
      ): row is {
        at: number
        event: TideEvent
        label: 'Marea alta' | 'Marea baja'
      } => Number.isFinite(row.at),
    )
    .sort((a, b) => a.at - b.at)

  const rightAreaWidth =
    widths.slice(1).reduce((sum, w) => sum + w, 0) + (widths.length - 2) * 3

  const lines: string[] = []
  const tideMarker = (at: number): string => {
    if (
      highlightWindow &&
      at >= highlightWindow.startMs &&
      at <= highlightWindow.endMs
    ) {
      return GOOD_MARKER
    }
    return CONTEXT_MARKER
  }
  const firstAt = rows[0].at
  const lastAt = rows[rows.length - 1].at
  const beforeRows = tideMarkers.filter((t) => t.at < firstAt)
  const inRangeRows = tideMarkers.filter(
    (t) => t.at >= firstAt && t.at <= lastAt,
  )
  const afterRows = tideMarkers.filter((t) => t.at > lastAt)

  for (const tide of beforeRows) {
    lines.push(
      tideBandLine(
        tideMarker(tide.at),
        tide.label,
        tide.event,
        widths[0],
        rightAreaWidth,
      ),
    )
  }

  if (beforeRows.length) {
    lines.push(subtleDividerLine(widths[0], rightAreaWidth))
  }

  let inRangeIdx = 0
  for (const row of rows) {
    while (
      inRangeIdx < inRangeRows.length &&
      inRangeRows[inRangeIdx].at <= row.at
    ) {
      const tide = inRangeRows[inRangeIdx]
      lines.push(
        tideBandLine(
          tideMarker(tide.at),
          tide.label,
          tide.event,
          widths[0],
          rightAreaWidth,
        ),
      )
      inRangeIdx++
    }
    lines.push(row.text)
  }

  while (inRangeIdx < inRangeRows.length) {
    const tide = inRangeRows[inRangeIdx]
    lines.push(
      tideBandLine(
        tideMarker(tide.at),
        tide.label,
        tide.event,
        widths[0],
        rightAreaWidth,
      ),
    )
    inRangeIdx++
  }

  if (afterRows.length) {
    lines.push(subtleDividerLine(widths[0], rightAreaWidth))
  }

  for (const tide of afterRows) {
    lines.push(
      tideBandLine(
        tideMarker(tide.at),
        tide.label,
        tide.event,
        widths[0],
        rightAreaWidth,
      ),
    )
  }

  const table = [header, separator, ...lines].join('\n')
  return `<pre>${escapeHtml(table)}</pre>`
}

export function buildAlertMessage(params: {
  alert: AlertRule
  first: SurfForecast
  startDate: Date
  endDate: Date
  nearestTides: { low: TideEvent | null; high: TideEvent | null }
  windowForecasts?: SurfForecast[]
}): string {
  const {
    alert,
    first,
    startDate,
    endDate,
    nearestTides,
    windowForecasts = [first],
  } = params

  const dayText = formatDay(startDate)
  const startHour = formatHour(startDate)
  const endHour = formatHour(new Date(endDate.getTime() + 60 * 60 * 1000))
  const hourlyTable = formatHourlyTable(windowForecasts, nearestTides, {
    startMs: startDate.getTime(),
    endMs: endDate.getTime(),
  })

  return [
    `🚨🌊 ALERTA: ${alert.name}`,
    `📍 ${alert.spot}`,
    `📅 ${dayText}`,
    `⏰ ${startHour}-${endHour}`,
    `🏄 ${totalWaveHeight(first).toFixed(2)}m @${primaryPeriod(first).toFixed(1)}s`,
    `⚡  ${first.energy.toFixed(0)}`,
    `💨 ${Math.round(first.wind.speed)} km/h ${degreesToCardinal(first.wind.angle)} ${windArrowFromDegrees(first.wind.angle)} (${first.wind.angle.toFixed(0)}°)`,
    ...(hourlyTable ? [hourlyTable] : []),
  ].join('\n')
}
