import { madridParts } from './time.js'

const MAX_SCAN_MINUTES = 6 * 60

export function msUntilNextMadridHourMinute(now: Date, minute = 10): number {
  const targetMinute = Math.trunc(minute)
  if (!Number.isFinite(targetMinute) || targetMinute < 0 || targetMinute > 59) {
    throw new RangeError('minute must be between 0 and 59')
  }

  const nowMs = now.getTime()
  const firstMinuteBoundary =
    Math.floor((nowMs + 1_000) / (60 * 1000)) * 60 * 1000

  for (let offset = 0; offset <= MAX_SCAN_MINUTES; offset++) {
    const candidateMs = firstMinuteBoundary + offset * 60 * 1000
    if (candidateMs <= nowMs) continue
    const candidateMinute = madridParts(new Date(candidateMs)).minute
    if (candidateMinute !== targetMinute) continue
    return Math.max(1_000, candidateMs - nowMs)
  }

  return Math.max(1_000, 60 * 60 * 1000)
}

export function startHourlySchedulerAtMinute(
  run: () => Promise<void> | void,
  minute = 10,
  now: () => Date = () => new Date(),
): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const schedule = () => {
    if (stopped) return
    const delay = msUntilNextMadridHourMinute(now(), minute)
    timer = setTimeout(async () => {
      if (stopped) return
      try {
        await run()
      } finally {
        schedule()
      }
    }, delay)
  }

  schedule()

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
