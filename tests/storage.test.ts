import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function loadStorageModule() {
  return import(`../src/storage.ts?t=${Date.now()}-${Math.random()}`)
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
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.ALERTS_DB_PATH
  }
})
