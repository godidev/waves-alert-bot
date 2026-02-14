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
  windMin?: number
  windMax?: number
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
