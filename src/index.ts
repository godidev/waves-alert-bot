import 'dotenv/config'
import { Bot } from 'grammy'
import {
  deleteAlert,
  insertAlert,
  listAlerts,
  listAllAlerts,
  setAlertEnabled,
  touchAlertNotified,
} from './infra/storage.js'
import { runChecksWithDeps, type AlertWindow } from './core/check-runner.js'
import { buildAlertMessage } from './core/alert-engine.js'
import { appendCheckLog, readLog } from './infra/check-logger.js'
import {
  recordNotificationMatch,
  recordNotificationSent,
} from './infra/notification-log.js'
import { startHourlySchedulerAtMinute } from './core/scheduler.js'
import { buildCleanupDeleteList } from './bot/flow-cleanup.js'
import {
  BOT_COMMANDS,
  COMMANDS_HELP,
  DEFAULT_SPOT,
  ENERGY_OPTIONS,
  PERIOD_OPTIONS,
  TIDE_PORT_OPTIONS,
  TIDE_PREF_OPTIONS,
  WAVE_OPTIONS,
  type DraftAlert,
} from './bot/bot-options.js'
import {
  alertActionsKeyboard,
  confirmKeyboard,
  keyboardFromOptions,
  safeEditReplyMarkup,
  spotsKeyboard,
  tidePortKeyboard,
  tidePreferenceKeyboard,
  windKeyboard,
} from './bot/bot-ui.js'
import {
  alertSummaryText,
  apiDateFromForecastDate,
  draftToAlert,
  fetchForecasts,
  fetchSpots,
  getTideEventsForDate,
  isWithinAlertWindow,
  tideTag,
  toggle,
  windSector,
} from './bot/bot-helpers.js'
import type { AlertRule, SurfForecast } from './core/types.js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const API_URL =
  process.env.BACKEND_API_URL ?? 'https://waves-db-backend.vercel.app'
const MIN_CONSECUTIVE_HOURS = Number(process.env.MIN_CONSECUTIVE_HOURS ?? 2)
const DEV_CHAT_ID = process.env.DEV_CHAT_ID
  ? Number(process.env.DEV_CHAT_ID)
  : undefined
const SPOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const drafts = new Map<number, DraftAlert>()
const lastSentWindows = new Map<string, AlertWindow>()
const startedAt = Date.now()
let cachedSpotOptions: string[] | null = null
let spotOptionsExpireAtMs = 0

function isDevChat(chatId: number): boolean {
  return DEV_CHAT_ID !== undefined && chatId === DEV_CHAT_ID
}

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN')

const bot = new Bot(BOT_TOKEN)

function notifyDev(message: string): void {
  if (!DEV_CHAT_ID) return
  bot.api.sendMessage(DEV_CHAT_ID, message).catch(() => {
    // noop – avoid infinite error loops
  })
}

bot.catch((err) => {
  console.error('bot_error', err.error)
  notifyDev(`[bot.catch] ${String(err.error)}`)
})

async function runChecks(): Promise<void> {
  const start = Date.now()
  const stats = await runChecksWithDeps({
    alerts: listAllAlerts(),
    minConsecutiveHours: MIN_CONSECUTIVE_HOURS,
    fetchForecasts: (spot) => fetchForecasts(API_URL, spot),
    isWithinAlertWindow,
    getTideEventsForDate,
    apiDateFromForecastDate,
    sendMessage: (chatId, message) =>
      bot.api
        .sendMessage(chatId, message, { parse_mode: 'HTML' })
        .then(() => undefined),
    touchAlertNotified,
    recordNotificationMatch,
    recordNotificationSent,
    getLastWindow: (key) => lastSentWindows.get(key),
    setLastWindow: (key, window) => {
      lastSentWindows.set(key, window)
    },
  })

  appendCheckLog({
    timestamp: new Date().toISOString(),
    totalAlerts: stats.totalAlerts,
    matched: stats.matched,
    notified: stats.notified,
    errors: stats.errors,
    passAll: stats.passAll,
    spots: stats.spots,
    durationMs: Date.now() - start,
    discardReasons: stats.discardReasons,
  })
}

