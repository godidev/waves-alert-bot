import test from 'node:test'
import assert from 'node:assert/strict'
import { runChecksWithDeps, shouldSendWindow } from '../src/check-runner.js'
import type { AlertRule, SurfForecast } from '../src/types.js'
import type { TideEvent } from '../src/alert-engine.js'

function mkAlert(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'alert-1',
    chatId: 123,
    name: 'Integración',
    spot: 'sopelana',
    waveMin: 0,
    waveMax: 10,
    energyMin: 800,
    energyMax: 2000,
    periodMin: 9,
    periodMax: 14,
    waveRanges: [{ min: 1.2, max: 2.2 }],
    periodRanges: [{ min: 10, max: 13 }],
    windRanges: [{ min: 22.5, max: 67.5 }],
    cooldownMin: 180,
    tidePortId: '72',
    tidePortName: 'Bermeo',
    tidePreference: 'any',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function mkForecast(date: string, energy = 1200): SurfForecast {
  return {
    date,
    spot: 'sopelana',
    energy,
    wind: { speed: 12, angle: 45 },
    validSwells: [{ angle: 300, height: 1.6, period: 11 }],
  }
}

function mkTides(day = '2026-02-16'): TideEvent[] {
  return [
    { date: day, hora: '07:00', altura: 0.8, tipo: 'bajamar' },
    { date: day, hora: '12:30', altura: 3.1, tipo: 'pleamar' },
    { date: day, hora: '19:10', altura: 0.7, tipo: 'bajamar' },
  ]
}

test('dedupe: no envía si ventana igual', () => {
  assert.equal(
    shouldSendWindow(
      { startMs: 1000, endMs: 4000 },
      { startMs: 1000, endMs: 4000 },
    ),
    false,
  )
})

test('dedupe: no envía si ventana contenida', () => {
  assert.equal(
    shouldSendWindow(
      { startMs: 1000, endMs: 5000 },
      { startMs: 2000, endMs: 4000 },
    ),
    false,
  )
})

test('dedupe: envía si amplía por detrás', () => {
  assert.equal(
    shouldSendWindow(
      { startMs: 1000, endMs: 5000 },
      { startMs: 1000, endMs: 7000 },
    ),
    true,
  )
})

test('dedupe: envía si ventana desplazada', () => {
  assert.equal(
    shouldSendWindow(
      { startMs: 1000, endMs: 5000 },
      { startMs: 6000, endMs: 9000 },
    ),
    true,
  )
})

test('runChecksWithDeps envía mensaje cuando hay ventana consecutiva válida', async () => {
  const sent: string[] = []
  const touched: string[] = []

  await runChecksWithDeps({
    alerts: [mkAlert()],
    minConsecutiveHours: 2,
    fetchForecasts: async () => [
      mkForecast('2026-02-16T09:00:00.000Z'),
      mkForecast('2026-02-16T10:00:00.000Z'),
    ],
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => mkTides(),
    apiDateFromForecastDate: () => '20260216',
    sendMessage: async (_chatId, message) => {
      sent.push(message)
    },
    touchAlertNotified: (id) => touched.push(id),
    nowMs: () => new Date('2026-02-16T08:00:00.000Z').getTime(),
  })

  assert.equal(sent.length, 1)
  assert.equal(touched.length, 1)
  assert.match(sent[0], /📅 Fecha:/)
  assert.match(sent[0], /Bajamar más cercana/)
})

test('runChecksWithDeps no envía si no se cumple consecutividad mínima', async () => {
  let sent = 0

  await runChecksWithDeps({
    alerts: [mkAlert()],
    minConsecutiveHours: 2,
    fetchForecasts: async () => [
      mkForecast('2026-02-16T09:00:00.000Z'),
      mkForecast('2026-02-16T11:00:00.000Z'),
    ],
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => mkTides(),
    apiDateFromForecastDate: () => '20260216',
    sendMessage: async () => {
      sent++
    },
    touchAlertNotified: () => undefined,
  })

  assert.equal(sent, 0)
})

test('runChecksWithDeps marea alta: filtra fuera de ventana ±3h de pleamar', async () => {
  let sent = 0

  await runChecksWithDeps({
    alerts: [mkAlert({ tidePreference: 'high' })],
    minConsecutiveHours: 1,
    fetchForecasts: async () => [mkForecast('2026-02-16T18:00:00.000Z')],
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => mkTides(),
    apiDateFromForecastDate: () => '20260216',
    sendMessage: async () => {
      sent++
    },
    touchAlertNotified: () => undefined,
  })

  // Pleamar 12:30 -> ventana válida 09:30..15:30, por tanto 18:00 no entra.
  assert.equal(sent, 0)
})

test('runChecksWithDeps marea alta interpreta horas de marea en Europe/Madrid', async () => {
  let sent = 0

  await runChecksWithDeps({
    alerts: [mkAlert({ tidePreference: 'high' })],
    minConsecutiveHours: 1,
    fetchForecasts: async () => [mkForecast('2026-01-15T15:00:00.000Z')],
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => [
      { date: '2026-01-15', hora: '06:00', altura: 0.8, tipo: 'bajamar' },
      { date: '2026-01-15', hora: '12:00', altura: 3.1, tipo: 'pleamar' },
    ],
    apiDateFromForecastDate: () => '20260115',
    sendMessage: async () => {
      sent++
    },
    touchAlertNotified: () => undefined,
  })

  // 12:00 Europe/Madrid en enero = 11:00Z -> ventana 08:00..14:00Z.
  // El forecast 15:00Z queda fuera.
  assert.equal(sent, 0)
})
