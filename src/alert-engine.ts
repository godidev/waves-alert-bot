import type { AlertRule, SurfForecast } from './types.js'
import {
  degreesToCardinal,
  normalizeAngle,
  primaryPeriod,
  totalWaveHeight,
  windArrowFromDegrees,
} from './utils.js'
import { MADRID_TIME_ZONE, parseMadridLocalDateTime } from './time.js'

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

  const inWave =
    alert.waveRanges?.length
      ? alert.waveRanges.some((r) => isInRange(wave, r.min, r.max))
      : isInRange(wave, alert.waveMin, alert.waveMax)
  const inPeriod =
    alert.periodRanges?.length
      ? alert.periodRanges.some((r) => isInRange(period, r.min, r.max))
      : isInRange(period, alert.periodMin, alert.periodMax)
  const inEnergy = energy >= alert.energyMin && energy <= alert.energyMax
  const inWind =
    !alert.windRanges?.length ||
    alert.windRanges.some((r) => isWindInRange(windAngle, r.min, r.max))

  return inWave && inPeriod && inEnergy && inWind
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
  return parseMadridLocalDateTime(e.date, e.hora)
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

function formatWithinText(startDate: Date, nowMs = Date.now()): string {
  if (Number.isNaN(startDate.getTime())) return 'n/d'
  const diffHours = Math.round((startDate.getTime() - nowMs) / (60 * 60 * 1000))
  return diffHours <= 0 ? 'en curso' : `en ${diffHours}h`
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

function tideLine(label: string, event: TideEvent | null): string {
  if (!event) return `• ${label}: n/d`
  return `• ${label}: ${event.hora} (${event.altura.toFixed(2)}m)`
}

function formatHourlyTable(forecasts: SurfForecast[], maxCols = 6): string | null {
  if (!forecasts.length) return null

  const slice = [...forecasts]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, maxCols)

  const labelWidth = 8
  const colWidth = 7

  const row = (label: string, values: string[]): string =>
    `${label.padEnd(labelWidth)}${values.map((v) => v.padEnd(colWidth)).join('')}`

  const hours = slice.map((f) => formatHour(new Date(f.date)))
  const swells = slice.map((f) => `${totalWaveHeight(f).toFixed(1)}m`)
  const energies = slice.map((f) => `${Math.round(f.energy)}`)
  const winds = slice.map(
    (f) => `${Math.round(f.wind.speed)}${windArrowFromDegrees(f.wind.angle)}`,
  )
  const periods = slice.map((f) => `${Math.round(primaryPeriod(f))}s`)

  return [
    '<pre>',
    row('Hora', hours),
    row('Swell', swells),
    row('Energía', energies),
    row('Viento', winds),
    row('Período', periods),
    '</pre>',
  ].join('\n')
}

export function buildAlertMessage(params: {
  alert: AlertRule
  first: SurfForecast
  startDate: Date
  endDate: Date
  nearestTides: { low: TideEvent | null; high: TideEvent | null }
  windowForecasts?: SurfForecast[]
  nowMs?: number
}): string {
  const {
    alert,
    first,
    startDate,
    endDate,
    nearestTides,
    windowForecasts = [first],
    nowMs,
  } = params

  const dayText = formatDay(startDate)
  const startHour = formatHour(startDate)
  const endHour = formatHour(new Date(endDate.getTime() + 60 * 60 * 1000))
  const withinText = formatWithinText(startDate, nowMs)
  const hourlyTable = formatHourlyTable(windowForecasts)

  return [
    `🚨🌊 ALERTA: ${alert.name}`,
    `📍 Spot: ${alert.spot}`,
    '',
    '🕒 Ventana',
    `• 📅 Fecha: ${dayText}`,
    `• ⏰ Rango: ${startHour} - ${endHour}`,
    `• ⏳ Empieza: ${withinText}`,
    '',
    '🏄 Condiciones',
    `• Swell base: ${totalWaveHeight(first).toFixed(2)}m @${primaryPeriod(first).toFixed(1)}s`,
    `• Energía: ${first.energy.toFixed(0)}`,
    `• Viento base: ${degreesToCardinal(first.wind.angle)} ${windArrowFromDegrees(first.wind.angle)} (${first.wind.angle.toFixed(0)}°)`,
    ...(hourlyTable ? ['', '📊 Detalle hora a hora', hourlyTable] : []),
    '',
    `🌙 Mareas · 📍 ${alert.tidePortName ?? 'Bermeo'}`,
    tideLine('Bajamar más cercana', nearestTides.low),
    tideLine('Pleamar más cercana', nearestTides.high),
  ].join('\n')
}
