import type { TideEvent } from './alert-engine.js'
import type { DraftAlert, RangeOption } from './bot-options.js'
import {
  ENERGY_OPTIONS,
  PERIOD_OPTIONS,
  TIDE_PORT_OPTIONS,
  WAVE_OPTIONS,
  WIND_SECTORS,
} from './bot-options.js'
import { nextId } from './utils.js'
import type { AlertRule, SurfForecast, WindRange } from './types.js'

const MAX_CACHE_ENTRIES = 100
const sunsetCache = new Map<string, Date>()
const tideDayCache = new Map<string, TideEvent[]>()

function boundedSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
  cache.set(key, value)
}

const SPOT_COORDS: Record<string, { lat: number; lng: number }> = {
  sopelana: { lat: 43.3798, lng: -2.9808 },
}

export function toggle(selected: string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((x) => x !== id)
    : [...selected, id]
}

export function windSector(dir: string): [number, number] | null {
  const sector = WIND_SECTORS.find((s) => s.id === dir)
  if (!sector) return null
  return [sector.min, sector.max]
}

function toRanges(selected: string[], options: RangeOption[]): WindRange[] {
  return selected
    .map((id) => options.find((o) => o.id === id))
    .filter((x): x is RangeOption => Boolean(x))
    .map((x) => ({ min: x.min, max: x.max }))
}

function envelope(ranges: WindRange[]): { min: number; max: number } {
  return {
    min: Math.min(...ranges.map((r) => r.min)),
    max: Math.max(...ranges.map((r) => r.max)),
  }
}

export function draftToAlert(chatId: number, d: DraftAlert): AlertRule | null {
  if (!d.waveSelected.length || !d.periodSelected.length || !d.energySelected) {
    return null
  }

  const waveRanges = toRanges(d.waveSelected, WAVE_OPTIONS)
  const periodRanges = toRanges(d.periodSelected, PERIOD_OPTIONS)
  const energyOpt = ENERGY_OPTIONS.find((e) => e.id === d.energySelected)
  if (!waveRanges.length || !periodRanges.length || !energyOpt) return null

  const waveEnv = envelope(waveRanges)
  const periodEnv = envelope(periodRanges)

  const windRanges = d.windSelected
    .map((w) => windSector(w))
    .filter((w): w is [number, number] => Boolean(w))
    .map(([min, max]) => ({ min, max }))

  return {
    id: nextId(),
    chatId,
    name: d.name?.trim() || `Alerta ${new Date().toLocaleDateString('es-ES')}`,
    spot: d.spot,
    waveMin: waveEnv.min,
    waveMax: waveEnv.max,
    energyMin: energyOpt.min,
    energyMax: energyOpt.max,
    periodMin: periodEnv.min,
    periodMax: periodEnv.max,
    windRanges: windRanges.length ? windRanges : undefined,
    windLabels: d.windSelected.length ? d.windSelected : undefined,
    tidePortId: d.tidePortId ?? '72',
    tidePortName:
      TIDE_PORT_OPTIONS.find((p) => p.id === (d.tidePortId ?? '72'))?.label ??
      'Bermeo',
    tidePreference: d.tidePreference ?? 'any',
    createdAt: new Date().toISOString(),
    waveRanges,
    periodRanges,
    waveLabels: [...d.waveSelected],
    periodLabels: [...d.periodSelected],
    energyLabel: energyOpt.label,
  }
}

export function tideTag(pref: AlertRule['tidePreference']): string {
  if (pref === 'low') return 'baja'
  if (pref === 'mid') return 'media'
  if (pref === 'high') return 'alta'
  return 'any'
}

export function alertSummaryText(a: AlertRule): string {
  return [
    `🧾 Resumen de alerta: ${a.name}`,
    `• Spot: ${a.spot}`,
    `• Olas: ${a.waveLabels?.join(', ') ?? `${a.waveMin}-${a.waveMax}m`}`,
    `• Energía: ${a.energyLabel ?? `${a.energyMin}-${a.energyMax}`}`,
    `• Periodo: ${a.periodLabels?.join(', ') ?? `${a.periodMin}-${a.periodMax}s`}`,
    `• Viento: ${a.windLabels?.join(', ') ?? 'ANY'}`,
    `• Marea: ${tideTag(a.tidePreference)} (${a.tidePortName ?? 'Bermeo'})`,
  ].join('\n')
}

function yyyymmddFromDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

export function apiDateFromForecastDate(dateRaw: string): string {
  const m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}${m[2]}${m[3]}`
  return yyyymmddFromDate(new Date(dateRaw))
}

function localYmdInMadrid(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const y = parts.find((p) => p.type === 'year')?.value ?? '1970'
  const m = parts.find((p) => p.type === 'month')?.value ?? '01'
  const d = parts.find((p) => p.type === 'day')?.value ?? '01'
  return `${y}-${m}-${d}`
}

function localHourInMadrid(date: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    hour12: false,
  }).format(date)
  return Number(hour)
}

async function getSunsetDate(spot: string, date: Date): Promise<Date | null> {
  const coords = SPOT_COORDS[spot]
  if (!coords) return null

  const day = localYmdInMadrid(date)
  const cacheKey = `${spot}:${day}`
  const cached = sunsetCache.get(cacheKey)
  if (cached) return cached

  const url = `https://api.sunrise-sunset.org/json?lat=${coords.lat}&lng=${coords.lng}&date=${day}&formatted=0`
  const res = await fetch(url)
  if (!res.ok) return null

  const json = (await res.json()) as { results?: { sunset?: string } }
  const rawSunset = json.results?.sunset
  if (!rawSunset) return null

  const sunset = new Date(rawSunset)
  if (Number.isNaN(sunset.getTime())) return null

  boundedSet(sunsetCache, cacheKey, sunset)
  return sunset
}

export async function isWithinAlertWindow(
  spot: string,
  forecastDate: Date,
): Promise<boolean> {
  const localHour = localHourInMadrid(forecastDate)
  if (localHour < 5) return false

  const sunset = await getSunsetDate(spot, forecastDate)
  if (!sunset) return true

  const sunsetPlusOneHour = new Date(sunset.getTime() + 60 * 60 * 1000)
  return forecastDate.getTime() <= sunsetPlusOneHour.getTime()
}

export async function getTideEventsForDate(
  portId: string,
  yyyymmdd: string,
): Promise<TideEvent[]> {
  const cacheKey = `${portId}:${yyyymmdd}`
  const cached = tideDayCache.get(cacheKey)
  if (cached) return cached

  const url = `https://ideihm.covam.es/api-ihm/getmarea?request=gettide&id=${encodeURIComponent(
    portId,
  )}&format=json&date=${yyyymmdd}`
  const res = await fetch(url)
  if (!res.ok) return []
  const json = (await res.json()) as {
    mareas?: {
      fecha?: string
      datos?: { marea?: { hora: string; altura: string; tipo?: string }[] }
    }
  }

  const datePart = json.mareas?.fecha
    ? json.mareas.fecha
    : `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`

  const out: TideEvent[] = (json.mareas?.datos?.marea ?? []).map((m) => ({
    date: datePart,
    hora: m.hora,
    altura: Number(m.altura),
    tipo: m.tipo ?? '',
  }))

  boundedSet(tideDayCache, cacheKey, out)
  return out
}

export async function fetchForecasts(
  apiUrl: string,
  spot: string,
): Promise<SurfForecast[]> {
  const url = `${apiUrl}/surf-forecast/${encodeURIComponent(spot)}`
  const res = await fetch(url)
  if (!res.ok) return []
  return (await res.json()) as SurfForecast[]
}
