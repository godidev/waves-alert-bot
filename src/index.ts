import 'dotenv/config'
import { Bot, InlineKeyboard } from 'grammy'
import {
  deleteAlert,
  insertAlert,
  listAlerts,
  listAllAlerts,
  touchAlertNotified,
} from './storage.js'
import type { AlertRule, SurfForecast } from './types.js'
import { degreesToCardinal, nextId, primaryPeriod, totalWaveHeight } from './utils.js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const API_URL = process.env.BACKEND_API_URL ?? 'https://waves-db-backend.vercel.app'
const CHECK_INTERVAL_MIN = Number(process.env.CHECK_INTERVAL_MIN ?? 30)
const DEFAULT_SPOT = 'sopela'

type Step =
  | 'waveMin'
  | 'waveMax'
  | 'energyMin'
  | 'energyMax'
  | 'periodMin'
  | 'periodMax'
  | 'wind'

interface DraftAlert {
  step: Step
  spot: string
  waveMin?: number
  waveMax?: number
  energyMin?: number
  energyMax?: number
  periodMin?: number
  periodMax?: number
  windSelected: string[]
}

const drafts = new Map<number, DraftAlert>()

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN')

const bot = new Bot(BOT_TOKEN)

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360
}

function isWindInRange(current: number, min: number, max: number): boolean {
  if (min <= max) return current >= min && current <= max
  return current >= min || current <= max
}

async function fetchForecast(spot: string): Promise<SurfForecast | null> {
  const url = `${API_URL}/surf-forecast/${encodeURIComponent(spot)}?page=1&limit=1`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = (await res.json()) as SurfForecast[]
  return data[0] ?? null
}

function matches(alert: AlertRule, f: SurfForecast): boolean {
  const wave = totalWaveHeight(f)
  const period = primaryPeriod(f)
  const windAngle = normalizeAngle(f.wind.angle)
  const energy = f.energy

  const inWave = wave >= alert.waveMin && wave <= alert.waveMax
  const inEnergy = energy >= alert.energyMin && energy <= alert.energyMax
  const inPeriod = period >= alert.periodMin && period <= alert.periodMax
  const inWind =
    !alert.windRanges?.length ||
    alert.windRanges.some((r) => isWindInRange(windAngle, r.min, r.max))

  return inWave && inEnergy && inPeriod && inWind
}

function cooldownOk(alert: AlertRule): boolean {
  if (!alert.lastNotifiedAt) return true
  const last = new Date(alert.lastNotifiedAt).getTime()
  const minGap = alert.cooldownMin * 60_000
  return Date.now() - last >= minGap
}

async function runChecks(): Promise<void> {
  const alerts = listAllAlerts()

  for (const alert of alerts) {
    try {
      const f = await fetchForecast(alert.spot)
      if (!f) continue
      if (!matches(alert, f)) continue
      if (!cooldownOk(alert)) continue

      const wave = totalWaveHeight(f).toFixed(2)
      const period = primaryPeriod(f).toFixed(1)
      const wind = `${degreesToCardinal(f.wind.angle)} (${f.wind.angle.toFixed(0)}°)`

      await bot.api.sendMessage(
        alert.chatId,
        `🌊 ALERTA ${alert.spot}\nOla: ${wave}m\nPeriodo: ${period}s\nEnergía: ${f.energy.toFixed(0)}\nViento: ${wind}`,
      )

      touchAlertNotified(alert.id, new Date().toISOString())
    } catch {
      // noop
    }
  }
}

function parseNumber(text: string): number | null {
  const value = Number(text.replace(',', '.'))
  return Number.isFinite(value) ? value : null
}

function windKeyboard(selected: string[] = []): InlineKeyboard {
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

function draftToAlert(chatId: number, d: DraftAlert): AlertRule | null {
  if (
    d.waveMin === undefined ||
    d.waveMax === undefined ||
    d.energyMin === undefined ||
    d.energyMax === undefined ||
    d.periodMin === undefined ||
    d.periodMax === undefined
  ) {
    return null
  }

  return {
    id: nextId(),
    chatId,
    spot: d.spot,
    waveMin: d.waveMin,
    waveMax: d.waveMax,
    energyMin: d.energyMin,
    energyMax: d.energyMax,
    periodMin: d.periodMin,
    periodMax: d.periodMax,
    cooldownMin: 180,
    createdAt: new Date().toISOString(),
  }
}

async function askNext(chatId: number): Promise<string> {
  const d = drafts.get(chatId)
  if (!d) return 'No active draft.'

  switch (d.step) {
    case 'waveMin':
      return 'Altura mínima (m):'
    case 'waveMax':
      return 'Altura máxima (m):'
    case 'energyMin':
      return 'Energía mínima:'
    case 'energyMax':
      return 'Energía máxima:'
    case 'periodMin':
      return 'Periodo mínimo (s):'
    case 'periodMax':
      return 'Periodo máximo (s):'
    case 'wind':
      return 'Elige dirección de viento:'
  }
}

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Bot listo.\n\nComandos:\n/setalert (modo guiado)\n/listalerts\n/deletealert <id>\n/cancel',
  )
})

bot.command('setalert', async (ctx) => {
  drafts.set(ctx.chat.id, {
    step: 'waveMin',
    spot: DEFAULT_SPOT,
    windSelected: [],
  })

  await ctx.reply(`Vamos a crear la alerta para spot: ${DEFAULT_SPOT}`)
  await ctx.reply('Altura mínima (m):')
})

