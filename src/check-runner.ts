import {
  buildAlertMessage,
  findNearestTides,
  firstConsecutiveWindow,
  matches,
  type CandidateMatch,
  type TideEvent,
} from './alert-engine.js'
import type { AlertRule, SurfForecast } from './types.js'

export interface AlertWindow {
  startMs: number
  endMs: number
}

export interface CheckRunnerDeps {
  alerts: AlertRule[]
  minConsecutiveHours: number
  fetchForecasts: (spot: string) => Promise<SurfForecast[]>
  isWithinAlertWindow: (spot: string, forecastDate: Date) => Promise<boolean>
  getTideEventsForDate: (
    portId: string,
    yyyymmdd: string,
  ) => Promise<TideEvent[]>
  apiDateFromForecastDate: (dateRaw: string) => string
  sendMessage: (chatId: number, message: string) => Promise<void>
  touchAlertNotified: (id: string, at: string) => void
  getLastWindow?: (key: string) => AlertWindow | undefined
  setLastWindow?: (key: string, window: AlertWindow) => void
  nowMs?: () => number
}

function tideClassByHeight(
  height: number,
  min: number,
  max: number,
): 'low' | 'mid' | 'high' {
  const span = max - min
  if (span <= 0) return 'mid'
  const ratio = (height - min) / span
  if (ratio < 1 / 3) return 'low'
  if (ratio < 2 / 3) return 'mid'
  return 'high'
}

function estimateTideHeightAt(
  target: Date,
  events: TideEvent[],
): number | null {
  const rows = events
    .map((e) => ({ ...e, at: new Date(`${e.date}T${e.hora}:00`) }))
    .filter((e) => !Number.isNaN(e.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime())

  if (!rows.length) return null

  const t = target.getTime()
  if (t <= rows[0].at.getTime()) return rows[0].altura
  if (t >= rows[rows.length - 1].at.getTime())
    return rows[rows.length - 1].altura

  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]
    const b = rows[i + 1]
    const ta = a.at.getTime()
    const tb = b.at.getTime()
    if (t >= ta && t <= tb) {
      const k = (t - ta) / (tb - ta)
      return a.altura + (b.altura - a.altura) * k
    }
  }

  return null
}

function findNearestHighTideTs(
  target: Date,
  events: TideEvent[],
): number | null {
  const t = target.getTime()
  let best: number | null = null
  let bestDiff = Number.POSITIVE_INFINITY

  for (const e of events) {
    if (
      !String(e.tipo || '')
        .toLowerCase()
        .includes('pleamar')
    )
      continue
    const at = new Date(`${e.date}T${e.hora}:00`).getTime()
    if (Number.isNaN(at)) continue
    const diff = Math.abs(at - t)
    if (diff < bestDiff) {
      best = at
      bestDiff = diff
    }
  }

  return best
}

export function buildAlertProfileKey(alert: AlertRule): string {
  return JSON.stringify({
    waveRanges: alert.waveRanges,
    periodRanges: alert.periodRanges,
    windRanges: alert.windRanges,
    energyMin: alert.energyMin,
    energyMax: alert.energyMax,
    tidePreference: alert.tidePreference,
    tidePortId: alert.tidePortId ?? '72',
  })
}

export function shouldSendWindow(
  last: AlertWindow | undefined,
  next: AlertWindow,
): boolean {
  if (!last) return true

  const isEqual = next.startMs === last.startMs && next.endMs === last.endMs
  if (isEqual) return false

  const isContained = next.startMs >= last.startMs && next.endMs <= last.endMs
  if (isContained) return false

  return true
}

