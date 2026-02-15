import 'dotenv/config'
import { Bot, GrammyError, InlineKeyboard } from 'grammy'
import {
  deleteAlert,
  insertAlert,
  listAlerts,
  listAllAlerts,
  touchAlertNotified,
} from './storage.js'
import type { AlertRule, SurfForecast, WindRange } from './types.js'
import { nextId } from './utils.js'
import type { TideEvent } from './alert-engine.js'
import { runChecksWithDeps, type AlertWindow } from './check-runner.js'
import { startHourlySchedulerAtMinute } from './scheduler.js'
import { buildCleanupDeleteList } from './flow-cleanup.js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const API_URL = process.env.BACKEND_API_URL ?? 'https://waves-db-backend.vercel.app'
const MIN_CONSECUTIVE_HOURS = Number(process.env.MIN_CONSECUTIVE_HOURS ?? 2)
const DEFAULT_SPOT = 'sopelana'

type Step = 'name' | 'wave' | 'energy' | 'period' | 'wind' | 'tidePort' | 'tidePref' | 'confirm'

type RangeOption = { id: string; label: string; min: number; max: number }

const WAVE_OPTIONS: RangeOption[] = [
  { id: '0.5', label: '0.5m', min: 0.5, max: 0.5 },
  { id: '1.0', label: '1.0m', min: 1.0, max: 1.0 },
  { id: '1.5', label: '1.5m', min: 1.5, max: 1.5 },
  { id: '2.0', label: '2.0m', min: 2.0, max: 2.0 },
  { id: '2.5', label: '2.5m', min: 2.5, max: 2.5 },
  { id: '3.0', label: '3.0m', min: 3.0, max: 3.0 },
  { id: '3.5', label: '3.5m', min: 3.5, max: 3.5 },
  { id: '4.0', label: '4.0m', min: 4.0, max: 4.0 },
]

const PERIOD_OPTIONS: RangeOption[] = [
  { id: '8-10', label: '8-10s', min: 8, max: 10 },
  { id: '10-12', label: '10-12s', min: 10, max: 12 },
  { id: '12-14', label: '12-14s', min: 12, max: 14 },
  { id: '14-16', label: '14-16s', min: 14, max: 16 },
  { id: '16+', label: '16+s', min: 16, max: 99 },
]

const ENERGY_OPTIONS: RangeOption[] = [
  { id: 'low', label: 'Baja (0-800)', min: 0, max: 800 },
  { id: 'medium', label: 'Media (800-1500)', min: 800, max: 1500 },
  { id: 'high', label: 'Alta (1500-4000)', min: 1500, max: 4000 },
  { id: 'very-high', label: 'Muy alta (4000+)', min: 4000, max: 999999 },
]

const TIDE_PORT_OPTIONS = [
  { id: '72', label: 'Bermeo' },
  { id: '2', label: 'Bilbao' },
] as const

const TIDE_PREF_OPTIONS = [
  { id: 'any', label: 'ANY (sin filtro)' },
  { id: 'low', label: 'Baja' },
  { id: 'mid', label: 'Media' },
  { id: 'high', label: 'Alta' },
] as const

interface DraftAlert {
  step: Step
  name?: string
  spot: string
  waveSelected: string[]
  periodSelected: string[]
  energySelected?: string
  windSelected: string[]
  tidePortId?: string
  tidePreference?: 'low' | 'mid' | 'high' | 'any'
  pendingAlert?: AlertRule
  flowMessageIds: number[]
}

const drafts = new Map<number, DraftAlert>()
const lastSentWindows = new Map<string, AlertWindow>()

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN')

const bot = new Bot(BOT_TOKEN)

bot.catch((err) => {
  console.error('bot_error', err.error)
})

async function safeEditReplyMarkup(ctx: any, replyMarkup: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: replyMarkup })
  } catch (err) {
    if (err instanceof GrammyError && err.description?.includes('message is not modified')) {
      return
    }
    throw err
  }
}

function toggle(selected: string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((x) => x !== id)
    : [...selected, id]
}

function windSector(dir: string): [number, number] | null {
  switch (dir) {
    case 'N':
      return [337.5, 22.5]
    case 'NE':
      return [22.5, 67.5]
    case 'E':
      return [67.5, 112.5]
    case 'SE':
      return [112.5, 157.5]
    case 'S':
      return [157.5, 202.5]
    case 'SW':
      return [202.5, 247.5]
    case 'W':
      return [247.5, 292.5]
    case 'NW':
      return [292.5, 337.5]
    default:
      return null
  }
}