function normalizeSpots(spots: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const raw of spots) {
    const spot = raw.trim()
    if (!spot) continue
    const key = spot.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(spot)
  }

  if (!normalized.length) return [DEFAULT_SPOT]
  if (normalized.some((spot) => spot.toLowerCase() === DEFAULT_SPOT)) {
    return normalized
  }

  return [DEFAULT_SPOT, ...normalized]
}

async function loadSpotOptions(): Promise<string[]> {
  const nowMs = Date.now()
  if (cachedSpotOptions && nowMs < spotOptionsExpireAtMs) {
    return cachedSpotOptions
  }

  const backendSpots = await fetchSpots(API_URL)
  if (backendSpots.length) {
    const normalized = normalizeSpots(backendSpots)
    cachedSpotOptions = normalized
    spotOptionsExpireAtMs = nowMs + SPOTS_CACHE_TTL_MS
    return normalized
  }

  return cachedSpotOptions ?? [DEFAULT_SPOT]
}

async function flowReply<TExtra>(
  ctx: {
    reply: (text: string, extra?: TExtra) => Promise<{ message_id?: number }>
  },
  draft: DraftAlert,
  text: string,
  extra?: TExtra,
): Promise<void> {
  const msg = await ctx.reply(text, extra)
  if (msg?.message_id) draft.flowMessageIds.push(msg.message_id)
}

async function cleanupDraftMessages(
  chatId: number,
  draft: DraftAlert,
  keepMessageId?: number,
): Promise<void> {
  for (const messageId of buildCleanupDeleteList(
    draft.flowMessageIds,
    keepMessageId,
  )) {
    try {
      await bot.api.deleteMessage(chatId, messageId)
    } catch {
      // noop
    }
  }
}

function fmtRangeNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(1)
}

function formatCompactRange(
  min: number,
  max: number,
  openStart?: number,
): string {
  if (openStart == null || max < openStart) {
    return `${fmtRangeNumber(min)}-${fmtRangeNumber(max)}`
  }
  if (min >= openStart) return `${fmtRangeNumber(openStart)}+`
  return `${fmtRangeNumber(min)}-${fmtRangeNumber(openStart)}+`
}

