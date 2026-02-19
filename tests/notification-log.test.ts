import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function loadNotificationLogModule() {
  return import(
    `../src/infra/notification-log.ts?t=${Date.now()}-${Math.random()}`
  )
}

test('notification-log tracks first discovery and increments matches on reruns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waves-alerts-notification-log-'))
  try {
    const logPath = join(dir, 'notifications-log.json')
    process.env.NOTIFICATIONS_LOG_PATH = logPath

    const log = await loadNotificationLogModule()
    const event = {
      chatId: 123,
      alertId: 'a1',
      alertName: 'Mananero',
      spot: 'sopelana',
      windowStartIso: '2099-01-01T10:00:00.000Z',
      windowEndIso: '2099-01-01T13:00:00.000Z',
      atIso: '2026-02-19T08:00:00.000Z',
    }

    log.recordNotificationMatch(event)
    log.recordNotificationMatch({ ...event, atIso: '2026-02-19T09:00:00.000Z' })

    const entries = log.readNotificationLog()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].matches, 2)
    assert.equal(entries[0].firstDiscoveredAt, '2026-02-19T08:00:00.000Z')
    assert.equal(entries[0].lastMatchedAt, '2026-02-19T09:00:00.000Z')
    assert.equal(entries[0].chatId, 123)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.NOTIFICATIONS_LOG_PATH
  }
})

test('notification-log records sent count and last sent timestamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waves-alerts-notification-log-'))
  try {
    const logPath = join(dir, 'notifications-log.json')
    process.env.NOTIFICATIONS_LOG_PATH = logPath

    const log = await loadNotificationLogModule()
    const event = {
      chatId: 123,
      alertId: 'a1',
      alertName: 'Mananero',
      spot: 'sopelana',
      windowStartIso: '2099-01-01T10:00:00.000Z',
      windowEndIso: '2099-01-01T13:00:00.000Z',
      atIso: '2026-02-19T08:00:00.000Z',
    }

    log.recordNotificationMatch(event)
    log.recordNotificationSent({ ...event, atIso: '2026-02-19T08:01:00.000Z' })
    log.recordNotificationSent({ ...event, atIso: '2026-02-19T08:10:00.000Z' })

    const entries = log.readNotificationLog()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].sentCount, 2)
    assert.equal(entries[0].lastSentAt, '2026-02-19T08:10:00.000Z')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.NOTIFICATIONS_LOG_PATH
  }
})

test('notification-log purges entries whose window end already passed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waves-alerts-notification-log-'))
  try {
    const logPath = join(dir, 'notifications-log.json')
    writeFileSync(
      logPath,
      JSON.stringify(
        [
          {
            key: 'old',
            chatId: 1,
            alertId: 'old-alert',
            alertName: 'Old',
            spot: 'sopelana',
            windowStartIso: '2026-02-19T01:00:00.000Z',
            windowEndIso: '2026-02-19T02:00:00.000Z',
            firstDiscoveredAt: '2026-02-19T00:10:00.000Z',
            lastMatchedAt: '2026-02-19T00:20:00.000Z',
            matches: 4,
            sentCount: 1,
            lastSentAt: '2026-02-19T00:30:00.000Z',
          },
        ],
        null,
        2,
      ),
    )
    process.env.NOTIFICATIONS_LOG_PATH = logPath

    const log = await loadNotificationLogModule()
    log.recordNotificationMatch({
      chatId: 2,
      alertId: 'new-alert',
      alertName: 'New',
      spot: 'sopelana',
      windowStartIso: '2099-01-01T10:00:00.000Z',
      windowEndIso: '2099-01-01T12:00:00.000Z',
      atIso: '2026-02-19T08:00:00.000Z',
    })

    const entries = log.readNotificationLog()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].alertId, 'new-alert')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.NOTIFICATIONS_LOG_PATH
  }
})
