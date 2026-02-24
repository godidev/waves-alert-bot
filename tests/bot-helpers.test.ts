import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveOptimalSelections,
  draftToAlert,
  fetchForecasts,
  fetchSpots,
  getTideEventsForDate,
} from '../src/bot/bot-helpers.js'
import type { DraftAlert } from '../src/bot/bot-options.js'

function mkDraft(overrides: Partial<DraftAlert> = {}): DraftAlert {
  return {
    step: 'confirm',
    name: 'Alerta test',
    spotId: 'spot-sopelana-id',
    spot: 'sopelana',
    waveSelected: ['1.0-1.5', '2.5-3.0'],
    energySelected: ['low', 'high'],
    periodSelected: ['8-10', '14-16'],
    windSelected: ['NE', 'E'],
    tidePortId: '72',
    tidePreference: 'any',
    flowMessageIds: [],
    ...overrides,
  }
}

test('draftToAlert usa envolvente min/max de todas las opciones seleccionadas', () => {
  const alert = draftToAlert(123, mkDraft())
  assert.ok(alert)
  if (!alert) throw new Error('expected alert')

  assert.equal(alert.waveMin, 1)
  assert.equal(alert.waveMax, 3)
  assert.equal(alert.periodMin, 8)
  assert.equal(alert.periodMax, 16)
  assert.equal(alert.energyMin, 0)
  assert.equal(alert.energyMax, 4000)

  assert.equal(alert.waveRanges, undefined)
  assert.equal(alert.periodRanges, undefined)
  assert.deepEqual(alert.windRanges, [{ min: 22.5, max: 112.5 }])
  assert.equal(alert.enabled, true)
})

test('draftToAlert devuelve null si falta una selección requerida', () => {
  const alert = draftToAlert(
    123,
    mkDraft({
      energySelected: [],
    }),
  )

  assert.equal(alert, null)
})

test('fetchForecasts usa signal y degrada a [] cuando fetch falla', async () => {
  const originalFetch = globalThis.fetch
  let signalSeen = false
  let urlSeen = ''

  globalThis.fetch = (async (input, init) => {
    urlSeen = String(input)
    signalSeen = init?.signal instanceof AbortSignal
    throw new Error('network error')
  }) as typeof fetch

  try {
    const forecasts = await fetchForecasts(
      'https://backend.invalid',
      'spot-sopelana-id',
    )
    assert.deepEqual(forecasts, [])
    assert.equal(signalSeen, true)
    assert.equal(
      urlSeen,
      'https://backend.invalid/surf-forecast/spot-sopelana-id/hourly',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('getTideEventsForDate usa signal y degrada a [] cuando fetch falla', async () => {
  const originalFetch = globalThis.fetch
  let signalSeen = false

  globalThis.fetch = (async (_input, init) => {
    signalSeen = init?.signal instanceof AbortSignal
    throw new Error('network error')
  }) as typeof fetch

  try {
    const tides = await getTideEventsForDate('72', '20260217')
    assert.deepEqual(tides, [])
    assert.equal(signalSeen, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchSpots usa endpoint dedicado y devuelve spots válidos únicos por spotId', async () => {
  const originalFetch = globalThis.fetch
  let urlSeen = ''

  globalThis.fetch = (async (input) => {
    urlSeen = String(input)
    return {
      ok: true,
      json: async () => [
        {
          spotId: 'spot-sopelana-id',
          spotName: 'Sopelana',
          spotUrlName: 'sopelana',
          active: true,
          optimalConditions: {
            period: { min: 10, max: 14 },
            wind: { min: 200, max: 260 },
          },
          location: { lat: 43.3798, lng: -2.9808 },
        },
        {
          spotId: 'spot-mundaka-id',
          spotName: 'Mundaka',
          active: true,
          location: { lat: 43.407, lng: -2.6986 },
        },
        {
          spotId: 'spot-sopelana-id',
          spotName: 'Sopelana Duplicado',
          active: true,
        },
        {
          spotId: 'spot-inactive-id',
          spotName: 'Inactive',
          active: false,
        },
        { spotId: '', spotName: 'Empty id' },
        { spotId: 'missing-name' },
        123,
      ],
    } as Response
  }) as typeof fetch

  try {
    const spots = await fetchSpots('https://backend.invalid')
    assert.equal(urlSeen, 'https://backend.invalid/spots')
    assert.deepEqual(spots, [
      {
        spotId: 'spot-sopelana-id',
        spotName: 'Sopelana',
        spotUrlName: 'sopelana',
        active: true,
        optimalConditions: {
          period: { min: 10, max: 14 },
          wind: { min: 200, max: 260 },
        },
        location: { lat: 43.3798, lng: -2.9808 },
      },
      {
        spotId: 'spot-mundaka-id',
        spotName: 'Mundaka',
        spotUrlName: undefined,
        active: true,
        optimalConditions: undefined,
        location: { lat: 43.407, lng: -2.6986 },
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchSpots degrada a [] cuando fetch falla', async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    throw new Error('network error')
  }) as typeof fetch

  try {
    const spots = await fetchSpots('https://backend.invalid')
    assert.deepEqual(spots, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deriveOptimalSelections mapea optimalConditions a opciones de periodo y viento', () => {
  const derived = deriveOptimalSelections({
    spotId: 's1',
    spotName: 'Sopelana',
    active: true,
    optimalConditions: {
      period: { min: 10, max: 14 },
      wind: { min: 200, max: 260 },
    },
  })

  assert.deepEqual(derived.periodSelected, ['8-10', '10-12', '12-14', '14-16'])
  assert.deepEqual(derived.windSelected, ['S', 'SW', 'W'])
  assert.deepEqual(derived.periodRange, { min: 10, max: 14 })
  assert.deepEqual(derived.windRange, { min: 200, max: 260 })
})

test('draftToAlert usa rangos optimos de spot para periodo y viento cuando existen', () => {
  const alert = draftToAlert(
    123,
    mkDraft({
      periodSelected: [],
      windSelected: [],
      spotOptimalPeriodRange: { min: 10, max: 14 },
      spotOptimalWindRange: { min: 200, max: 260 },
    }),
  )

  assert.ok(alert)
  if (!alert) throw new Error('expected alert')
  assert.equal(alert.periodMin, 10)
  assert.equal(alert.periodMax, 14)
  assert.deepEqual(alert.windRanges, [{ min: 200, max: 260 }])
})