function listAlertBlock(a: AlertRule, idx: number): string {
  const wave = `${fmtRangeNumber(a.waveMin)}-${fmtRangeNumber(a.waveMax)}`
  const energy = formatCompactRange(a.energyMin, a.energyMax, 4000)
  const period = formatCompactRange(a.periodMin, a.periodMax, 16)
  const wind = a.windLabels?.join(', ') ?? 'ANY'
  const tide = `${tideTag(a.tidePreference)} (${a.tidePortName ?? 'Bermeo'})`
  const status = a.enabled === false ? 'pausada' : 'activa'

  return [
    `#${idx + 1} · ${a.name}`,
    `ID: ${a.id}`,
    `Spot: ${a.spot}`,
    `Olas: ${wave}`,
    `Energía: ${energy}`,
    `Periodo: ${period}`,
    `Viento: ${wind}`,
    `Marea: ${tide}`,
    `Estado: ${status}`,
  ].join('\n')
}

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
    energySelected: [],
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
  d.step = 'spot'

  const spots = await loadSpotOptions()
  d.availableSpots = spots
  if (!spots.includes(d.spot)) d.spot = spots[0] ?? DEFAULT_SPOT

  await flowReply(ctx, d, 'Elige spot para esta alerta:', {
    reply_markup: spotsKeyboard(spots, d.spot, true),
  })
})

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data
  const [prefix, value] = data.split(':')
  const chatId = ctx.chat?.id
  if (!chatId) return

  if (prefix === 'delalert') {
    if (!value) {
      await ctx.answerCallbackQuery({ text: 'ID de alerta inválido' })
      return
    }

    const deleted = deleteAlert(chatId, value)
    await ctx.answerCallbackQuery({
      text: deleted ? '🗑️ Alerta borrada' : 'No encontré esa alerta',
    })

    if (deleted) {
      try {
        await ctx.deleteMessage()
      } catch {
        // noop
      }
    }
    return
  }

  if (prefix === 'togglealert') {
    if (!value) {
      await ctx.answerCallbackQuery({ text: 'ID de alerta inválido' })
      return
    }

    const target = listAlerts(chatId).find((a) => a.id === value)
    if (!target) {
      await ctx.answerCallbackQuery({ text: 'No encontré esa alerta' })
      return
    }

    const nextEnabled = target.enabled === false
    const updated = setAlertEnabled(chatId, value, nextEnabled)
    await ctx.answerCallbackQuery({
      text: updated
        ? nextEnabled
          ? '▶️ Alerta reanudada'
          : '⏸️ Alerta pausada'
        : 'No pude actualizar la alerta',
    })

    if (updated) {
      const updatedAlerts = listAlerts(chatId)
      const alertIdx = updatedAlerts.findIndex((a) => a.id === value)
      const updatedAlert = alertIdx >= 0 ? updatedAlerts[alertIdx] : null

      if (updatedAlert) {
        try {
          await ctx.editMessageText(listAlertBlock(updatedAlert, alertIdx), {
            reply_markup: alertActionsKeyboard(
              updatedAlert.id,
              updatedAlert.enabled !== false,
            ),
          })
        } catch {
          await safeEditReplyMarkup(
            ctx,
            alertActionsKeyboard(value, nextEnabled),
          )
        }
      }
    }
    return
  }

  const d = drafts.get(chatId)
  if (!d) {
    await ctx.answerCallbackQuery({ text: 'No hay alerta en creación.' })
    return
  }

  if (prefix === 'spot') {
    if (value === 'BACK') {
      d.step = 'name'
      await ctx.answerCallbackQuery({ text: 'Paso anterior' })
      await flowReply(ctx, d, 'Pon un nombre para la alerta:')
      return
    }

    if (value === 'DONE') {
      const options = d.availableSpots?.length
        ? d.availableSpots
        : await loadSpotOptions()
      d.availableSpots = options
      if (!options.includes(d.spot)) {
        await ctx.answerCallbackQuery({ text: 'Elige un spot válido' })
        return
      }

      d.step = 'wave'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige una o varias alturas:', {
        reply_markup: keyboardFromOptions('wave', WAVE_OPTIONS, [], true, true),
      })
      return
    }

    if (!value) {
      await ctx.answerCallbackQuery({ text: 'Spot inválido' })
      return
    }

    const selectedSpot = decodeURIComponent(value)
    const options = d.availableSpots?.length
      ? d.availableSpots
      : await loadSpotOptions()
    d.availableSpots = options

    if (!options.includes(selectedSpot)) {
      await ctx.answerCallbackQuery({ text: 'Spot inválido' })
      return
    }

    d.spot = selectedSpot
    await ctx.answerCallbackQuery({ text: `Spot: ${selectedSpot}` })
    await safeEditReplyMarkup(ctx, spotsKeyboard(options, d.spot, true))
    return
  }

  if (prefix === 'wave') {
    if (value === 'BACK') {
      d.step = 'spot'
      const options = d.availableSpots?.length
        ? d.availableSpots
        : await loadSpotOptions()
      d.availableSpots = options
      await ctx.answerCallbackQuery({ text: 'Paso anterior' })
      await flowReply(ctx, d, 'Elige spot para esta alerta:', {
        reply_markup: spotsKeyboard(options, d.spot, true),
      })
      return
    }

    if (value === 'DONE') {
      if (!d.waveSelected.length) {
        await ctx.answerCallbackQuery({
          text: 'Selecciona al menos una altura',
        })
        return
      }
      d.step = 'energy'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige uno o varios rangos de energía:', {
        reply_markup: keyboardFromOptions(
          'energy',
          ENERGY_OPTIONS,
          d.energySelected,
          true,
          true,
        ),
      })
      return
    }

    d.waveSelected = toggle(d.waveSelected, value)
    await ctx.answerCallbackQuery({
      text: `Alturas: ${d.waveSelected.join(', ') || 'ninguna'}`,
    })
    await safeEditReplyMarkup(
      ctx,
      keyboardFromOptions('wave', WAVE_OPTIONS, d.waveSelected, true, true),
    )
    return
  }

  if (prefix === 'energy') {
    if (value === 'BACK') {
      d.step = 'wave'
      await ctx.answerCallbackQuery({ text: 'Paso anterior' })
      await flowReply(ctx, d, 'Elige una o varias alturas:', {
        reply_markup: keyboardFromOptions(
          'wave',
          WAVE_OPTIONS,
          d.waveSelected,
          true,
          true,
        ),
      })
      return
    }

    if (value === 'DONE') {
      if (!d.energySelected.length) {
        await ctx.answerCallbackQuery({
          text: 'Elige al menos un rango de energía',
        })
        return
      }
      d.step = 'period'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige uno o varios rangos de periodo:', {
        reply_markup: keyboardFromOptions(
          'period',
          PERIOD_OPTIONS,
          d.periodSelected,
          true,
          true,
        ),
      })
      return
    }

    d.energySelected = toggle(d.energySelected, value)
    await ctx.answerCallbackQuery({
      text: `Energía: ${d.energySelected.join(', ') || 'ninguna'}`,
    })
    await safeEditReplyMarkup(
      ctx,
      keyboardFromOptions(
        'energy',
        ENERGY_OPTIONS,
        d.energySelected,
        true,
        true,
      ),
    )
    return
  }

  if (prefix === 'period') {
    if (value === 'BACK') {
      d.step = 'energy'
      await ctx.answerCallbackQuery({ text: 'Paso anterior' })
      await flowReply(ctx, d, 'Elige uno o varios rangos de energía:', {
        reply_markup: keyboardFromOptions(
          'energy',
          ENERGY_OPTIONS,
          d.energySelected,
          true,
          true,
        ),
      })
      return
    }

    if (value === 'DONE') {
      if (!d.periodSelected.length) {
        await ctx.answerCallbackQuery({
          text: 'Elige al menos un rango de periodo',
        })
        return
      }
      d.step = 'wind'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige una o varias direcciones de viento:', {
        reply_markup: windKeyboard(d.windSelected, true),
      })
      return
    }

    d.periodSelected = toggle(d.periodSelected, value)
    await ctx.answerCallbackQuery({
      text: `Periodos: ${d.periodSelected.join(', ') || 'ninguno'}`,
    })
    await safeEditReplyMarkup(
      ctx,
      keyboardFromOptions(
        'period',
        PERIOD_OPTIONS,
        d.periodSelected,
        true,
        true,
      ),
    )
    return
  }

  if (prefix === 'wind') {
    if (value === 'BACK') {
      d.step = 'period'
      await ctx.answerCallbackQuery({ text: 'Paso anterior' })
      await flowReply(ctx, d, 'Elige uno o varios rangos de periodo:', {
        reply_markup: keyboardFromOptions(
          'period',
          PERIOD_OPTIONS,
          d.periodSelected,
          true,
          true,
        ),
      })
      return
    }

    if (value === 'ANY') {
      d.windSelected = []
      d.step = 'tidePort'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige puerto de marea de referencia:', {
        reply_markup: tidePortKeyboard(d.tidePortId, true),
      })
      return
    }

    if (value === 'DONE') {
      d.step = 'tidePort'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige puerto de marea de referencia:', {
        reply_markup: tidePortKeyboard(d.tidePortId, true),
      })
      return
    }

    if (!windSector(value)) {
      await ctx.answerCallbackQuery({ text: 'Dirección inválida' })
      return
    }

    d.windSelected = toggle(d.windSelected, value)
    await ctx.answerCallbackQuery({
      text: `Viento: ${d.windSelected.join(', ') || 'ANY'}`,
    })
    await safeEditReplyMarkup(ctx, windKeyboard(d.windSelected, true))
    return
  }

  if (prefix === 'tideport') {
    if (value === 'BACK') {
      d.step = 'wind'
      await ctx.answerCallbackQuery({ text: 'Paso anterior' })
      await flowReply(ctx, d, 'Elige una o varias direcciones de viento:', {
        reply_markup: windKeyboard(d.windSelected, true),
      })
      return
    }

    if (value === 'DONE') {
      if (!d.tidePortId) {
        await ctx.answerCallbackQuery({ text: 'Elige un puerto' })
        return
      }
      d.step = 'tidePref'
      await ctx.answerCallbackQuery({ text: 'OK' })
      await flowReply(ctx, d, 'Elige marea ideal:', {
        reply_markup: tidePreferenceKeyboard(d.tidePreference, true),
      })
      return
    }

    if (!TIDE_PORT_OPTIONS.find((p) => p.id === value)) {
      await ctx.answerCallbackQuery({ text: 'Puerto inválido' })
      return
    }

    d.tidePortId = value
    await ctx.answerCallbackQuery({
      text: `Puerto: ${TIDE_PORT_OPTIONS.find((p) => p.id === value)?.label}`,
    })
    await safeEditReplyMarkup(ctx, tidePortKeyboard(d.tidePortId, true))
    return
  }

  if (prefix === 'tidepref') {
    if (value === 'BACK') {
      d.step = 'tidePort'
      d.pendingAlert = undefined
      await ctx.answerCallbackQuery({ text: 'Paso anterior' })
      await flowReply(ctx, d, 'Elige puerto de marea de referencia:', {
        reply_markup: tidePortKeyboard(d.tidePortId, true),
      })
      return
    }

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
    await flowReply(ctx, d, alertSummaryText(final), {
      reply_markup: confirmKeyboard(),
    })
    return
  }

  if (prefix === 'confirm') {
    if (value === 'BACK') {
      d.step = 'tidePref'
      d.pendingAlert = undefined
      await ctx.answerCallbackQuery({ text: 'Paso anterior' })
      await flowReply(ctx, d, 'Elige marea ideal:', {
        reply_markup: tidePreferenceKeyboard(d.tidePreference, true),
      })
      return
    }

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

/* ─── Dev-only commands (hidden, guarded by DEV_CHAT_ID) ─── */

bot.command('status', async (ctx) => {
  if (!isDevChat(ctx.chat.id)) return

  const allAlerts = listAllAlerts()
  const spots = [...new Set(allAlerts.map((a) => a.spot))]
  const log = readLog()
  const last = log.at(-1)
  const uptimeMs = Date.now() - startedAt
  const uptimeH = Math.floor(uptimeMs / 3_600_000)
  const uptimeM = Math.floor((uptimeMs % 3_600_000) / 60_000)

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })

  // Latency percentiles from historical log
  const durations = log.map((e) => e.durationMs).sort((a, b) => a - b)
  const percentile = (arr: number[], p: number) =>
    arr.length ? arr[Math.min(Math.floor(arr.length * p), arr.length - 1)] : 0
  const p50 = percentile(durations, 0.5)
  const p95 = percentile(durations, 0.95)

  // Error stats from log
  const okChecks = log.filter((e) => e.errors === 0).length
  const errChecks = log.filter((e) => e.errors > 0).length

  const spotsLine = spots.length ? spots.join(', ') : 'ninguno'

  const header = [
    '--- Bot Status ---',
    `Uptime: ${uptimeH}h ${uptimeM}m | Checks: ${log.length} (ok:${okChecks} err:${errChecks}) | Lat p50: ${p50}ms p95: ${p95}ms`,
    `Alertas activas: ${allAlerts.length} (${spotsLine}) | Cooldowns activos: ${lastSentWindows.size}`,
  ]

  if (!last) {
    await ctx.reply([...header, '', 'Sin datos de checks.'].join('\n'))
    return
  }

  const d = last.discardReasons
  const lastLines = [
    '',
    `Último check: ${fmtDate(last.timestamp)} — ${last.durationMs}ms`,
    `Matched: ${last.matched} | Enviadas: ${last.notified}`,
    '',
    'Motivos:',
    `  - luz: ${d.light}h ❌`,
    `  - viento: ${d.wind}h ❌`,
    `  - periodo: ${d.period}h ❌`,
    `  - ola: ${d.wave}h ❌`,
    `  - energía: ${d.energy}h ❌`,
    `  - marea: ${d.tide}h ❌`,
    `Horas que cumplen todo: ${last.passAll}h ✅`,
  ]

  await ctx.reply([...header, ...lastLines].join('\n'))
})

