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
import { appendCheckLog } from './infra/check-logger.js'
import {
  recordNotificationMatch,
  recordNotificationSent,
} from './infra/notification-log.js'
import { startHourlySchedulerAtMinute } from './core/scheduler.js'
import { buildCleanupDeleteList } from './bot/flow-cleanup.js'
import {
  BOT_COMMANDS,
  COMMANDS_HELP,
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
import { listAlertBlock } from './bot/alert-text.js'
import {
  alertSummaryText,
  apiDateFromForecastDate,
  draftToAlert,
  deriveOptimalSelections,
  fetchForecasts,
  fetchSpots,
  getTideEventsForDate,
  isWithinAlertWindow,
  toggle,
  windSector,
} from './bot/bot-helpers.js'
import {
  registerDevCommandMenu,
  registerDevCommands,
} from './bot/dev-commands.js'
import type { SpotOption } from './core/types.js'

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
let cachedSpotOptions: SpotOption[] | null = null
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

function normalizeSpots(spots: SpotOption[]): SpotOption[] {
  const seen = new Set<string>()
  const normalized: SpotOption[] = []

  for (const spot of spots) {
    const spotId = spot.spotId.trim()
    const spotName = spot.spotName.trim()
    if (!spotId || !spotName) continue
    if (seen.has(spotId)) continue
    seen.add(spotId)
    normalized.push({ ...spot, spotId, spotName })
  }

  return normalized
}

async function loadSpotOptions(): Promise<SpotOption[]> {
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

  return cachedSpotOptions ?? []
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

bot.command('start', async (ctx) => {
  await ctx.reply(`Bot listo.\n\n${COMMANDS_HELP}`)
})

bot.command('help', async (ctx) => {
  await ctx.reply(COMMANDS_HELP)
})

bot.command('setalert', async (ctx) => {
  drafts.set(ctx.chat.id, {
    step: 'name',
    spotId: '',
    spot: '',
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
  if (!spots.length) {
    await flowReply(
      ctx,
      d,
      'No hay spots activos disponibles ahora mismo. Intentalo mas tarde.',
    )
    drafts.delete(ctx.chat.id)
    return
  }

  d.availableSpots = spots
  if (!spots.some((spot) => spot.spotId === d.spotId)) {
    d.spotId = spots[0]?.spotId ?? ''
    d.spot = spots[0]?.spotName ?? ''
  }

  const selectedSpot = spots.find((spot) => spot.spotId === d.spotId)
  if (selectedSpot) {
    const optimal = deriveOptimalSelections(selectedSpot)
    d.periodSelected = optimal.periodSelected
    d.windSelected = optimal.windSelected
    d.spotOptimalPeriodRange = optimal.periodRange
    d.spotOptimalWindRange = optimal.windRange
  }

  await flowReply(ctx, d, 'Elige spot para esta alerta:', {
    reply_markup: spotsKeyboard(spots, d.spotId, true),
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
      if (!options.some((spot) => spot.spotId === d.spotId)) {
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

    const selectedSpotId = decodeURIComponent(value)
    const options = d.availableSpots?.length
      ? d.availableSpots
      : await loadSpotOptions()
    d.availableSpots = options

    const selectedSpot = options.find((spot) => spot.spotId === selectedSpotId)
    if (!selectedSpot) {
      await ctx.answerCallbackQuery({ text: 'Spot inválido' })
      return
    }

    d.spotId = selectedSpot.spotId
    d.spot = selectedSpot.spotName
    const optimal = deriveOptimalSelections(selectedSpot)
    d.periodSelected = optimal.periodSelected
    d.windSelected = optimal.windSelected
    d.spotOptimalPeriodRange = optimal.periodRange
    d.spotOptimalWindRange = optimal.windRange
    await ctx.answerCallbackQuery({ text: `Spot: ${selectedSpot.spotName}` })
    await safeEditReplyMarkup(ctx, spotsKeyboard(options, d.spotId, true))
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
        reply_markup: spotsKeyboard(options, d.spotId, true),
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

registerDevCommands(bot, {
  isDevChat,
  startedAt,
  runChecks,
  lastSentWindows,
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
  registerDevCommandMenu(bot, DEV_CHAT_ID, BOT_COMMANDS)
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
