import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const LOG_PATH = process.env.CHECK_LOG_PATH ?? './data/check-log.json'
const MAX_ENTRIES = 48

export interface CheckLogEntry {
  timestamp: string
  totalAlerts: number
  matched: number
  notified: number
  spots: string[]
  durationMs: number
}

function ensureLogFile(): void {
  const dir = dirname(LOG_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(LOG_PATH)) {
    writeFileSync(LOG_PATH, JSON.stringify([], null, 2))
  }
}

export function readLog(): CheckLogEntry[] {
  ensureLogFile()
  try {
    const raw = readFileSync(LOG_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CheckLogEntry[]) : []
  } catch {
    return []
  }
}

export function appendCheckLog(entry: CheckLogEntry): void {
  const entries = readLog()
  entries.push(entry)

  const pruned = entries.slice(-MAX_ENTRIES)
  ensureLogFile()
  writeFileSync(LOG_PATH, JSON.stringify(pruned, null, 2))
}
