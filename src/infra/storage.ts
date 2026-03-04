import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  const boundaries = ranges.flatMap((r) => [r.min, r.max])

  return {
    min: Math.min(...boundaries),
    max: Math.max(...boundaries),
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

async function ensureDb(): Promise<void> {
  const dir = dirname(DB_PATH)
  await mkdir(dir, { recursive: true })
  if (!(await pathExists(DB_PATH))) {
    await writeFile(
      DB_PATH,
      JSON.stringify({ alerts: [] } satisfies DbShape, null, 2),
      'utf8',
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
  if (alert.enabled == null) alert.enabled = true

  delete alert.waveRanges
  delete alert.periodRanges
  delete alert.waveLabels
  delete alert.periodLabels
  delete alert.energyLabel

  delete alert.windMin
  delete alert.windMax

  return alert as AlertRule
}

async function resetCorruptedDb(raw: string): Promise<DbShape> {
  const backupPath = `${DB_PATH}.corrupted-${Date.now()}.bak`
  try {
    await writeFile(backupPath, raw, 'utf8')
  } catch {
    // noop
  }

  const empty: DbShape = { alerts: [] }
  await writeFile(DB_PATH, JSON.stringify(empty, null, 2), 'utf8')
  return empty
}

async function readDb(): Promise<DbShape> {
  await ensureDb()

  const raw = await readFile(DB_PATH, 'utf8')
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
    await writeFile(DB_PATH, JSON.stringify(next, null, 2), 'utf8')
    return next
  }

  return { alerts: migratedAlerts }
}

async function writeDb(next: DbShape): Promise<void> {
  await ensureDb()
  await writeFile(DB_PATH, JSON.stringify(next, null, 2), 'utf8')
}

export async function listAlerts(chatId: number): Promise<AlertRule[]> {
  return (await readDb()).alerts.filter((a) => a.chatId === chatId)
}

export async function insertAlert(alert: AlertRule): Promise<void> {
  const db = await readDb()
  db.alerts.push(alert)
  await writeDb(db)
}

export async function deleteAlert(
  chatId: number,
  id: string,
): Promise<boolean> {
  const db = await readDb()
  const lenBefore = db.alerts.length
  db.alerts = db.alerts.filter((a) => !(a.chatId === chatId && a.id === id))
  await writeDb(db)
  return db.alerts.length < lenBefore
}

export async function setAlertEnabled(
  chatId: number,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const db = await readDb()
  const target = db.alerts.find((a) => a.chatId === chatId && a.id === id)
  if (!target) return false
  target.enabled = enabled
  await writeDb(db)
  return true
}

export async function listAllAlerts(): Promise<AlertRule[]> {
  return (await readDb()).alerts
}

export async function touchAlertNotified(
  id: string,
  atIso: string,
): Promise<void> {
  const db = await readDb()
  const target = db.alerts.find((a) => a.id === id)
  if (!target) return
  target.lastNotifiedAt = atIso
  await writeDb(db)
}