function keyboardFromOptions(
  prefix: string,
  options: RangeOption[],
  selected: string[],
  allowDone = true,
): InlineKeyboard {
  const kb = new InlineKeyboard()
  options.forEach((o, idx) => {
    const txt = `${selected.includes(o.id) ? '✅ ' : ''}${o.label}`
    kb.text(txt, `${prefix}:${o.id}`)
    if (idx % 2 === 1) kb.row()
  })
  kb.row()
  if (allowDone) kb.text('✅ Confirmar', `${prefix}:DONE`)
  return kb
}

function windKeyboard(selected: string[]): InlineKeyboard {
  const on = (d: string) => (selected.includes(d) ? '✅ ' : '')
  return new InlineKeyboard()
    .text(`${on('N')}N ↓ (337-22°)`, 'wind:N')
    .text(`${on('NE')}NE ↙ (22-67°)`, 'wind:NE')
    .row()
    .text(`${on('E')}E ← (67-112°)`, 'wind:E')
    .text(`${on('SE')}SE ↖ (112-157°)`, 'wind:SE')
    .row()
    .text(`${on('S')}S ↑ (157-202°)`, 'wind:S')
    .text(`${on('SW')}SW ↗ (202-247°)`, 'wind:SW')
    .row()
    .text(`${on('W')}W → (247-292°)`, 'wind:W')
    .text(`${on('NW')}NW ↘ (292-337°)`, 'wind:NW')
    .row()
    .text('ANY (sin filtro)', 'wind:ANY')
    .text('✅ Confirmar', 'wind:DONE')
}

function tidePortKeyboard(selected?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
  TIDE_PORT_OPTIONS.forEach((p) => {
    kb.text(`${selected === p.id ? '✅ ' : ''}${p.label}`, `tideport:${p.id}`).row()
  })
  kb.text('✅ Confirmar', 'tideport:DONE')
  return kb
}

function tidePreferenceKeyboard(selected?: 'low' | 'mid' | 'high' | 'any'): InlineKeyboard {
  const kb = new InlineKeyboard()
  TIDE_PREF_OPTIONS.forEach((p) => {
    kb.text(`${selected === p.id ? '✅ ' : ''}${p.label}`, `tidepref:${p.id}`).row()
  })
  return kb
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

function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Guardar alerta', 'confirm:SAVE')
    .text('❌ Cancelar', 'confirm:CANCEL')
}

function alertSummaryText(a: AlertRule): string {
  return [
    `🧾 Resumen de alerta: ${a.name}`,
    `• Spot: ${a.spot}`,
    `• Olas: ${a.waveLabels?.join(', ') ?? `${a.waveMin}-${a.waveMax}m`}`,
    `• Energía: ${a.energyLabel ?? `${a.energyMin}-${a.energyMax}`}`,
    `• Periodo: ${a.periodLabels?.join(', ') ?? `${a.periodMin}-${a.periodMax}s`}`,
    `• Viento: ${a.windLabels?.join(', ') ?? 'ANY'}`,
    `• Marea: ${tideTag(a.tidePreference)} (${a.tidePortName ?? 'Bermeo'})`,
    `• Cooldown: ${a.cooldownMin} min`,
  ].join('\n')
}

const tideDayCache = new Map<string, TideEvent[]>()
const sunsetCache = new Map<string, Date>()

const SPOT_COORDS: Record<string, { lat: number; lng: number }> = {
  sopelana: { lat: 43.3798, lng: -2.9808 },
  sopela: { lat: 43.3798, lng: -2.9808 },
}

function yyyymmddFromDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function apiDateFromForecastDate(dateRaw: string): string {
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

  sunsetCache.set(cacheKey, sunset)
  return sunset
}

async function isWithinAlertWindow(spot: string, forecastDate: Date): Promise<boolean> {
  const localHour = localHourInMadrid(forecastDate)
  if (localHour < 5) return false

  const sunset = await getSunsetDate(spot, forecastDate)
  if (!sunset) return true

  const sunsetPlusOneHour = new Date(sunset.getTime() + 60 * 60 * 1000)
  return forecastDate.getTime() <= sunsetPlusOneHour.getTime()
}

