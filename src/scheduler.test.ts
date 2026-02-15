import test from 'node:test'
import assert from 'node:assert/strict'
import { msUntilNextMadridHourMinute } from './scheduler.js'

test('scheduler calcula próximo HH:10 si ya pasó el minuto', () => {
  const now = new Date('2026-02-15T19:28:00+01:00')
  const ms = msUntilNextMadridHourMinute(now, 10)
  assert.equal(ms, 42 * 60 * 1000)
})

test('scheduler calcula HH:10 de la hora actual si está antes', () => {
  const now = new Date('2026-02-15T19:03:00+01:00')
  const ms = msUntilNextMadridHourMinute(now, 10)
  assert.equal(ms, 7 * 60 * 1000)
})
