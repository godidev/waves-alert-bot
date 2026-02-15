const MADRID_TZ = 'Europe/Madrid'

function madridParts(date: Date): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MADRID_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

export function msUntilNextMadridHourMinute(now: Date, minute = 10): number {
  const p = madridParts(now)
  const target = new Date(now)

  if (p.minute < minute) {
    target.setMinutes(target.getMinutes() + (minute - p.minute), 0, 0)
    return Math.max(1_000, target.getTime() - now.getTime())
  }

  const add = 60 - p.minute + minute
  target.setMinutes(target.getMinutes() + add, 0, 0)
  return Math.max(1_000, target.getTime() - now.getTime())
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
