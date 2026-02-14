export type Cardinal = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'

export interface AlertRule {
  id: string
  chatId: number
  spot: string
  waveMin: number
  waveMax: number
  periodMin: number
  periodMax: number
  windDir?: Cardinal
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
