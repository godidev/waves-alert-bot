import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAlertMessage,
  findNearestTides,
  firstConsecutiveWindow,
  matchDetail,
  matches,
} from '../src/core/alert-engine.js'
import type { AlertRule, SurfForecast } from '../src/core/types.js'

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

test('matchDetail() returns per-filter pass/fail booleans', () => {
  const alert = mkAlert()

  // All pass
  const allPass = matchDetail(alert, mkForecast('2026-02-16T10:00:00.000Z'))
  assert.equal(allPass.pass, true)
  assert.equal(allPass.wave, true)
  assert.equal(allPass.period, true)
  assert.equal(allPass.energy, true)
  assert.equal(allPass.wind, true)

  // Energy fail (500 < energyMin 800)
  const energyFail = matchDetail(
    alert,
    mkForecast('2026-02-16T10:00:00.000Z', 500),
  )
  assert.equal(energyFail.pass, false)
  assert.equal(energyFail.energy, false)
  assert.equal(energyFail.wave, true)

  // Wind fail (180° outside 22.5-67.5 range)
  const windFail = matchDetail(
    alert,
    mkForecast('2026-02-16T10:00:00.000Z', 1200, 180),
  )
  assert.equal(windFail.pass, false)
  assert.equal(windFail.wind, false)
  assert.equal(windFail.wave, true)
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
  })

  assert.match(msg, /📍 sopelana/)
  assert.match(msg, /📅 .*/)
  assert.match(msg, /⏰ 11:00-14:00/)
  assert.doesNotMatch(msg, /⏳ Empieza:/)
  assert.doesNotMatch(msg, /Coincidencia/)
  assert.match(msg, /<code>Hora.*\|.*m.*\|.*E.*\|.*V.*\|.*T\(s\).*<\/code>/)
  assert.match(msg, /<code>12:30\s+\|\s+⬆️ Marea alta \(3.20m\).*<\/code>/)
  assert.match(msg, /<code>07:00\s+\|\s+⬇️ Marea baja \(0.80m\).*<\/code>/)
  assert.match(msg, /\. \./)
  assert.match(
    msg,
    /<code>11:00\s+\|\s+1\.5\s+\|\s+1200\s+\|\s+10↙\s+\|\s+11<\/code>/,
  )
})

test('buildAlertMessage() formatea día/hora siempre en Europe/Madrid', () => {
  const alert = mkAlert()
  const first = mkForecast('2026-01-15T10:00:00.000Z')
  const msg = buildAlertMessage({
    alert,
    first,
    startDate: new Date('2026-01-15T10:00:00.000Z'),
    endDate: new Date('2026-01-15T12:00:00.000Z'),
    nearestTides: { low: null, high: null },
  })

  assert.match(msg, /📅 .*/)
  assert.match(msg, /⏰ 11:00-14:00/)
})
