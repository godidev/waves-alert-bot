import type { SurfForecast } from './types.js'

type Cardinal = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'

export function totalWaveHeight(f: SurfForecast): number {
  if (!f.validSwells.length) return 0
  const sum = f.validSwells.reduce((acc, s) => acc + s.height ** 2, 0)
  return Math.sqrt(sum)
}

export function primaryPeriod(f: SurfForecast): number {
  if (!f.validSwells.length) return 0
  const primary = f.validSwells.reduce((max, s) => (s.height > max.height ? s : max))
  return primary.period
}

export function degreesToCardinal(deg: number): Cardinal {
  const dirs: Cardinal[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const index = Math.round((((deg % 360) + 360) % 360) / 45) % 8
  return dirs[index]
}

export function nextId(): string {
  return Math.random().toString(36).slice(2, 10)
}
