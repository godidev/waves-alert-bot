import 'dotenv/config'
import { Bot } from 'grammy'
import { deleteAlert, insertAlert, listAlerts, listAllAlerts, touchAlertNotified } from './storage.js'
import type { AlertRule, SurfForecast } from './types.js'
import { degreesToCardinal, nextId, primaryPeriod, totalWaveHeight } from './utils.js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const API_URL = process.env.BACKEND_API_URL ?? 'https://waves-db-backend.vercel.app'
const CHECK_INTERVAL_MIN = Number(process.env.CHECK_INTERVAL_MIN ?? 30)

if (!BOT_TOKEN) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN')
}

const bot = new Bot(BOT_TOKEN)

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360
}

function parseRange(value: string): [number, number] | null {
  const [a, b] = value.split('-').map(Number)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return [a, b]
}

function parseWindRange(value: string): [number, number] | null {
  const range = parseRange(value)
  if (!range) return null
  return [normalizeAngle(range[0]), normalizeAngle(range[1])]
}

function parseSetAlert(text: string, chatId: number): AlertRule | null {
  const chunks = text.replace('/setalert', '').trim().split(/\s+/).filter(Boolean)
  const kv = new Map<string, string>()

  for (const chunk of chunks) {
    const [k, ...rest] = chunk.split('=')
    if (!k || rest.length === 0) continue
    kv.set(k.toLowerCase(), rest.join('='))
  }

  const spot = kv.get('spot')
  const wave = kv.get('wave')
  const period = kv.get('period')
  const wind = kv.get('wind')
  const cooldown = Number(kv.get('cooldown') ?? 180)

  if (!spot || !wave || !period) return null

  const waveRange = parseRange(wave)
  const periodRange = parseRange(period)
  const windRange = wind ? parseWindRange(wind) : null
  if (!waveRange || !periodRange || !Number.isFinite(cooldown)) return null
  if (wind && !windRange) return null

  return {
    id: nextId(),
    chatId,
    spot,
    waveMin: waveRange[0],
    waveMax: waveRange[1],
    periodMin: periodRange[0],
    periodMax: periodRange[1],
    ...(windRange
      ? {
          windMin: windRange[0],
          windMax: windRange[1],
        }
      : {}),
    cooldownMin: cooldown,
    createdAt: new Date().toISOString(),
  }
}

async function fetchForecast(spot: string): Promise<SurfForecast | null> {
  const url = `${API_URL}/surf-forecast/${encodeURIComponent(spot)}?page=1&limit=1`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = (await res.json()) as SurfForecast[]
  return data[0] ?? null
}

function isWindInRange(
  current: number,
  min?: number,
  max?: number,
): boolean {
  if (min === undefined || max === undefined) return true
  if (min <= max) return current >= min && current <= max
  return current >= min || current <= max
}

function matches(alert: AlertRule, f: SurfForecast): boolean {
  const wave = totalWaveHeight(f)
  const period = primaryPeriod(f)
  const windAngle = normalizeAngle(f.wind.angle)

  const inWave = wave >= alert.waveMin && wave <= alert.waveMax
  const inPeriod = period >= alert.periodMin && period <= alert.periodMax
  const inWind = isWindInRange(windAngle, alert.windMin, alert.windMax)

  return inWave && inPeriod && inWind
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
        `🌊 ALERTA ${alert.spot}\nOla: ${wave}m\nPeriodo: ${period}s\nViento: ${wind}`,
      )

      touchAlertNotified(alert.id, new Date().toISOString())
    } catch {
      // noop, continue
    }
  }
}

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Bot de alertas listo.\n\nUsa:\n/setalert spot=sopelana wave=0.8-1.6 period=8-14 wind=240-300 cooldown=180\n/listalerts\n/deletealert <id>',
  )
})

bot.command('setalert', async (ctx) => {
  const parsed = parseSetAlert(ctx.message?.text ?? '', ctx.chat.id)
  if (!parsed) {
    await ctx.reply(
      'Formato:\n/setalert spot=sopelana wave=0.8-1.6 period=8-14 wind=240-300 cooldown=180',
    )
    return
  }

  insertAlert(parsed)
  await ctx.reply(`✅ Alerta creada: ${parsed.id}`)
})

bot.command('listalerts', async (ctx) => {
  const alerts = listAlerts(ctx.chat.id)
  if (!alerts.length) {
    await ctx.reply('No tienes alertas.')
    return
  }

  const lines = alerts.map(
    (a) =>
      `• ${a.id} | ${a.spot} | ola ${a.waveMin}-${a.waveMax}m | periodo ${a.periodMin}-${a.periodMax}s | viento ${a.windMin !== undefined && a.windMax !== undefined ? `${a.windMin}-${a.windMax}°` : 'ANY'} | cooldown ${a.cooldownMin}m`,
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