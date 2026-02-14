import 'dotenv/config'
import { Bot, InlineKeyboard } from 'grammy'
import {
  deleteAlert,
  insertAlert,
  listAlerts,
  listAllAlerts,
  touchAlertNotified,
} from './storage.js'
import type { AlertRule, SurfForecast, WindRange } from './types.js'
import { degreesToCardinal, nextId, primaryPeriod, totalWaveHeight } from './utils.js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const API_URL = process.env.BACKEND_API_URL ?? 'https://waves-db-backend.vercel.app'
const CHECK_INTERVAL_MIN = Number(process.env.CHECK_INTERVAL_MIN ?? 30)
const DEFAULT_SPOT = 'sopela'

type Step = 'wave' | 'energy' | 'period' | 'wind' | 'confirm'

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

interface DraftAlert {
  step: Step
  spot: string
  waveSelected: string[]
  periodSelected: string[]
  energySelected?: string
  windSelected: string[]
  pendingAlert?: AlertRule
}

const drafts = new Map<number, DraftAlert>()

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN')

const bot = new Bot(BOT_TOKEN)

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360
}

function isInRange(current: number, min: number, max: number): boolean {
  return current >= min && current <= max
}

function isWindInRange(current: number, min: number, max: number): boolean {
  if (min <= max) return current >= min && current <= max
  return current >= min || current <= max
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
    `🧾 Resumen de alerta (${a.spot})`,
    `• Olas: ${a.waveLabels?.join(', ') ?? `${a.waveMin}-${a.waveMax}m`}`,
    `• Energía: ${a.energyLabel ?? `${a.energyMin}-${a.energyMax}`}`,
    `• Periodo: ${a.periodLabels?.join(', ') ?? `${a.periodMin}-${a.periodMax}s`}`,
    `• Viento: ${a.windLabels?.join(', ') ?? 'ANY'}`,
    `• Cooldown: ${a.cooldownMin} min`,
  ].join('\n')
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
    lastNotifiedAt: undefined,
    createdAt: new Date().toISOString(),
    waveRanges,
    periodRanges,
    waveLabels: [...d.waveSelected],
    periodLabels: [...d.periodSelected],
    energyLabel: energyOpt.label,
  } as AlertRule
}

function matches(alert: AlertRule, f: SurfForecast): boolean {
  const wave = totalWaveHeight(f)
  const period = primaryPeriod(f)
  const energy = f.energy
  const windAngle = normalizeAngle(f.wind.angle)

  const inWave =
    !alert.waveRanges?.length ||
    alert.waveRanges.some((r) => isInRange(wave, r.min, r.max))
  const inPeriod =
    !alert.periodRanges?.length ||
    alert.periodRanges.some((r) => isInRange(period, r.min, r.max))
  const inEnergy = energy >= alert.energyMin && energy <= alert.energyMax
  const inWind =
    !alert.windRanges?.length ||
    alert.windRanges.some((r) => isWindInRange(windAngle, r.min, r.max))

  return inWave && inPeriod && inEnergy && inWind
}

function cooldownOk(alert: AlertRule): boolean {
  if (!alert.lastNotifiedAt) return true
  const last = new Date(alert.lastNotifiedAt).getTime()
  return Date.now() - last >= alert.cooldownMin * 60_000
}

async function fetchForecast(spot: string): Promise<SurfForecast | null> {
  const url = `${API_URL}/surf-forecast/${encodeURIComponent(spot)}?page=1&limit=1`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = (await res.json()) as SurfForecast[]
  return data[0] ?? null
}

async function runChecks(): Promise<void> {
  for (const alert of listAllAlerts()) {
    try {
      const f = await fetchForecast(alert.spot)
      if (!f || !matches(alert, f) || !cooldownOk(alert)) continue

      await bot.api.sendMessage(
        alert.chatId,
        `🌊 ALERTA ${alert.spot}\nOla: ${totalWaveHeight(f).toFixed(2)}m\nPeriodo: ${primaryPeriod(f).toFixed(1)}s\nEnergía: ${f.energy.toFixed(0)}\nViento: ${degreesToCardinal(f.wind.angle)} (${f.wind.angle.toFixed(0)}°)`,
      )
      touchAlertNotified(alert.id, new Date().toISOString())
    } catch {
      // noop
    }
  }
}

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Bot listo.\n\nComandos:\n/setalert (guiado con botones)\n/listalerts\n/deletealert <id>\n/cancel',
  )
})

