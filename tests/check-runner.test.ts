import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runChecksWithDeps,
  shouldSendWindow,
} from '../src/core/check-runner.js'
import type { AlertRule, SurfForecast } from '../src/core/types.js'
import type { TideEvent } from '../src/core/alert-engine.js'

function mkAlert(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'alert-1',
    chatId: 123,
    name: 'Integración',
    spotId: 'spot-sopelana-id',
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
    touchAlertNotified: async (id) => {
      touched.push(id)
    },
    nowMs: () => new Date('2026-02-16T08:00:00.000Z').getTime(),
  })

  assert.equal(sent.length, 1)
  assert.equal(touched.length, 1)
  assert.match(sent[0], /📍 sopelana/)
  assert.match(sent[0], /📅 .*/)
  assert.match(sent[0], /⏰ 10:00-12:00/)
  assert.match(sent[0], /Marea baja/)
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
    touchAlertNotified: async () => undefined,
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
    touchAlertNotified: async () => undefined,
  })

  // Pleamar 12:30 -> ventana válida 09:30..15:30, por tanto 18:00 no entra.
  assert.equal(sent, 0)
})

test('runChecksWithDeps marea alta interpreta horas de marea en UTC', async () => {
  let sent = 0

  await runChecksWithDeps({
    alerts: [mkAlert({ tidePreference: 'high' })],
    minConsecutiveHours: 1,
    fetchForecasts: async () => [mkForecast('2026-01-15T16:00:00.000Z')],
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => [
      { date: '2026-01-15', hora: '06:00', altura: 0.8, tipo: 'bajamar' },
      { date: '2026-01-15', hora: '12:00', altura: 3.1, tipo: 'pleamar' },
    ],
    apiDateFromForecastDate: () => '20260115',
    sendMessage: async () => {
      sent++
    },
    touchAlertNotified: async () => undefined,
  })

  // 12:00 (API UTC) -> ventana 09:00..15:00Z.
  // El forecast 16:00Z queda fuera.
  assert.equal(sent, 0)
})

test('runChecksWithDeps marea alta usa ventana ±3h sin exigir clase alta', async () => {
  let sent = 0

  await runChecksWithDeps({
    alerts: [mkAlert({ tidePreference: 'high' })],
    minConsecutiveHours: 1,
    fetchForecasts: async () => [mkForecast('2026-02-16T15:00:00.000Z')],
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => mkTides(),
    apiDateFromForecastDate: () => '20260216',
    sendMessage: async () => {
      sent++
    },
    touchAlertNotified: async () => undefined,
  })

  // Pleamar 12:30 -> ventana 09:30..15:30, por tanto 15:00 entra.
  // Aunque la clase estimada no sea "high", debe enviar por regla de ventana.
  assert.equal(sent, 1)
})

test('runChecksWithDeps marea baja: filtra fuera de ventana ±3h de bajamar', async () => {
  let sent = 0

  await runChecksWithDeps({
    alerts: [mkAlert({ tidePreference: 'low' })],
    minConsecutiveHours: 1,
    fetchForecasts: async () => [mkForecast('2026-02-16T12:00:00.000Z')],
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => mkTides(),
    apiDateFromForecastDate: () => '20260216',
    sendMessage: async () => {
      sent++
    },
    touchAlertNotified: async () => undefined,
  })

  // Bajamar más próxima 07:00 -> ventana 04:00..10:00.
  // El forecast 12:00 queda fuera.
  assert.equal(sent, 0)
})

test('runChecksWithDeps cachea forecasts por spot en cada ejecución', async () => {
  let fetchCalls = 0
  let sent = 0

  await runChecksWithDeps({
    alerts: [
      mkAlert({ id: 'alert-1', chatId: 123, spotId: 'spot-sopelana-id' }),
      mkAlert({ id: 'alert-2', chatId: 456, spotId: 'spot-sopelana-id' }),
    ],
    minConsecutiveHours: 1,
    fetchForecasts: async () => {
      fetchCalls++
      return [mkForecast('2026-02-16T09:00:00.000Z')]
    },
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => mkTides(),
    apiDateFromForecastDate: () => '20260216',
    sendMessage: async () => {
      sent++
    },
    touchAlertNotified: async () => undefined,
  })

  assert.equal(fetchCalls, 1)
  assert.equal(sent, 2)
})

test('runChecksWithDeps ignora alertas pausadas', async () => {
  let fetchCalls = 0
  let sent = 0

  await runChecksWithDeps({
    alerts: [mkAlert({ enabled: false })],
    minConsecutiveHours: 1,
    fetchForecasts: async () => {
      fetchCalls++
      return [mkForecast('2026-02-16T09:00:00.000Z')]
    },
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => mkTides(),
    apiDateFromForecastDate: () => '20260216',
    sendMessage: async () => {
      sent++
    },
    touchAlertNotified: async () => undefined,
  })

  assert.equal(fetchCalls, 0)
  assert.equal(sent, 0)
})

test('runChecksWithDeps registra match en cada rerun aunque dedupe evite envío', async () => {
  const sentWindows = new Map<string, { startMs: number; endMs: number }>()
  let sent = 0
  let matchRecords = 0
  let sentRecords = 0

  const deps = {
    alerts: [mkAlert({ id: 'alert-rerun', chatId: 123 })],
    minConsecutiveHours: 1,
    fetchForecasts: async () => [mkForecast('2026-02-16T09:00:00.000Z')],
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => mkTides(),
    apiDateFromForecastDate: () => '20260216',
    sendMessage: async () => {
      sent++
    },
    touchAlertNotified: async () => undefined,
    getLastWindow: (key: string) => sentWindows.get(key),
    setLastWindow: (
      key: string,
      window: { startMs: number; endMs: number },
    ) => {
      sentWindows.set(key, window)
    },
    recordNotificationMatch: async () => {
      matchRecords++
    },
    recordNotificationSent: async () => {
      sentRecords++
    },
  }

  await runChecksWithDeps(deps)
  await runChecksWithDeps(deps)

  assert.equal(matchRecords, 2)
  assert.equal(sentRecords, 1)
  assert.equal(sent, 1)
})

test('runChecksWithDeps incluye 4h de contexto y marca horas buenas en tabla', async () => {
  const sent: string[] = []

  await runChecksWithDeps({
    alerts: [mkAlert()],
    minConsecutiveHours: 2,
    fetchForecasts: async () => [
      mkForecast('2026-02-16T07:00:00.000Z', 500),
      mkForecast('2026-02-16T08:00:00.000Z', 500),
      mkForecast('2026-02-16T09:00:00.000Z', 1200),
      mkForecast('2026-02-16T10:00:00.000Z', 1200),
      mkForecast('2026-02-16T11:00:00.000Z', 500),
      mkForecast('2026-02-16T12:00:00.000Z', 500),
      mkForecast('2026-02-16T13:00:00.000Z', 500),
    ],
    isWithinAlertWindow: async () => true,
    getTideEventsForDate: async () => mkTides(),
    apiDateFromForecastDate: () => '20260216',
    sendMessage: async (_chatId, message) => {
      sent.push(message)
    },
    touchAlertNotified: async () => undefined,
  })

  assert.equal(sent.length, 1)
  assert.match(sent[0], /🟩\s+10:00\s+\|/)
  assert.match(sent[0], /🟩\s+11:00\s+\|/)
  assert.match(sent[0], /⬜(?:\uFE0F)?\s+08:00\s+\|/)
  assert.match(sent[0], /⬜(?:\uFE0F)?\s+14:00\s+\|/)
})
