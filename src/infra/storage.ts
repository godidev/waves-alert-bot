import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AlertRule } from '../core/types.js'

const DB_PATH = process.env.ALERTS_DB_PATH ?? './data/alerts.json'

interface DbShape {
  alerts: AlertRule[]
}

type LegacyAlert = Partial<AlertRule> & {
  windMin?: number | string
  windMax?: number | string
}

function envelope(ranges: { min: number; max: number }[]): {
  min: number
  max: number
} {
  return {
    min: Math.min(...ranges.map((r) => r.min)),
    max: Math.max(...ranges.map((r) => r.max)),
  }
}

function envelopeWind(ranges: { min: number; max: number }[]): {
  min: number
  max: number
} {
  const boundaries = ranges.flatMap((r) => {
    if (r.min <= r.max) return [r.min, r.max]
    return [0, r.max, r.min, 360]
  })

  return {
    min: Math.min(...boundaries),
    max: Math.max(...boundaries),
  }
}

function ensureDb(): void {
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(DB_PATH)) {
    writeFileSync(
      DB_PATH,
      JSON.stringify({ alerts: [] } satisfies DbShape, null, 2),
    )
  }
}

function migrateAlert(rawAlert: unknown): AlertRule {
  const alert = { ...(rawAlert as LegacyAlert) }

  if (alert.spot === 'sopela') {
    alert.spot = 'sopelana'
  }

  if (
    (!alert.windRanges || !alert.windRanges.length) &&
    alert.windMin != null &&
    alert.windMax != null
  ) {
    alert.windRanges = [
      { min: Number(alert.windMin), max: Number(alert.windMax) },
    ]
  }

  if (alert.waveRanges?.length) {
    const waveEnv = envelope(alert.waveRanges)
    alert.waveMin = waveEnv.min
    alert.waveMax = waveEnv.max
  }

  if (alert.periodRanges?.length) {
    const periodEnv = envelope(alert.periodRanges)
    alert.periodMin = periodEnv.min
    alert.periodMax = periodEnv.max
  }

  if (alert.windRanges?.length) {
    const windEnv = envelopeWind(alert.windRanges)
    alert.windRanges = [{ min: windEnv.min, max: windEnv.max }]
  }

  if (!alert.tidePortId) alert.tidePortId = '72'
  if (!alert.tidePortName) alert.tidePortName = 'Bermeo'
  if (!alert.tidePreference) alert.tidePreference = 'any'

  delete alert.waveRanges
  delete alert.periodRanges
  delete alert.waveLabels
  delete alert.periodLabels
  delete alert.energyLabel

  delete alert.windMin
  delete alert.windMax

  return alert as AlertRule
}

function resetCorruptedDb(raw: string): DbShape {
  const backupPath = `${DB_PATH}.corrupted-${Date.now()}.bak`
  try {
    writeFileSync(backupPath, raw)
  } catch {
    // noop
  }

  const empty: DbShape = { alerts: [] }
  writeFileSync(DB_PATH, JSON.stringify(empty, null, 2))
  return empty
}

function readDb(): DbShape {
  ensureDb()

  const raw = readFileSync(DB_PATH, 'utf8')
  let parsed: DbShape

  try {
    parsed = JSON.parse(raw) as DbShape
  } catch {
    return resetCorruptedDb(raw)
  }

  const migratedAlerts = (parsed.alerts ?? []).map(migrateAlert)
  const changed =
    JSON.stringify(migratedAlerts) !== JSON.stringify(parsed.alerts ?? [])

  if (changed) {
    const next = { alerts: migratedAlerts }
    writeFileSync(DB_PATH, JSON.stringify(next, null, 2))
    return next
  }

  return { alerts: migratedAlerts }
}

function writeDb(next: DbShape): void {
  ensureDb()
  writeFileSync(DB_PATH, JSON.stringify(next, null, 2))
}

export function listAlerts(chatId: number): AlertRule[] {
  return readDb().alerts.filter((a) => a.chatId === chatId)
}

export function insertAlert(alert: AlertRule): void {
  const db = readDb()
  db.alerts.push(alert)
  writeDb(db)
}

export function deleteAlert(chatId: number, id: string): boolean {
  const db = readDb()
  const lenBefore = db.alerts.length
  db.alerts = db.alerts.filter((a) => !(a.chatId === chatId && a.id === id))
  writeDb(db)
  return db.alerts.length < lenBefore
}

export function listAllAlerts(): AlertRule[] {
  return readDb().alerts
}

export function touchAlertNotified(id: string, atIso: string): void {
  const db = readDb()
  const target = db.alerts.find((a) => a.id === id)
  if (!target) return
  target.lastNotifiedAt = atIso
  writeDb(db)
}
