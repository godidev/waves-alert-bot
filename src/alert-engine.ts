import type { AlertRule, SurfForecast } from './types.js'
import {
  degreesToCardinal,
  normalizeAngle,
  primaryPeriod,
  totalWaveHeight,
  windArrowFromDegrees,
} from './utils.js'

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
): { start: CandidateMatch; end: CandidateMatch; hours: number } | null {
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
      }
    }

    streakStart = i
    streakLen = 1
  }

  if (minHours <= 1) return { start: sorted[0], end: sorted[0], hours: 1 }
  return null
}

function parseTideDate(e: TideEvent): Date | null {
  const d = new Date(`${e.date}T${e.hora}:00`)
  return Number.isNaN(d.getTime()) ? null : d
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
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

function formatHour(date: Date): string {
  if (Number.isNaN(date.getTime())) return '--:--'
  return date.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function tideLine(label: string, event: TideEvent | null): string {
  if (!event) return `• ${label}: n/d`
  return `• ${label}: ${event.hora} (${event.altura.toFixed(2)}m)`
}

export function buildAlertMessage(params: {
  alert: AlertRule
  first: SurfForecast
  startDate: Date
  endDate: Date
  nearestTides: { low: TideEvent | null; high: TideEvent | null }
  nowMs?: number
}): string {
  const { alert, first, startDate, endDate, nearestTides, nowMs } = params

  const dayText = formatDay(startDate)
  const startHour = formatHour(startDate)
  const endHour = formatHour(new Date(endDate.getTime() + 60 * 60 * 1000))
  const withinText = formatWithinText(startDate, nowMs)

  return [
    `🚨🌊 ALERTA: ${alert.name}`,
    `📍 Spot: ${alert.spot}`,
    `📅 Fecha: ${dayText}`,
    `⏰ Rango: ${startHour} - ${endHour}`,
    `⏳ Empieza: ${withinText}`,
    `🏄 Swell: ${totalWaveHeight(first).toFixed(2)}m @${primaryPeriod(first).toFixed(1)}s`,
    `⚡ Energía: ${first.energy.toFixed(0)}`,
    `💨 Viento: ${degreesToCardinal(first.wind.angle)} ${windArrowFromDegrees(first.wind.angle)} (${first.wind.angle.toFixed(0)}°)`,
    `🌙 Mareas · 📍 ${alert.tidePortName ?? 'Bermeo'}`,
    tideLine('Bajamar más cercana', nearestTides.low),
    tideLine('Pleamar más cercana', nearestTides.high),
  ].join('\n')
}
