import {
  buildAlertMessage,
  findNearestTides,
  firstConsecutiveWindow,
  matchDetail,
  type CandidateMatch,
  type TideEvent,
} from './alert-engine.js'
import { parseUtcDateTime } from './time.js'
import type { AlertRule, SurfForecast } from './types.js'

export interface AlertWindow {
  startMs: number
  endMs: number
}

interface CheckRunnerDeps {
  alerts: AlertRule[]
  minConsecutiveHours: number
  fetchForecasts: (spotId: string) => Promise<SurfForecast[]>
  isWithinAlertWindow: (spot: string, forecastDate: Date) => Promise<boolean>
  getTideEventsForDate: (
    portId: string,
    yyyymmdd: string,
  ) => Promise<TideEvent[]>
  apiDateFromForecastDate: (dateRaw: string) => string
  sendMessage: (chatId: number, message: string) => Promise<void>
  touchAlertNotified: (id: string, at: string) => void
  recordNotificationMatch?: (event: {
    chatId: number
    alertId: string
    alertName: string
    spot: string
    windowStartIso: string
    windowEndIso: string
    atIso: string
  }) => void
  recordNotificationSent?: (event: {
    chatId: number
    alertId: string
    alertName: string
    spot: string
    windowStartIso: string
    windowEndIso: string
    atIso: string
  }) => void
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
  type TideRow = TideEvent & { at: Date }