bot.command('cancel', async (ctx) => {
  drafts.delete(ctx.chat.id)
  await ctx.reply('❌ Creación de alerta cancelada.')
})

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data
  if (!data.startsWith('wind:')) return

  const chatId = ctx.chat?.id
  if (!chatId) return

  const d = drafts.get(chatId)
  if (!d || d.step !== 'wind') {
    await ctx.answerCallbackQuery({ text: 'No hay alerta en creación.' })
    return
  }

  const value = data.replace('wind:', '')

  if (value === 'ANY') {
    const alertBase = draftToAlert(chatId, d)
    if (!alertBase) {
      await ctx.answerCallbackQuery({ text: 'Faltan datos previos.' })
      return
    }

    insertAlert(alertBase)
    drafts.delete(chatId)
    await ctx.answerCallbackQuery({ text: 'Alerta creada sin filtro de viento' })
    await ctx.reply(`✅ Alerta creada: ${alertBase.id}`)
    return
  }

  if (value === 'DONE') {
    const alertBase = draftToAlert(chatId, d)
    if (!alertBase) {
      await ctx.answerCallbackQuery({ text: 'Faltan datos previos.' })
      return
    }

    if (!d.windSelected.length) {
      await ctx.answerCallbackQuery({ text: 'Elige al menos una dirección o ANY' })
      return
    }

    const ranges = d.windSelected
      .map((dir) => windSector(dir))
      .filter((r): r is [number, number] => Boolean(r))
      .map(([min, max]) => ({ min, max }))

    const finalAlert: AlertRule = {
      ...alertBase,
      windRanges: ranges,
      windLabels: [...d.windSelected],
    }

    insertAlert(finalAlert)
    drafts.delete(chatId)
    await ctx.answerCallbackQuery({ text: 'Alerta creada' })
    await ctx.reply(`✅ Alerta creada: ${finalAlert.id}`)
    return
  }

  if (!windSector(value)) {
    await ctx.answerCallbackQuery({ text: 'Dirección inválida' })
    return
  }

  d.windSelected = d.windSelected.includes(value)
    ? d.windSelected.filter((x) => x !== value)
    : [...d.windSelected, value]

  await ctx.answerCallbackQuery({
    text: `Seleccionadas: ${d.windSelected.join(', ') || 'ninguna'}`,
  })
  await ctx.editMessageReplyMarkup({ reply_markup: windKeyboard(d.windSelected) })
})

bot.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim()
  if (text.startsWith('/')) {
    await next()
    return
  }

  const chatId = ctx.chat?.id
  if (!chatId) {
    await next()
    return
  }

  const d = drafts.get(chatId)
  if (!d) {
    await next()
    return
  }

  const value = parseNumber(text)
  if (value === null) {
    await ctx.reply('Pon un número válido (ej: 1.2)')
    return
  }

  switch (d.step) {
    case 'waveMin':
      d.waveMin = value
      d.step = 'waveMax'
      await ctx.reply(await askNext(chatId))
      return
    case 'waveMax':
      if (d.waveMin !== undefined && value < d.waveMin) {
        await ctx.reply('Debe ser >= altura mínima')
        return
      }
      d.waveMax = value
      d.step = 'energyMin'
      await ctx.reply(await askNext(chatId))
      return
    case 'energyMin':
      d.energyMin = value
      d.step = 'energyMax'
      await ctx.reply(await askNext(chatId))
      return
    case 'energyMax':
      if (d.energyMin !== undefined && value < d.energyMin) {
        await ctx.reply('Debe ser >= energía mínima')
        return
      }
      d.energyMax = value
      d.step = 'periodMin'
      await ctx.reply(await askNext(chatId))
      return
    case 'periodMin':
      d.periodMin = value
      d.step = 'periodMax'
      await ctx.reply(await askNext(chatId))
      return
    case 'periodMax':
      if (d.periodMin !== undefined && value < d.periodMin) {
        await ctx.reply('Debe ser >= periodo mínimo')
        return
      }
      d.periodMax = value
      d.step = 'wind'
      d.windSelected = []
      await ctx.reply(await askNext(chatId), {
        reply_markup: windKeyboard(d.windSelected),
      })
      return
    case 'wind':
      await ctx.reply('Pulsa una opción de viento en los botones.')
      return
  }
})

bot.command('listalerts', async (ctx) => {
  const alerts = listAlerts(ctx.chat.id)
  if (!alerts.length) {
    await ctx.reply('No tienes alertas.')
    return
  }

  const lines = alerts.map(
    (a) =>
      `• ${a.id} | ${a.spot} | ola ${a.waveMin}-${a.waveMax}m | energía ${a.energyMin}-${a.energyMax} | periodo ${a.periodMin}-${a.periodMax}s | viento ${a.windLabels?.length ? a.windLabels.join(',') : 'ANY'} | cooldown ${a.cooldownMin}m`,
  )

  await ctx.reply(lines.join('\n'))
})

bot.command('deletealert', async (ctx) => {
  const id = (ctx.message?.text ?? '').split(' ')[1]?.trim()
  if (!id) {
    await ctx.reply('Uso: /deletealert <id>')
    return
  }

  const ok = deleteAlert(ctx.chat.id, id)
  await ctx.reply(ok ? '🗑️ Alerta borrada' : 'No encontré esa alerta')
})

bot.start()

setInterval(() => {
  void runChecks()
}, CHECK_INTERVAL_MIN * 60_000)

void runChecks()

console.log(`waves-alerts-bot running. interval=${CHECK_INTERVAL_MIN}m`)