bot.command('checklog', async (ctx) => {
  if (!isDevChat(ctx.chat.id)) return

  const log = readLog()
  if (!log.length) {
    await ctx.reply('Check log vacío.')
    return
  }

  const recent = log.slice(-10)
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  const lines = recent.map((e) => {
    return `${fmtDate(e.timestamp)} | ${e.durationMs}ms | alertas=${e.totalAlerts} matched=${e.matched} enviadas=${e.notified}`
  })

  await ctx.reply(
    `--- Últimos ${recent.length} checks ---\n\n${lines.join('\n')}`,
  )
})

bot.command('runnow', async (ctx) => {
  if (!isDevChat(ctx.chat.id)) return

  await ctx.reply('Ejecutando check run...')
  try {
    await runChecks()
    const last = readLog().at(-1)
    await ctx.reply(
      last
        ? `Check completado en ${last.durationMs}ms\nmatched=${last.matched} notified=${last.notified}`
        : 'Check completado (sin datos de log)',
    )
  } catch (err) {
    await ctx.reply(`Error en check run: ${String(err)}`)
  }
})

bot.command('previewalert', async (ctx) => {
  if (!isDevChat(ctx.chat.id)) return

  const alert: AlertRule = {
    id: 'preview-alert',
    chatId: ctx.chat.id,
    name: 'Preview Sopelana',
    spot: 'sopelana',
    waveMin: 1,
    waveMax: 4,
    energyMin: 800,
    energyMax: 4000,
    periodMin: 10,
    periodMax: 16,
    windRanges: [{ min: 180, max: 260 }],
    tidePortId: '72',
    tidePortName: 'Bermeo',
    tidePreference: 'high',
    createdAt: new Date().toISOString(),
  }

  const rows: SurfForecast[] = [
    {
      date: '2026-02-19T06:00:00.000Z',
      spot: 'sopelana',
      energy: 1500,
      wind: { speed: 18, angle: 235 },
      validSwells: [{ angle: 300, height: 1.6, period: 12 }],
    },
    {
      date: '2026-02-19T07:00:00.000Z',
      spot: 'sopelana',
      energy: 1800,
      wind: { speed: 20, angle: 230 },
      validSwells: [{ angle: 300, height: 1.8, period: 12 }],
    },
    {
      date: '2026-02-19T08:00:00.000Z',
      spot: 'sopelana',
      energy: 2100,
      wind: { speed: 22, angle: 225 },
      validSwells: [{ angle: 300, height: 2.0, period: 13 }],
    },
    {
      date: '2026-02-19T09:00:00.000Z',
      spot: 'sopelana',
      energy: 2400,
      wind: { speed: 24, angle: 220 },
      validSwells: [{ angle: 300, height: 2.2, period: 13 }],
    },
    {
      date: '2026-02-19T10:00:00.000Z',
      spot: 'sopelana',
      energy: 3000,
      wind: { speed: 28, angle: 215 },
      validSwells: [{ angle: 300, height: 2.5, period: 14 }],
    },
    {
      date: '2026-02-19T11:00:00.000Z',
      spot: 'sopelana',
      energy: 3400,
      wind: { speed: 35, angle: 210 },
      validSwells: [{ angle: 300, height: 2.9, period: 14 }],
    },
    {
      date: '2026-02-19T12:00:00.000Z',
      spot: 'sopelana',
      energy: 3900,
      wind: { speed: 42, angle: 205 },
      validSwells: [{ angle: 300, height: 3.2, period: 13 }],
    },
  ]

  const message = buildAlertMessage({
    alert,
    first: rows[2],
    startDate: new Date(rows[2].date),
    endDate: new Date(rows[4].date),
    nearestTides: {
      high: {
        date: '2026-02-19',
        hora: '08:34',
        altura: 4.35,
        tipo: 'pleamar',
      },
      low: { date: '2026-02-19', hora: '14:44', altura: 0.37, tipo: 'bajamar' },
    },
    windowForecasts: rows,
  })

  await ctx.reply('Preview de notificacion (datos inventados):')
  await ctx.reply(message, { parse_mode: 'HTML' })
})

