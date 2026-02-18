import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function loadStorageModule() {
  return import(`../src/infra/storage.ts?t=${Date.now()}-${Math.random()}`)
}

test('storage: recovers from corrupted JSON by resetting DB and creating backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waves-alerts-storage-'))
  try {
    const dbPath = join(dir, 'alerts.json')
    writeFileSync(dbPath, '{ this is broken json')
    process.env.ALERTS_DB_PATH = dbPath

    const storage = await loadStorageModule()
    const alerts = storage.listAllAlerts()

    assert.deepEqual(alerts, [])

    const files = readdirSync(dir)
    assert.ok(files.includes('alerts.json'))
    assert.ok(
      files.some(
        (f) => f.startsWith('alerts.json.corrupted-') && f.endsWith('.bak'),
      ),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.ALERTS_DB_PATH
  }
})

test('storage: migrates legacy fields windMin/windMax and spot=sopela', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waves-alerts-storage-'))
  try {
    const dbPath = join(dir, 'alerts.json')
    writeFileSync(
      dbPath,
      JSON.stringify({
        alerts: [
          {
            id: 'a1',
            chatId: 1,
            name: 'legacy',
            spot: 'sopela',
            waveMin: 1,
            waveMax: 2,
            energyMin: 1,
            energyMax: 2,
            periodMin: 8,
            periodMax: 10,
            windMin: 10,
            windMax: 20,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    )
    process.env.ALERTS_DB_PATH = dbPath

    const storage = await loadStorageModule()
    const [alert] = storage.listAllAlerts()

    assert.equal(alert.spot, 'sopelana')
    assert.deepEqual(alert.windRanges, [{ min: 10, max: 20 }])
    assert.equal(alert.tidePortId, '72')
    assert.equal(alert.tidePortName, 'Bermeo')
    assert.equal(alert.tidePreference, 'any')
    assert.equal(alert.enabled, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.ALERTS_DB_PATH
  }
})

test('storage: setAlertEnabled pauses and resumes alerts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waves-alerts-storage-'))
  try {
    const dbPath = join(dir, 'alerts.json')
    writeFileSync(
      dbPath,
      JSON.stringify({
        alerts: [
          {
            id: 'a3',
            chatId: 7,
            name: 'toggle-me',
            spot: 'sopelana',
            waveMin: 1,
            waveMax: 2,
            energyMin: 800,
            energyMax: 1500,
            periodMin: 10,
            periodMax: 12,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    )
    process.env.ALERTS_DB_PATH = dbPath

    const storage = await loadStorageModule()

    assert.equal(storage.setAlertEnabled(7, 'a3', false), true)
    assert.equal(storage.listAlerts(7)[0].enabled, false)

    assert.equal(storage.setAlertEnabled(7, 'a3', true), true)
    assert.equal(storage.listAlerts(7)[0].enabled, true)

    assert.equal(storage.setAlertEnabled(7, 'missing', false), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.ALERTS_DB_PATH
  }
})

test('storage: normaliza rangos legacy a min/max y elimina duplicados', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waves-alerts-storage-'))
  try {
    const dbPath = join(dir, 'alerts.json')
    writeFileSync(
      dbPath,
      JSON.stringify({
        alerts: [
          {
            id: 'a2',
            chatId: 1,
            name: 'legacy-ranges',
            spot: 'sopelana',
            waveMin: 1,
            waveMax: 1,
            energyMin: 100,
            energyMax: 200,
            periodMin: 8,
            periodMax: 8,
            waveRanges: [
              { min: 1, max: 1.5 },
              { min: 2.5, max: 3 },
            ],
            periodRanges: [
              { min: 10, max: 12 },
              { min: 16, max: 99 },
            ],
            windRanges: [
              { min: 157.5, max: 202.5 },
              { min: 202.5, max: 247.5 },
            ],
            waveLabels: ['1.0-1.5', '2.5-3.0'],
            periodLabels: ['10-12', '16+'],
            energyLabel: 'Media (800-1500), Alta (1500-4000)',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    )
    process.env.ALERTS_DB_PATH = dbPath

    const storage = await loadStorageModule()
    const [alert] = storage.listAllAlerts()

    assert.equal(alert.waveMin, 1)
    assert.equal(alert.waveMax, 3)
    assert.equal(alert.periodMin, 10)
    assert.equal(alert.periodMax, 99)
    assert.deepEqual(alert.windRanges, [{ min: 157.5, max: 247.5 }])
    assert.equal(alert.waveRanges, undefined)
    assert.equal(alert.periodRanges, undefined)
    assert.equal(alert.waveLabels, undefined)
    assert.equal(alert.periodLabels, undefined)
    assert.equal(alert.energyLabel, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.ALERTS_DB_PATH
  }
})
