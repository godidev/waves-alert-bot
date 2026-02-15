import {
  buildAlertMessage,
  findNearestTides,
  firstConsecutiveWindow,
  matches,
  type CandidateMatch,
  type TideEvent,
} from './alert-engine.js'
import type { AlertRule, SurfForecast } from './types.js'

export interface CheckRunnerDeps {
  alerts: AlertRule[]
  minConsecutiveHours: number
  fetchForecasts: (spot: string) => Promise<SurfForecast[]>
  isWithinAlertWindow: (spot: string, forecastDate: Date) => Promise<boolean>
  getTideEventsForDate: (portId: string, yyyymmdd: string) => Promise<TideEvent[]>
  apiDateFromForecastDate: (dateRaw: string) => string
  sendMessage: (chatId: number, message: string) => Promise<void>
  touchAlertNotified: (id: string, at: string) => void
  nowMs?: () => number
}

function cooldownOk(alert: AlertRule, nowMs: number): boolean {
  if (!alert.lastNotifiedAt) return true
  const last = new Date(alert.lastNotifiedAt).getTime()
  return nowMs - last >= alert.cooldownMin * 60_000
}

function tideClassByHeight(height: number, min: number, max: number): 'low' | 'mid' | 'high' {
  const span = max - min
  if (span <= 0) return 'mid'
  const ratio = (height - min) / span
  if (ratio < 1 / 3) return 'low'
  if (ratio < 2 / 3) return 'mid'
  return 'high'
}

function estimateTideHeightAt(target: Date, events: TideEvent[]): number | null {
  const rows = events
    .map((e) => ({
      ...e,
      at: new Date(`${e.date}T${e.hora}:00`),
    }))
    .filter((e) => !Number.isNaN(e.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime())

  if (!rows.length) return null

  const t = target.getTime()
  if (t <= rows[0].at.getTime()) return rows[0].altura
  if (t >= rows[rows.length - 1].at.getTime()) return rows[rows.length - 1].altura

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

export async function runChecksWithDeps(deps: CheckRunnerDeps): Promise<void> {
  const now = deps.nowMs ?? (() => Date.now())

  for (const alert of deps.alerts) {
    try {
      const forecasts = await deps.fetchForecasts(alert.spot)
      if (!forecasts.length || !cooldownOk(alert, now())) continue

      const matchesFound = forecasts.filter((f) => matches(alert, f))
      if (!matchesFound.length) continue

      const candidateMatches: CandidateMatch[] = []

      for (const candidate of matchesFound) {
        const targetDate = new Date(candidate.date)
        if (Number.isNaN(targetDate.getTime())) continue

        const inLightWindow = await deps.isWithinAlertWindow(alert.spot, targetDate)
        if (!inLightWindow) continue

        const tidePortId = alert.tidePortId ?? '72'
        const yyyymmdd = deps.apiDateFromForecastDate(candidate.date)
        const tideEvents = await deps.getTideEventsForDate(tidePortId, yyyymmdd)

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

        candidateMatches.push({ forecast: candidate, tideClass, tideHeight })
      }

      const window = firstConsecutiveWindow(candidateMatches, Math.max(1, deps.minConsecutiveHours))
      if (!window) continue

      const first = window.start.forecast
      const startDate = new Date(window.start.forecast.date)
      const endDate = new Date(window.end.forecast.date)

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
      deps.touchAlertNotified(alert.id, new Date(now()).toISOString())
    } catch {
      // noop
    }
  }
}