bot.command('alerts_all', async (ctx) => {
  if (!isDevChat(ctx.chat.id)) return

  const allAlerts = listAllAlerts()
  if (!allAlerts.length) {
    await ctx.reply('No hay alertas registradas.')
    return
  }

  const blocks = allAlerts.map((a) => {
    const wave = `${fmtRangeNumber(a.waveMin)}-${fmtRangeNumber(a.waveMax)}`
    const energy = formatCompactRange(a.energyMin, a.energyMax, 4000)
    const period = formatCompactRange(a.periodMin, a.periodMax, 16)
    const wind = a.windLabels?.join(', ') ?? 'ANY'
    const tide = `${tideTag(a.tidePreference)} (${a.tidePortName ?? 'Bermeo'})`
    const status = a.enabled === false ? 'pausada' : 'activa'
    const notified = a.lastNotifiedAt
      ? a.lastNotifiedAt.replace('T', ' ').slice(0, 19)
      : 'nunca'

    return [
      `${a.name} [${a.id}]`,
      `chatId: ${a.chatId}`,
      `spot: ${a.spot}`,
      `olas: ${wave} | energia: ${energy} | periodo: ${period}`,
      `viento: ${wind} | marea: ${tide}`,
      `estado: ${status}`,
      `última notificación: ${notified}`,
    ].join('\n')
  })

  const msg = `--- Todas las alertas (${allAlerts.length}) ---\n\n${blocks.join('\n\n────────\n\n')}`
  // Telegram max message length is 4096; split if needed
  if (msg.length <= 4096) {
    await ctx.reply(msg)
  } else {
    for (let i = 0; i < msg.length; i += 4096) {
      await ctx.reply(msg.slice(i, i + 4096))
    }
  }
})

