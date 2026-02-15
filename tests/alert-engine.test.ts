import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAlertMessage,
  findNearestTides,
  firstConsecutiveWindow,
  matches,
} from '../src/alert-engine.js'
import type { AlertRule, SurfForecast } from '../src/types.js'

function mkForecast(
  date: string,
  energy = 1200,
  windAngle = 45,
  height = 1.5,
  period = 11,
): SurfForecast {
  return {
    date,
    spot: 'sopelana',
    energy,
    wind: { speed: 10, angle: windAngle },
    validSwells: [{ angle: 300, height, period }],
  }
}

function mkAlert(): AlertRule {
  return {
    id: 'a1',
    chatId: 1,
    name: 'Test alerta',
    spot: 'sopelana',
    waveMin: 0,
    waveMax: 10,
    energyMin: 800,
    energyMax: 1600,
    periodMin: 10,
    periodMax: 13,
    waveRanges: [{ min: 1.2, max: 2 }],
    periodRanges: [{ min: 10, max: 13 }],
    windRanges: [{ min: 22.5, max: 67.5 }],
    cooldownMin: 180,
    tidePortName: 'Bermeo',
    tidePreference: 'any',
    createdAt: new Date().toISOString(),
  }
}

test('matches() valida rangos de ola/periodo/energía/viento', () => {
  const alert = mkAlert()
  assert.equal(matches(alert, mkForecast('2026-02-16T10:00:00.000Z')), true)
  assert.equal(
    matches(alert, mkForecast('2026-02-16T10:00:00.000Z', 500)),
    false,
  )
  assert.equal(
    matches(alert, mkForecast('2026-02-16T10:00:00.000Z', 1200, 180)),
    false,
  )
})

test('firstConsecutiveWindow() encuentra la primera ventana consecutiva', () => {
  const items = [
    {
      forecast: mkForecast('2026-02-16T11:00:00.000Z'),
      tideClass: null,
      tideHeight: null,
    },
    {
      forecast: mkForecast('2026-02-16T09:00:00.000Z'),
      tideClass: null,
      tideHeight: null,
    },
    {
      forecast: mkForecast('2026-02-16T10:00:00.000Z'),
      tideClass: null,
      tideHeight: null,
    },
  ]

  const window = firstConsecutiveWindow(items, 2)
  assert.ok(window)
  assert.equal(window?.hours, 3)
  assert.equal(window?.start.forecast.date, '2026-02-16T09:00:00.000Z')
})

test('findNearestTides() devuelve bajamar y pleamar más cercanas', () => {
  const target = new Date('2026-02-16T10:00:00.000Z')
  const tides = [
    { date: '2026-02-16', hora: '07:00', altura: 0.8, tipo: 'bajamar' },
    { date: '2026-02-16', hora: '12:30', altura: 3.2, tipo: 'pleamar' },
    { date: '2026-02-16', hora: '19:00', altura: 0.6, tipo: 'bajamar' },
  ]

  const nearest = findNearestTides(target, tides)
  assert.equal(nearest.low?.hora, '07:00')
  assert.equal(nearest.high?.hora, '12:30')
})

test('buildAlertMessage() usa nuevo formato de fecha/rango/empieza y mareas cercanas', () => {
  const alert = mkAlert()
  const first = mkForecast('2026-02-16T10:00:00.000Z')
  const msg = buildAlertMessage({
    alert,
    first,
    startDate: new Date('2026-02-16T10:00:00.000Z'),
    endDate: new Date('2026-02-16T12:00:00.000Z'),
    nearestTides: {
      low: { date: '2026-02-16', hora: '07:00', altura: 0.8, tipo: 'bajamar' },
      high: { date: '2026-02-16', hora: '12:30', altura: 3.2, tipo: 'pleamar' },
    },
    nowMs: new Date('2026-02-16T08:00:00.000Z').getTime(),
  })

  assert.match(msg, /📅 Fecha:/)
  assert.match(msg, /⏰ Rango:/)
  assert.match(msg, /⏳ Empieza:/)
  assert.doesNotMatch(msg, /Coincidencia/)
  assert.match(msg, /Bajamar más cercana: 07:00 \(0.80m\)/)
  assert.match(msg, /Pleamar más cercana: 12:30 \(3.20m\)/)
})
