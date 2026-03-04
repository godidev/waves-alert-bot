import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

const DEFAULT_DISCARD: DiscardReasons = {
  wave: 0,
  period: 0,
  energy: 0,
  wind: 0,
  tide: 0,
  light: 0,
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

export async function readLog(): Promise<CheckLogEntry[]> {
  await ensureLogFile()
  try {
    const raw = await readFile(LOG_PATH, 'utf-8')
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

export async function appendCheckLog(entry: CheckLogEntry): Promise<void> {
  const entries = await readLog()
  entries.push(entry)

  const pruned = entries.slice(-MAX_ENTRIES)
  await ensureLogFile()
  await writeFile(LOG_PATH, JSON.stringify(pruned, null, 2), 'utf8')
}