function tideTag(pref: AlertRule['tidePreference']): string {
  if (pref === 'low') return 'baja'
  if (pref === 'mid') return 'media'
  if (pref === 'high') return 'alta'
  return 'any'
}

function tideClassByHeight(height: number, min: number, max: number): 'low' | 'mid' | 'high' {
  const span = max - min
  if (span <= 0) return 'mid'
  const ratio = (height - min) / span
  if (ratio < 1 / 3) return 'low'
  if (ratio < 2 / 3) return 'mid'
  return 'high'
}

function dateToEventDatePart(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
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

async function getTideEventsForDate(portId: string, yyyymmdd: string): Promise<TideEvent[]> {
  const cacheKey = `${portId}:${yyyymmdd}`
  const cached = tideDayCache.get(cacheKey)
  if (cached) return cached

  const url = `https://ideihm.covam.es/api-ihm/getmarea?request=gettide&id=${encodeURIComponent(
    portId,
  )}&format=json&date=${yyyymmdd}`
  const res = await fetch(url)
  if (!res.ok) return []
  const json = (await res.json()) as {
    mareas?: { fecha?: string; datos?: { marea?: { hora: string; altura: string; tipo?: string }[] } }
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

  tideDayCache.set(cacheKey, out)
  return out
}

function draftToAlert(chatId: number, d: DraftAlert): AlertRule | null {
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
    cooldownMin: 180,
    tidePortId: d.tidePortId ?? '72',
    tidePortName: TIDE_PORT_OPTIONS.find((p) => p.id === (d.tidePortId ?? '72'))?.label ?? 'Bermeo',
    tidePreference: d.tidePreference ?? 'any',
    lastNotifiedAt: undefined,
    createdAt: new Date().toISOString(),
    waveRanges,
    periodRanges,
    waveLabels: [...d.waveSelected],
    periodLabels: [...d.periodSelected],
    energyLabel: energyOpt.label,
  } as AlertRule
}

function cooldownOk(alert: AlertRule): boolean {
  if (!alert.lastNotifiedAt) return true
  const last = new Date(alert.lastNotifiedAt).getTime()
  return Date.now() - last >= alert.cooldownMin * 60_000
}

async function fetchForecasts(spot: string): Promise<SurfForecast[]> {
  const url = `${API_URL}/surf-forecast/${encodeURIComponent(spot)}`
  const res = await fetch(url)
  if (!res.ok) return []
  return (await res.json()) as SurfForecast[]
}

async function runChecks(): Promise<void> {
  await runChecksWithDeps({
    alerts: listAllAlerts(),
    minConsecutiveHours: MIN_CONSECUTIVE_HOURS,
    fetchForecasts,
    isWithinAlertWindow,
    getTideEventsForDate,
    apiDateFromForecastDate,
    sendMessage: (chatId, message) => bot.api.sendMessage(chatId, message).then(() => undefined),
    touchAlertNotified,
    getLastWindow: (key) => lastSentWindows.get(key),
    setLastWindow: (key, window) => {
      lastSentWindows.set(key, window)
    },
  })
}


async function flowReply(ctx: any, draft: DraftAlert, text: string, extra?: any): Promise<void> {
  const msg = await ctx.reply(text, extra)
  if (msg?.message_id) draft.flowMessageIds.push(msg.message_id)
}

async function cleanupDraftMessages(chatId: number, draft: DraftAlert, keepMessageId?: number): Promise<void> {
  for (const messageId of buildCleanupDeleteList(draft.flowMessageIds, keepMessageId)) {
    try {
      await bot.api.deleteMessage(chatId, messageId)
    } catch {
      // noop
    }
  }
}

const COMMANDS_HELP =
  'Comandos:\n/setalert - crear alerta guiada\n/listalerts - listar alertas\n/deletealert <id> - borrar alerta\n/cancel - cancelar flujo actual\n/help - ver comandos'

bot.command('start', async (ctx) => {
  await ctx.reply(`Bot listo.\n\n${COMMANDS_HELP}`)
})

bot.command('help', async (ctx) => {
  await ctx.reply(COMMANDS_HELP)
})

bot.command('setalert', async (ctx) => {
  drafts.set(ctx.chat.id, {
    step: 'name',
    spot: DEFAULT_SPOT,
    waveSelected: [],
    periodSelected: [],
    windSelected: [],
    tidePortId: '72',
    tidePreference: 'any',
    flowMessageIds: [],
  })

  const d = drafts.get(ctx.chat.id)
  if (!d) return
  await flowReply(ctx, d, 'Pon un nombre para la alerta:')
})

bot.command('cancel', async (ctx) => {
  const d = drafts.get(ctx.chat.id)
  if (d) {
    await cleanupDraftMessages(ctx.chat.id, d)
    drafts.delete(ctx.chat.id)
  }
  await ctx.reply('❌ Creación cancelada.')
})

bot.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim()
  if (text.startsWith('/')) {
    await next()
    return
  }

  const d = drafts.get(ctx.chat.id)
  if (!d || d.step !== 'name') {
    await next()
    return
  }

  d.name = text
  d.step = 'wave'

  await flowReply(ctx, d, `Spot fijo: ${DEFAULT_SPOT}`)
  await flowReply(ctx, d, 'Elige una o varias alturas:', {
    reply_markup: keyboardFromOptions('wave', WAVE_OPTIONS, []),
  })
})

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data
  const [prefix, value] = data.split(':')
  const chatId = ctx.chat?.id
  if (!chatId) return

  const d = drafts.get(chatId)
  if (!d) {
    await ctx.answerCallbackQuery({ text: 'No hay alerta en creación.' })
    return
  }

  if (prefix === 'wave') {
    if (value === 'DONE') {
      if (!d.waveSelected.length) {
        await ctx.answerCallbackQuery({ text: 'Selecciona al menos una altura' })
        return
      }
      d.step = 'energy'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige nivel de energía:', {
        reply_markup: keyboardFromOptions('energy', ENERGY_OPTIONS, []),
      })
      return
    }

    d.waveSelected = toggle(d.waveSelected, value)
    await ctx.answerCallbackQuery({
      text: `Alturas: ${d.waveSelected.join(', ') || 'ninguna'}`,
    })
    await safeEditReplyMarkup(ctx, keyboardFromOptions('wave', WAVE_OPTIONS, d.waveSelected))
    return
  }

  if (prefix === 'energy') {
    if (value === 'DONE') {
      if (!d.energySelected) {
        await ctx.answerCallbackQuery({ text: 'Elige un nivel de energía' })
        return
      }
      d.step = 'period'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige uno o varios rangos de periodo:', {
        reply_markup: keyboardFromOptions('period', PERIOD_OPTIONS, d.periodSelected),
      })
      return
    }

    d.energySelected = value
    await ctx.answerCallbackQuery({ text: `Energía: ${value}` })
    await safeEditReplyMarkup(ctx, keyboardFromOptions('energy', ENERGY_OPTIONS, [value]))
    return
  }

  if (prefix === 'period') {
    if (value === 'DONE') {
      if (!d.periodSelected.length) {
        await ctx.answerCallbackQuery({ text: 'Elige al menos un rango de periodo' })
        return
      }
      d.step = 'wind'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige una o varias direcciones de viento:', {
        reply_markup: windKeyboard(d.windSelected),
      })
      return
    }

    d.periodSelected = toggle(d.periodSelected, value)
    await ctx.answerCallbackQuery({
      text: `Periodos: ${d.periodSelected.join(', ') || 'ninguno'}`,
    })
    await safeEditReplyMarkup(ctx, keyboardFromOptions('period', PERIOD_OPTIONS, d.periodSelected))
    return
  }

  if (prefix === 'wind') {
    if (value === 'ANY') {
      d.windSelected = []
      d.step = 'tidePort'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige puerto de marea de referencia:', {
        reply_markup: tidePortKeyboard(d.tidePortId),
      })
      return
    }

    if (value === 'DONE') {
      d.step = 'tidePort'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige puerto de marea de referencia:', {
        reply_markup: tidePortKeyboard(d.tidePortId),
      })
      return
    }

    if (!windSector(value)) {
      await ctx.answerCallbackQuery({ text: 'Dirección inválida' })
      return
    }

    d.windSelected = toggle(d.windSelected, value)
    await ctx.answerCallbackQuery({ text: `Viento: ${d.windSelected.join(', ') || 'ANY'}` })
    await safeEditReplyMarkup(ctx, windKeyboard(d.windSelected))
    return
  }

  if (prefix === 'tideport') {
    if (value === 'DONE') {
      if (!d.tidePortId) {
        await ctx.answerCallbackQuery({ text: 'Elige un puerto' })
        return
      }
      d.step = 'tidePref'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige marea ideal:', {
        reply_markup: tidePreferenceKeyboard(d.tidePreference),
      })
      return
    }

    if (!TIDE_PORT_OPTIONS.find((p) => p.id === value)) {
      await ctx.answerCallbackQuery({ text: 'Puerto inválido' })
      return
    }

    d.tidePortId = value
    await ctx.answerCallbackQuery({ text: `Puerto: ${TIDE_PORT_OPTIONS.find((p) => p.id === value)?.label}` })
    await safeEditReplyMarkup(ctx, tidePortKeyboard(d.tidePortId))
    return
  }

  if (prefix === 'tidepref') {
    if (!TIDE_PREF_OPTIONS.find((p) => p.id === value)) {
      await ctx.answerCallbackQuery({ text: 'Opción inválida' })
      return
    }

    d.tidePreference = value as 'low' | 'mid' | 'high' | 'any'
    const final = draftToAlert(chatId, d)
    if (!final) {
      await ctx.answerCallbackQuery({ text: 'Faltan datos' })
      return
    }

    d.step = 'confirm'
    d.pendingAlert = final
    await ctx.answerCallbackQuery({ text: 'Revisa y confirma' })
    await flowReply(ctx, d, alertSummaryText(final), { reply_markup: confirmKeyboard() })
    return
  }

  if (prefix === 'confirm') {
    if (value === 'CANCEL') {
      await cleanupDraftMessages(chatId, d)
      drafts.delete(chatId)
      await ctx.answerCallbackQuery({ text: 'Cancelado' })
      await ctx.reply('❌ Alerta cancelada.')
      return
    }

    if (value === 'SAVE') {
      if (!d.pendingAlert) {
        await ctx.answerCallbackQuery({ text: 'No hay resumen pendiente' })
        return
      }

      insertAlert(d.pendingAlert)
      await ctx.answerCallbackQuery({ text: 'Alerta creada' })
      const doneMsg = await ctx.reply(`✅ Alerta creada: ${d.pendingAlert.id}`)
      await cleanupDraftMessages(chatId, d, doneMsg?.message_id)
      drafts.delete(chatId)
      return
    }
  }
})