bot.command('setalert', async (ctx) => {
  drafts.set(ctx.chat.id, {
    step: 'wave',
    spot: DEFAULT_SPOT,
    waveSelected: [],
    periodSelected: [],
    windSelected: [],
  })

  await ctx.reply(`Spot fijo: ${DEFAULT_SPOT}`)
  await ctx.reply('Elige una o varias alturas:', {
    reply_markup: keyboardFromOptions('wave', WAVE_OPTIONS, []),
  })
})

bot.command('cancel', async (ctx) => {
  drafts.delete(ctx.chat.id)
  await ctx.reply('❌ Creación cancelada.')
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
      await ctx.reply('Elige nivel de energía:', {
        reply_markup: keyboardFromOptions('energy', ENERGY_OPTIONS, []),
      })
      return
    }

    d.waveSelected = toggle(d.waveSelected, value)
    await ctx.answerCallbackQuery({
      text: `Alturas: ${d.waveSelected.join(', ') || 'ninguna'}`,
    })
    await ctx.editMessageReplyMarkup({
      reply_markup: keyboardFromOptions('wave', WAVE_OPTIONS, d.waveSelected),
    })
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
      await ctx.reply('Elige uno o varios rangos de periodo:', {
        reply_markup: keyboardFromOptions('period', PERIOD_OPTIONS, d.periodSelected),
      })
      return
    }

    d.energySelected = value
    await ctx.answerCallbackQuery({ text: `Energía: ${value}` })
    await ctx.editMessageReplyMarkup({
      reply_markup: keyboardFromOptions('energy', ENERGY_OPTIONS, [value]),
    })
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
      await ctx.reply('Elige una o varias direcciones de viento:', {
        reply_markup: windKeyboard(d.windSelected),
      })
      return
    }

    d.periodSelected = toggle(d.periodSelected, value)
    await ctx.answerCallbackQuery({
      text: `Periodos: ${d.periodSelected.join(', ') || 'ninguno'}`,
    })
    await ctx.editMessageReplyMarkup({
      reply_markup: keyboardFromOptions('period', PERIOD_OPTIONS, d.periodSelected),
    })
    return
  }

  if (prefix === 'wind') {
    if (value === 'ANY') {
      d.windSelected = []
      const final = draftToAlert(chatId, d)
      if (!final) {
        await ctx.answerCallbackQuery({ text: 'Faltan datos' })
        return
      }

      d.step = 'confirm'
      d.pendingAlert = final
      await ctx.answerCallbackQuery({ text: 'Revisa y confirma' })
      await ctx.reply(alertSummaryText(final), { reply_markup: confirmKeyboard() })
      return
    }

    if (value === 'DONE') {
      const final = draftToAlert(chatId, d)
      if (!final) {
        await ctx.answerCallbackQuery({ text: 'Faltan datos' })
        return
      }

      d.step = 'confirm'
      d.pendingAlert = final
      await ctx.answerCallbackQuery({ text: 'Revisa y confirma' })
      await ctx.reply(alertSummaryText(final), { reply_markup: confirmKeyboard() })
      return
    }

    if (!windSector(value)) {
      await ctx.answerCallbackQuery({ text: 'Dirección inválida' })
      return
    }

    d.windSelected = toggle(d.windSelected, value)
    await ctx.answerCallbackQuery({ text: `Viento: ${d.windSelected.join(', ') || 'ANY'}` })
    await ctx.editMessageReplyMarkup({ reply_markup: windKeyboard(d.windSelected) })
    return
  }

  if (prefix === 'confirm') {
    if (value === 'CANCEL') {
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
      drafts.delete(chatId)
      await ctx.answerCallbackQuery({ text: 'Alerta creada' })
      await ctx.reply(`✅ Alerta creada: ${d.pendingAlert.id}`)
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

    return [
      `#${idx + 1} · ${a.id}`,
      `Spot: ${a.spot}`,
      `Olas: ${wave}`,
      `Energía: ${energy}`,
      `Periodo: ${period}`,
      `Viento: ${wind}`,
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

bot.start()
setInterval(() => void runChecks(), CHECK_INTERVAL_MIN * 60_000)
void runChecks()

console.log(`waves-alerts-bot running. interval=${CHECK_INTERVAL_MIN}m`)