bot.command('listalerts', async (ctx) => {
  const alerts = listAlerts(ctx.chat.id)
  if (!alerts.length) {
    await ctx.reply('No tienes alertas.')
    return
  }

  await ctx.reply(`📋 Tus alertas (${alerts.length})`)

  for (const [idx, a] of alerts.entries()) {
    await ctx.reply(listAlertBlock(a, idx), {
      reply_markup: alertActionsKeyboard(a.id, a.enabled !== false),
    })
  }
})

void bot.api.setMyCommands(BOT_COMMANDS).catch(() => {
  // noop
})

if (DEV_CHAT_ID) {
  void bot.api
    .setMyCommands(
      [
        ...BOT_COMMANDS,
        { command: 'status', description: 'Estado del bot' },
        { command: 'checklog', description: 'Últimos check runs' },
        { command: 'runnow', description: 'Forzar check run' },
        { command: 'previewalert', description: 'Preview de alerta (demo)' },
        { command: 'alerts_all', description: 'Todas las alertas (admin)' },
      ],
      { scope: { type: 'chat', chat_id: DEV_CHAT_ID } },
    )
    .catch(() => {
      // noop
    })
}

bot.start()
startHourlySchedulerAtMinute(
  () =>
    runChecks().catch((err) => {
      console.error('scheduler_check_error', err)
      notifyDev(`[scheduler] Check run error: ${String(err)}`)
    }),
  10,
)
void runChecks().catch((err) => {
  console.error('initial_check_error', err)
  notifyDev(`[startup] Check run error: ${String(err)}`)
})

console.log('waves-alerts-bot running. scheduler=:10 Europe/Madrid')
