export interface Range {
  min: number
  max: number
}

export interface AlertRule {
  id: string
  chatId: number
  name: string
  spot: string
  waveMin: number
  waveMax: number
  energyMin: number
  energyMax: number
  periodMin: number
  periodMax: number
  waveRanges?: Range[]
  periodRanges?: Range[]
  windRanges?: Range[]
  waveLabels?: string[]
  periodLabels?: string[]
  windLabels?: string[]
  energyLabel?: string
  cooldownMin?: number
  tidePortId?: string
  tidePortName?: string
  tidePreference?: 'low' | 'mid' | 'high' | 'any'
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
