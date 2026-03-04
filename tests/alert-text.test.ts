import test from 'node:test'
import assert from 'node:assert/strict'
import { allAlertsAdminText, listAlertBlock } from '../src/bot/alert-text.js'
import type { AlertRule } from '../src/core/types.js'

function mkAlert(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'a1',
    chatId: 123,
    name: 'Central',
    spotId: 'spot-sopelana-id',
    spot: 'sopelana',
    waveMin: 1,
    waveMax: 2.5,
    energyMin: 1500,
    energyMax: 4000,
    periodMin: 10,
    periodMax: 16,
    windRanges: [{ min: 157.5, max: 247.5 }],
    windLabels: ['S', 'SW'],
    tidePortId: '72',
    tidePortName: 'Bermeo',
    tidePreference: 'any',
    enabled: true,
    createdAt: '2026-02-19T00:00:00.000Z',
    ...overrides,
  }
}

test('listAlertBlock formats user-facing alert summary lines', () => {
  const block = listAlertBlock(mkAlert(), 0)
  assert.match(block, /#1 · Central/)
  assert.match(block, /ID: a1/)
  assert.match(block, /Olas: 1-2\.5/)
  assert.match(block, /Energía: 1500-4000\+/)
  assert.match(block, /Viento: S, SW/)
  assert.match(block, /Estado: activa/)
})

test('allAlertsAdminText includes all alert metadata in a single payload', () => {
  const out = allAlertsAdminText([
    mkAlert(),
    mkAlert({ id: 'a2', name: 'Tubero', enabled: false }),
  ])
  assert.match(out, /--- Todas las alertas \(2\) ---/)
  assert.match(out, /Central \[a1\]/)
  assert.match(out, /Tubero \[a2\]/)
  assert.match(out, /estado: pausada/)
})