bot.command('listalerts', async (ctx) => {
  const alerts = listAlerts(ctx.chat.id)
  if (!alerts.length) {
    await ctx.reply('No tienes alertas.')
    return
  }

  const blocks = alerts.map((a, idx) => {
    const wave = a.waveLabels?.join(', ') ?? `${a.waveMin}-${a.waveMax}m`
    const energy = a.energyLabel ?? `${a.energyMin}-${a.energyMax}`
    const period = a.periodLabels?.join(', ') ?? `${a.periodMin}-${a.periodMax}s`
    const wind = a.windLabels?.join(', ') ?? 'ANY'
    const tide = `${tideTag(a.tidePreference)} (${a.tidePortName ?? 'Bermeo'})`

    return [
      `#${idx + 1} · ${a.name}`,
      `ID: ${a.id}`,
      `Spot: ${a.spot}`,
      `Olas: ${wave}`,
      `Energía: ${energy}`,
      `Periodo: ${period}`,
      `Viento: ${wind}`,
      `Marea: ${tide}`,
      `Cooldown: ${a.cooldownMin} min`,
    ].join('\n')
  })

  await ctx.reply(`📋 Tus alertas\n\n${blocks.join('\n\n────────\n\n')}`)
})

bot.command('deletealert', async (ctx) => {
  const id = (ctx.message?.text ?? '').split(' ')[1]?.trim()
  if (!id) {
    await ctx.reply('Uso: /deletealert <id>')
    return
  }
  await ctx.reply(deleteAlert(ctx.chat.id, id) ? '🗑️ Alerta borrada' : 'No encontré esa alerta')
})

void bot.api
  .setMyCommands([
    { command: 'start', description: 'Iniciar bot y ver ayuda' },
    { command: 'setalert', description: 'Crear alerta guiada' },
    { command: 'listalerts', description: 'Ver tus alertas' },
    { command: 'deletealert', description: 'Borrar alerta por ID' },
    { command: 'cancel', description: 'Cancelar flujo de creación' },
    { command: 'help', description: 'Mostrar comandos disponibles' },
  ])
  .catch(() => {
    // noop
  })

bot.start()
startHourlySchedulerAtMinute(() => runChecks(), 10)
void runChecks()

console.log('waves-alerts-bot running. scheduler=:10 Europe/Madrid')
