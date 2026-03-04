import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const LOG_PATH =
  process.env.NOTIFICATIONS_LOG_PATH ?? './data/notifications-log.json'
const MAX_ENTRIES = 5_000

export interface NotificationLogEntry {
  key: string
  chatId: number
  alertId: string
  alertName: string
  spot: string
  windowStartIso: string
  windowEndIso: string
  firstDiscoveredAt: string
  lastMatchedAt: string
  matches: number
  sentCount: number
  lastSentAt?: string
}

export interface NotificationLogEvent {
  chatId: number
  alertId: string
  alertName: string
  spot: string
  windowStartIso: string
  windowEndIso: string
  atIso: string
}

function parseIsoMs(value: string): number {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NaN
}

function nowMsFromIso(atIso: string): number {
  const at = parseIsoMs(atIso)
  return Number.isFinite(at) ? at : Date.now()
}

function isEntryShape(value: unknown): value is NotificationLogEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<NotificationLogEntry>
  return (
    typeof entry.key === 'string' &&
    typeof entry.chatId === 'number' &&
    typeof entry.alertId === 'string' &&
    typeof entry.alertName === 'string' &&
    typeof entry.spot === 'string' &&
    typeof entry.windowStartIso === 'string' &&
    typeof entry.windowEndIso === 'string' &&
    typeof entry.firstDiscoveredAt === 'string' &&
    typeof entry.lastMatchedAt === 'string' &&
    typeof entry.matches === 'number' &&
    typeof entry.sentCount === 'number' &&
    (entry.lastSentAt == null || typeof entry.lastSentAt === 'string')
  )
}

function makeKey(e: {
  chatId: number
  alertId: string
  windowStartIso: string
  windowEndIso: string
}): string {
  return `${e.chatId}:${e.alertId}:${e.windowStartIso}:${e.windowEndIso}`
}

function pruneExpired(
  entries: NotificationLogEntry[],
  nowMs: number,
): NotificationLogEntry[] {
  return entries.filter((entry) => {
    const endMs = parseIsoMs(entry.windowEndIso)
    if (!Number.isFinite(endMs)) return false
    return endMs > nowMs
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

async function ensureLogFile(): Promise<void> {
  const dir = dirname(LOG_PATH)
  await mkdir(dir, { recursive: true })
  if (!(await pathExists(LOG_PATH))) {
    await writeFile(LOG_PATH, JSON.stringify([], null, 2), 'utf8')
  }
}

async function readEntriesRaw(): Promise<NotificationLogEntry[]> {
  await ensureLogFile()
  try {
    const raw = await readFile(LOG_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntryShape)
  } catch {
    return []
  }
}

async function writeEntries(entries: NotificationLogEntry[]): Promise<void> {
  await ensureLogFile()
  await writeFile(
    LOG_PATH,
    JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2),
    'utf8',
  )
}

export async function readNotificationLog(
  nowMs = Date.now(),
): Promise<NotificationLogEntry[]> {
  const pruned = pruneExpired(await readEntriesRaw(), nowMs)
  await writeEntries(pruned)
  return pruned
}

export async function recordNotificationMatch(
  event: NotificationLogEvent,
): Promise<void> {
  const nowMs = nowMsFromIso(event.atIso)
  const entries = pruneExpired(await readEntriesRaw(), nowMs)
  const key = makeKey(event)
  const existing = entries.find((entry) => entry.key === key)

  if (existing) {
    existing.lastMatchedAt = event.atIso
    existing.matches += 1
    existing.alertName = event.alertName
    existing.spot = event.spot
  } else {
    entries.push({
      key,
      chatId: event.chatId,
      alertId: event.alertId,
      alertName: event.alertName,
      spot: event.spot,
      windowStartIso: event.windowStartIso,
      windowEndIso: event.windowEndIso,
      firstDiscoveredAt: event.atIso,
      lastMatchedAt: event.atIso,
      matches: 1,
      sentCount: 0,
    })
  }

  await writeEntries(entries)
}

export async function recordNotificationSent(
  event: NotificationLogEvent,
): Promise<void> {
  const nowMs = nowMsFromIso(event.atIso)
  const entries = pruneExpired(await readEntriesRaw(), nowMs)
  const key = makeKey(event)
  const existing = entries.find((entry) => entry.key === key)

  if (existing) {
    existing.sentCount += 1
    existing.lastSentAt = event.atIso
  } else {
    entries.push({
      key,
      chatId: event.chatId,
      alertId: event.alertId,
      alertName: event.alertName,
      spot: event.spot,
      windowStartIso: event.windowStartIso,
      windowEndIso: event.windowEndIso,
      firstDiscoveredAt: event.atIso,
      lastMatchedAt: event.atIso,
      matches: 1,
      sentCount: 1,
      lastSentAt: event.atIso,
    })
  }

  await writeEntries(entries)
}
