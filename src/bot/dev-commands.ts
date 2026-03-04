import type { Bot } from 'grammy'
import { buildAlertMessage } from '../core/alert-engine.js'
import type { AlertWindow } from '../core/check-runner.js'
import type { AlertRule, SurfForecast } from '../core/types.js'
import { listAllAlerts } from '../infra/storage.js'
import { readLog } from '../infra/check-logger.js'
import { allAlertsAdminText } from './alert-text.js'

function fmtDateMadrid(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function registerDevCommands(
  bot: Bot,
  deps: {
    isDevChat: (chatId: number) => boolean
    startedAt: number
    runChecks: () => Promise<void>
    lastSentWindows: Map<string, AlertWindow>
  },
): void {
  bot.command('status', async (ctx) => {
    if (!deps.isDevChat(ctx.chat.id)) return

    const allAlerts = await listAllAlerts()
    const spots = [...new Set(allAlerts.map((a) => a.spot))]
    const log = await readLog()
    const last = log.at(-1)
    const uptimeMs = Date.now() - deps.startedAt
    const uptimeH = Math.floor(uptimeMs / 3_600_000)
    const uptimeM = Math.floor((uptimeMs % 3_600_000) / 60_000)

    const durations = log.map((e) => e.durationMs).sort((a, b) => a - b)
    const percentile = (arr: number[], p: number) =>
      arr.length ? arr[Math.min(Math.floor(arr.length * p), arr.length - 1)] : 0
    const p50 = percentile(durations, 0.5)
    const p95 = percentile(durations, 0.95)

    const okChecks = log.filter((e) => e.errors === 0).length
    const errChecks = log.filter((e) => e.errors > 0).length
    const spotsLine = spots.length ? spots.join(', ') : 'ninguno'

    const header = [
      '--- Bot Status ---',
      `Uptime: ${uptimeH}h ${uptimeM}m | Checks: ${log.length} (ok:${okChecks} err:${errChecks}) | Lat p50: ${p50}ms p95: ${p95}ms`,
      `Alertas activas: ${allAlerts.length} (${spotsLine}) | Cooldowns activos: ${deps.lastSentWindows.size}`,
    ]

    if (!last) {
      await ctx.reply([...header, '', 'Sin datos de checks.'].join('\n'))
      return
    }

    const d = last.discardReasons
    const lastLines = [
      '',
      `Último check: ${fmtDateMadrid(last.timestamp)} — ${last.durationMs}ms`,
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
    if (!deps.isDevChat(ctx.chat.id)) return

    const log = await readLog()
    if (!log.length) {
      await ctx.reply('Check log vacío.')
      return
    }

    const recent = log.slice(-10)
    const lines = recent.map((e) => {
      return `${fmtDateMadrid(e.timestamp)} | ${e.durationMs}ms | alertas=${e.totalAlerts} matched=${e.matched} enviadas=${e.notified}`
    })

    await ctx.reply(
      `--- Últimos ${recent.length} checks ---\n\n${lines.join('\n')}`,
    )
  })

  bot.command('runnow', async (ctx) => {
    if (!deps.isDevChat(ctx.chat.id)) return

    await ctx.reply('Ejecutando check run...')
    try {
      await deps.runChecks()
      const last = (await readLog()).at(-1)
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
    if (!deps.isDevChat(ctx.chat.id)) return

    const alert: AlertRule = {
      id: 'preview-alert',
      chatId: ctx.chat.id,
      name: 'Preview Sopelana',
      spotId: 'preview-sopelana-id',
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
        low: {
          date: '2026-02-19',
          hora: '14:44',
          altura: 0.37,
          tipo: 'bajamar',
        },
      },
      windowForecasts: rows,
    })

    await ctx.reply('Preview de notificacion (datos inventados):')
    await ctx.reply(message, { parse_mode: 'HTML' })
  })

  bot.command('alerts_all', async (ctx) => {
    if (!deps.isDevChat(ctx.chat.id)) return

    const allAlerts = await listAllAlerts()
    if (!allAlerts.length) {
      await ctx.reply('No hay alertas registradas.')
      return
    }

    const msg = allAlertsAdminText(allAlerts)
    if (msg.length <= 4096) {
      await ctx.reply(msg)
      return
    }

    for (let i = 0; i < msg.length; i += 4096) {
      await ctx.reply(msg.slice(i, i + 4096))
    }
  })
}

export function registerDevCommandMenu(
  bot: Bot,
  devChatId: number,
  baseCommands: { command: string; description: string }[],
): void {
  void bot.api
    .setMyCommands(
      [
        ...baseCommands,
        { command: 'status', description: 'Estado del bot' },
        { command: 'checklog', description: 'Últimos check runs' },
        { command: 'runnow', description: 'Forzar check run' },
        { command: 'previewalert', description: 'Preview de alerta (demo)' },
        { command: 'alerts_all', description: 'Todas las alertas (admin)' },
      ],
      { scope: { type: 'chat', chat_id: devChatId } },
    )
    .catch(() => {
      // noop
    })
}
