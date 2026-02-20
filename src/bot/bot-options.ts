import type { AlertRule } from '../core/types.js'

export const DEFAULT_SPOT = 'sopelana'

export type Step =
  | 'name'
  | 'wave'
  | 'energy'
  | 'period'
  | 'wind'
  | 'tidePort'
  | 'tidePref'
  | 'confirm'

export type RangeOption = {
  id: string
  label: string
  min: number
  max: number
}

export const WAVE_OPTIONS: RangeOption[] = [
  { id: '0.5-1.0', label: '0.5-1.0m', min: 0.5, max: 1.0 },
  { id: '1.0-1.5', label: '1.0-1.5m', min: 1.0, max: 1.5 },
  { id: '1.5-2.0', label: '1.5-2.0m', min: 1.5, max: 2.0 },
  { id: '2.0-2.5', label: '2.0-2.5m', min: 2.0, max: 2.5 },
  { id: '2.5-3.0', label: '2.5-3.0m', min: 2.5, max: 3.0 },
  { id: '3.0-3.5', label: '3.0-3.5m', min: 3.0, max: 3.5 },
  { id: '3.5-4.0', label: '3.5-4.0m', min: 3.5, max: 4.0 },
  { id: '4.0+', label: '4.0m+', min: 4.0, max: 99 },
]

export const PERIOD_OPTIONS: RangeOption[] = [
  { id: '8-10', label: '8-10s', min: 8, max: 10 },
  { id: '10-12', label: '10-12s', min: 10, max: 12 },
  { id: '12-14', label: '12-14s', min: 12, max: 14 },
  { id: '14-16', label: '14-16s', min: 14, max: 16 },
  { id: '16+', label: '16+s', min: 16, max: 99 },
]

export const ENERGY_OPTIONS: RangeOption[] = [
  { id: 'low', label: 'Baja (0-800)', min: 0, max: 800 },
  { id: 'medium', label: 'Media (800-1500)', min: 800, max: 1500 },
  { id: 'high', label: 'Alta (1500-4000)', min: 1500, max: 4000 },
  { id: 'very-high', label: 'Muy alta (4000+)', min: 4000, max: 999999 },
]

export const TIDE_PORT_OPTIONS = [
  { id: '72', label: 'Bermeo' },
  { id: '2', label: 'Bilbao' },
] as const

export const TIDE_PREF_OPTIONS = [
  { id: 'any', label: 'ANY (sin filtro)' },
  { id: 'low', label: 'Baja' },
  { id: 'mid', label: 'Media' },
  { id: 'high', label: 'Alta' },
] as const

export const WIND_SECTORS = [
  { id: 'N', label: 'N ↓', min: 337.5, max: 22.5 },
  { id: 'NE', label: 'NE ↙', min: 22.5, max: 67.5 },
  { id: 'E', label: 'E ←', min: 67.5, max: 112.5 },
  { id: 'SE', label: 'SE ↖', min: 112.5, max: 157.5 },
  { id: 'S', label: 'S ↑', min: 157.5, max: 202.5 },
  { id: 'SW', label: 'SW ↗', min: 202.5, max: 247.5 },
  { id: 'W', label: 'W →', min: 247.5, max: 292.5 },
  { id: 'NW', label: 'NW ↘', min: 292.5, max: 337.5 },
] as const

export type TidePreferenceId = (typeof TIDE_PREF_OPTIONS)[number]['id']

export interface DraftAlert {
  step: Step
  name?: string
  spot: string
  waveSelected: string[]
  periodSelected: string[]
  energySelected: string[]
  windSelected: string[]
  tidePortId?: string
  tidePreference?: TidePreferenceId
  pendingAlert?: AlertRule
  flowMessageIds: number[]
}

export const COMMANDS_HELP =
  'Comandos:\n/setalert - crear alerta guiada (con botón ⬅️ Atrás en cada paso)\n/listalerts - ver alertas y borrar/pausar/reanudar con botones\n/pausealert <id> - pausar alerta por ID\n/resumealert <id> - reanudar alerta por ID\n/deletealert <id> - borrar alerta por ID\n/cancel - cancelar flujo actual\n/help - ver esta ayuda\n\nMarea en alertas:\n- ANY: sin filtro de marea\n- Alta/Baja: solo horas dentro de ±3h de la marea seleccionada\n- Media: filtro por clase de marea interpolada\n\nNotas:\n- Spot por defecto: sopelana\n- Se evita spam con deduplicación de ventana (si la ventana no cambia, no reenvía)'

export const BOT_COMMANDS = [
  { command: 'start', description: 'Iniciar bot y ver ayuda' },
  { command: 'setalert', description: 'Crear alerta guiada' },
  { command: 'listalerts', description: 'Ver tus alertas' },
  { command: 'pausealert', description: 'Pausar alerta por ID' },
  { command: 'resumealert', description: 'Reanudar alerta por ID' },
  { command: 'deletealert', description: 'Borrar alerta por ID' },
  { command: 'cancel', description: 'Cancelar flujo de creación' },
  { command: 'help', description: 'Mostrar comandos disponibles' },
]