  const rows = events
    .map((e) => ({
      ...e,
      at: parseUtcDateTime(e.date, e.hora),
    }))
    .filter((e): e is TideRow => e.at instanceof Date)
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

function findNearestTideTsByType(
  target: Date,
  events: TideEvent[],
  type: 'high' | 'low',
): number | null {
  const t = target.getTime()
  let best: number | null = null
  let bestDiff = Number.POSITIVE_INFINITY
  const needle = type === 'high' ? 'pleamar' : 'bajamar'

  for (const e of events) {
    if (
      !String(e.tipo || '')
        .toLowerCase()
        .includes(needle)
    )
      continue
    const atDate = parseUtcDateTime(e.date, e.hora)
    if (!atDate) continue
    const at = atDate.getTime()
    const diff = Math.abs(at - t)
    if (diff < bestDiff) {
      best = at
      bestDiff = diff
    }
  }

  return best
}

function buildAlertProfileKey(alert: AlertRule): string {
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
  stats: CheckRunStats,
): Promise<CandidateMatch[]> {
  const out: CandidateMatch[] = []

  for (const candidate of matchesFound) {
    const targetDate = new Date(candidate.date)
    if (Number.isNaN(targetDate.getTime())) continue

    const tidePortId = alert.tidePortId ?? '72'
    const yyyymmdd = deps.apiDateFromForecastDate(candidate.date)
    const tideEvents = await deps.getTideEventsForDate(tidePortId, yyyymmdd)

    if (alert.tidePreference === 'high' || alert.tidePreference === 'low') {
      const nearestTide = findNearestTideTsByType(
        targetDate,
        tideEvents,
        alert.tidePreference,
      )
      if (!nearestTide) {
        stats.discardReasons.tide++
        continue
      }

      const start = nearestTide - 3 * 60 * 60 * 1000
      const end = nearestTide + 3 * 60 * 60 * 1000
      const ts = targetDate.getTime()
      if (ts < start || ts > end) {
        stats.discardReasons.tide++
        continue
      }
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

    if (alert.tidePreference === 'mid') {
      if (!tideClass || tideClass !== alert.tidePreference) {
        stats.discardReasons.tide++
        continue
      }
    }

    out.push({ forecast: candidate, tideClass, tideHeight })
  }

  return out
}

export interface DiscardReasons {
  wave: number
  period: number
  energy: number
  wind: number
  tide: number
  light: number
}

export interface CheckRunStats {
  totalAlerts: number
  matched: number
  notified: number
  errors: number
  passAll: number
  spots: string[]
  discardReasons: DiscardReasons
}

export async function runChecksWithDeps(
  deps: CheckRunnerDeps,
): Promise<CheckRunStats> {
  const contextHours = 4
  const now = deps.nowMs ?? (() => Date.now())
  const forecastsBySpot = new Map<string, SurfForecast[]>()
  const stats: CheckRunStats = {
    totalAlerts: deps.alerts.length,
    matched: 0,
    notified: 0,
    errors: 0,
    passAll: 0,
    spots: [...new Set(deps.alerts.map((a) => a.spot))],
    discardReasons: {
      wave: 0,
      period: 0,
      energy: 0,
      wind: 0,
      tide: 0,
      light: 0,
    },
  }

  for (const alert of deps.alerts) {
    try {
      if (alert.enabled === false) continue

      let forecasts = forecastsBySpot.get(alert.spotId)
      if (!forecasts) {
        forecasts = await deps.fetchForecasts(alert.spotId)
        forecastsBySpot.set(alert.spotId, forecasts)
      }
      if (!forecasts.length) continue

      const matchesFound: typeof forecasts = []
      for (const f of forecasts) {
        const forecastDate = new Date(f.date)
        if (Number.isNaN(forecastDate.getTime())) continue

        // Light filter first: skip nighttime hours before evaluating conditions
        const inLight = await deps.isWithinAlertWindow(alert.spot, forecastDate)
        if (!inLight) {
          stats.discardReasons.light++
          continue
        }

        const detail = matchDetail(alert, f)
        if (detail.pass) {
          matchesFound.push(f)
          stats.passAll++
        } else {
          if (!detail.wave) stats.discardReasons.wave++
          if (!detail.period) stats.discardReasons.period++
          if (!detail.energy) stats.discardReasons.energy++
          if (!detail.wind) stats.discardReasons.wind++
        }
      }
      if (!matchesFound.length) continue

      stats.matched++

      const candidateMatches = await buildCandidateMatches(
        alert,
        matchesFound,
        deps,
        stats,
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

      const orderedForecasts = [...forecasts]
        .filter((f) => Number.isFinite(new Date(f.date).getTime()))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

      const tableStartMs = startDate.getTime() - contextHours * 60 * 60 * 1000
      const tableEndMs = endDate.getTime() + contextHours * 60 * 60 * 1000
      const tableForecasts = orderedForecasts.filter((f) => {
        const at = new Date(f.date).getTime()
        return at >= tableStartMs && at <= tableEndMs
      })
      const windowStartIso = new Date(newWindow.startMs).toISOString()
      const windowEndIso = new Date(newWindow.endMs).toISOString()
      const matchedAtIso = new Date(now()).toISOString()

      deps.recordNotificationMatch?.({
        chatId: alert.chatId,
        alertId: alert.id,
        alertName: alert.name,
        spot: alert.spot,
        windowStartIso,
        windowEndIso,
        atIso: matchedAtIso,
      })

      const dedupeKey = `${alert.chatId}:${alert.spotId}:${buildAlertProfileKey(alert)}`
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
        windowForecasts: tableForecasts.length
          ? tableForecasts
          : window.items.map((i) => i.forecast),
      })

      await deps.sendMessage(alert.chatId, message)
      deps.setLastWindow?.(dedupeKey, newWindow)
      const sentAtIso = new Date(now()).toISOString()
      deps.touchAlertNotified(alert.id, sentAtIso)
      deps.recordNotificationSent?.({
        chatId: alert.chatId,
        alertId: alert.id,
        alertName: alert.name,
        spot: alert.spot,
        windowStartIso,
        windowEndIso,
        atIso: sentAtIso,
      })
      stats.notified++
    } catch (err) {
      console.error(`check_alert_error alert=${alert.id}`, err)
      stats.errors++
    }
  }

  return stats
}