async function buildCandidateMatches(
  alert: AlertRule,
  matchesFound: SurfForecast[],
  deps: CheckRunnerDeps,
): Promise<CandidateMatch[]> {
  const out: CandidateMatch[] = []

  for (const candidate of matchesFound) {
    const targetDate = new Date(candidate.date)
    if (Number.isNaN(targetDate.getTime())) continue

    const inLightWindow = await deps.isWithinAlertWindow(alert.spot, targetDate)
    if (!inLightWindow) continue

    const tidePortId = alert.tidePortId ?? '72'
    const yyyymmdd = deps.apiDateFromForecastDate(candidate.date)
    const tideEvents = await deps.getTideEventsForDate(tidePortId, yyyymmdd)

    if (alert.tidePreference === 'high') {
      const nearestHigh = findNearestHighTideTs(targetDate, tideEvents)
      if (!nearestHigh) continue

      const start = nearestHigh - 3 * 60 * 60 * 1000
      const end = nearestHigh + 3 * 60 * 60 * 1000
      const ts = targetDate.getTime()
      if (ts < start || ts > end) continue
    }

    let tideClass: 'low' | 'mid' | 'high' | null = null
    let tideHeight: number | null = null

    if (tideEvents.length) {
      const estimated = estimateTideHeightAt(targetDate, tideEvents)
      if (estimated != null) {
        const min = Math.min(...tideEvents.map((e) => e.altura))
        const max = Math.max(...tideEvents.map((e) => e.altura))
        tideClass = tideClassByHeight(estimated, min, max)
        tideHeight = estimated
      }
    }

    if (alert.tidePreference && alert.tidePreference !== 'any') {
      if (!tideClass) continue
      if (tideClass !== alert.tidePreference) continue
    }

    out.push({ forecast: candidate, tideClass, tideHeight })
  }

  return out
}

export interface CheckRunStats {
  totalAlerts: number
  matched: number
  notified: number
  spots: string[]
}

export async function runChecksWithDeps(
  deps: CheckRunnerDeps,
): Promise<CheckRunStats> {
  const now = deps.nowMs ?? (() => Date.now())
  const stats: CheckRunStats = {
    totalAlerts: deps.alerts.length,
    matched: 0,
    notified: 0,
    spots: [...new Set(deps.alerts.map((a) => a.spot))],
  }

  for (const alert of deps.alerts) {
    try {
      const forecasts = await deps.fetchForecasts(alert.spot)
      if (!forecasts.length) continue

      const matchesFound = forecasts.filter((f) => matches(alert, f))
      if (!matchesFound.length) continue

      stats.matched++

      const candidateMatches = await buildCandidateMatches(
        alert,
        matchesFound,
        deps,
      )
      if (!candidateMatches.length) continue

      const window = firstConsecutiveWindow(
        candidateMatches,
        Math.max(1, deps.minConsecutiveHours),
      )
      if (!window) continue

      const startDate = new Date(window.start.forecast.date)
      const endDate = new Date(window.end.forecast.date)
      const newWindow: AlertWindow = {
        startMs: startDate.getTime(),
        endMs: endDate.getTime() + 60 * 60 * 1000,
      }

      const dedupeKey = `${alert.chatId}:${alert.spot}:${buildAlertProfileKey(alert)}`
      const prevWindow = deps.getLastWindow?.(dedupeKey)
      if (!shouldSendWindow(prevWindow, newWindow)) continue

      const first = window.start.forecast
      const tidePortId = alert.tidePortId ?? '72'
      const tideDate = deps.apiDateFromForecastDate(window.start.forecast.date)
      const tideEvents = await deps.getTideEventsForDate(tidePortId, tideDate)
      const nearestTides = findNearestTides(startDate, tideEvents)

      const message = buildAlertMessage({
        alert,
        first,
        startDate,
        endDate,
        nearestTides,
        nowMs: now(),
      })

      await deps.sendMessage(alert.chatId, message)
      deps.setLastWindow?.(dedupeKey, newWindow)
      deps.touchAlertNotified(alert.id, new Date(now()).toISOString())
      stats.notified++
    } catch (err) {
      console.error(`check_alert_error alert=${alert.id}`, err)
    }
  }

  return stats
}
