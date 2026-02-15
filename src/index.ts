import 'dotenv/config'
import { Bot } from 'grammy'
import {
  deleteAlert,
  insertAlert,
  listAlerts,
  listAllAlerts,
  touchAlertNotified,
} from './storage.js'
import { runChecksWithDeps, type AlertWindow } from './check-runner.js'
import { startHourlySchedulerAtMinute } from './scheduler.js'
import { buildCleanupDeleteList } from './flow-cleanup.js'
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
} from './bot-options.js'
import {
  confirmKeyboard,
  keyboardFromOptions,
  safeEditReplyMarkup,
  tidePortKeyboard,
  tidePreferenceKeyboard,
  windKeyboard,
} from './bot-ui.js'
import {
  alertSummaryText,
  apiDateFromForecastDate,
  draftToAlert,
  fetchForecasts,
  getTideEventsForDate,
  isWithinAlertWindow,
  tideTag,
  toggle,
  windSector,
} from './bot-helpers.js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const API_URL =
  process.env.BACKEND_API_URL ?? 'https://waves-db-backend.vercel.app'
const MIN_CONSECUTIVE_HOURS = Number(process.env.MIN_CONSECUTIVE_HOURS ?? 2)

const drafts = new Map<number, DraftAlert>()
const lastSentWindows = new Map<string, AlertWindow>()

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN')

const bot = new Bot(BOT_TOKEN)

bot.catch((err) => {
  console.error('bot_error', err.error)
})

async function runChecks(): Promise<void> {
  await runChecksWithDeps({
    alerts: listAllAlerts(),
    minConsecutiveHours: MIN_CONSECUTIVE_HOURS,
    fetchForecasts: (spot) => fetchForecasts(API_URL, spot),
    isWithinAlertWindow,
    getTideEventsForDate,
    apiDateFromForecastDate,
    sendMessage: (chatId, message) =>
      bot.api.sendMessage(chatId, message).then(() => undefined),
    touchAlertNotified,
    getLastWindow: (key) => lastSentWindows.get(key),
    setLastWindow: (key, window) => {
      lastSentWindows.set(key, window)
    },
  })
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
        await ctx.answerCallbackQuery({
          text: 'Selecciona al menos una altura',
        })
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
    await safeEditReplyMarkup(
      ctx,
      keyboardFromOptions('wave', WAVE_OPTIONS, d.waveSelected),
    )
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
        reply_markup: keyboardFromOptions(
          'period',
          PERIOD_OPTIONS,
          d.periodSelected,
        ),
      })
      return
    }

    d.energySelected = value
    await ctx.answerCallbackQuery({ text: `Energía: ${value}` })
    await safeEditReplyMarkup(
      ctx,
      keyboardFromOptions('energy', ENERGY_OPTIONS, [value]),
    )
    return
  }

  if (prefix === 'period') {
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
        reply_markup: windKeyboard(d.windSelected),
      })
      return
    }

    d.periodSelected = toggle(d.periodSelected, value)
    await ctx.answerCallbackQuery({
      text: `Periodos: ${d.periodSelected.join(', ') || 'ninguno'}`,
    })
    await safeEditReplyMarkup(
      ctx,
      keyboardFromOptions('period', PERIOD_OPTIONS, d.periodSelected),
    )
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
    await ctx.answerCallbackQuery({
      text: `Viento: ${d.windSelected.join(', ') || 'ANY'}`,
    })
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
    await ctx.answerCallbackQuery({
      text: `Puerto: ${TIDE_PORT_OPTIONS.find((p) => p.id === value)?.label}`,
    })
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
    await flowReply(ctx, d, alertSummaryText(final), {
      reply_markup: confirmKeyboard(),
    })
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
    const period =
      a.periodLabels?.join(', ') ?? `${a.periodMin}-${a.periodMax}s`
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
  await ctx.reply(
    deleteAlert(ctx.chat.id, id)
      ? '🗑️ Alerta borrada'
      : 'No encontré esa alerta',
  )
})

void bot.api.setMyCommands(BOT_COMMANDS).catch(() => {
  // noop
})

bot.start()
startHourlySchedulerAtMinute(() => runChecks(), 10)
void runChecks()

console.log('waves-alerts-bot running. scheduler=:10 Europe/Madrid')
