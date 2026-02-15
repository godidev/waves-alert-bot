import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AlertRule } from './types.js'

const DB_PATH = process.env.ALERTS_DB_PATH ?? './data/alerts.json'

interface DbShape {
  alerts: AlertRule[]
}

function ensureDb(): void {
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(DB_PATH)) {
    writeFileSync(DB_PATH, JSON.stringify({ alerts: [] } satisfies DbShape, null, 2))
  }
}

function migrateAlert(rawAlert: any): AlertRule {
  const alert = { ...rawAlert }

  if (alert.spot === 'sopela') {
    alert.spot = 'sopelana'
  }

  if ((!alert.windRanges || !alert.windRanges.length) && alert.windMin != null && alert.windMax != null) {
    alert.windRanges = [{ min: Number(alert.windMin), max: Number(alert.windMax) }]
  }

  if (!alert.tidePortId) alert.tidePortId = '72'
  if (!alert.tidePortName) alert.tidePortName = 'Bermeo'
  if (!alert.tidePreference) alert.tidePreference = 'any'

  delete alert.windMin
  delete alert.windMax

  return alert as AlertRule
}

function readDb(): DbShape {
  ensureDb()
  const raw = readFileSync(DB_PATH, 'utf8')
  const parsed = JSON.parse(raw) as DbShape

  const migratedAlerts = (parsed.alerts ?? []).map(migrateAlert)
  const changed = JSON.stringify(migratedAlerts) !== JSON.stringify(parsed.alerts ?? [])

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
