import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const LOG_PATH = process.env.CHECK_LOG_PATH ?? './data/check-log.json'
const MAX_ENTRIES = 48

import type { DiscardReasons } from '../core/check-runner.js'

export interface CheckLogEntry {
  timestamp: string
  totalAlerts: number
  matched: number
  notified: number
  errors: number
  passAll: number
  spots: string[]
  durationMs: number
  discardReasons: DiscardReasons
}

function ensureLogFile(): void {
  const dir = dirname(LOG_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(LOG_PATH)) {
    writeFileSync(LOG_PATH, JSON.stringify([], null, 2))
  }
}

const DEFAULT_DISCARD: DiscardReasons = {
  wave: 0,
  period: 0,
  energy: 0,
  wind: 0,
  tide: 0,
  light: 0,
}

export function readLog(): CheckLogEntry[] {
  ensureLogFile()
  try {
    const raw = readFileSync(LOG_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((e: Record<string, unknown>) => ({
      ...(e as unknown as CheckLogEntry),
      errors: (e.errors as number) ?? 0,
      passAll: (e.passAll as number) ?? 0,
      discardReasons: (e.discardReasons as DiscardReasons) ?? DEFAULT_DISCARD,
    }))
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
