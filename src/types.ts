export interface WindRange {
  min: number
  max: number
}

export interface AlertRule {
  id: string
  chatId: number
  spot: string
  waveMin: number
  waveMax: number
  energyMin: number
  energyMax: number
  periodMin: number
  periodMax: number
  windRanges?: WindRange[]
  windLabels?: string[]
  cooldownMin: number
  lastNotifiedAt?: string
  createdAt: string
}

export interface SurfForecast {
  date: string
  spot: string
  validSwells: { period: number; angle: number; height: number }[]
  wind: { speed: number; angle: number }
  energy: number
}
