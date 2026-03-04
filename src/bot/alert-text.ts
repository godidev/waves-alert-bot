import type { AlertRule } from '../core/types.js'
import { tideTag } from './bot-helpers.js'

function fmtRangeNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(1)
}

function formatCompactRange(
  min: number,
  max: number,
  openStart?: number,
): string {
  if (openStart == null || max < openStart) {
    return `${fmtRangeNumber(min)}-${fmtRangeNumber(max)}`
  }
  if (min >= openStart) return `${fmtRangeNumber(openStart)}+`
  return `${fmtRangeNumber(min)}-${fmtRangeNumber(openStart)}+`
}

export function listAlertBlock(a: AlertRule, idx: number): string {
  const wave = `${fmtRangeNumber(a.waveMin)}-${fmtRangeNumber(a.waveMax)}`
  const energy = formatCompactRange(a.energyMin, a.energyMax, 4000)
  const period = formatCompactRange(a.periodMin, a.periodMax, 16)
  const wind = a.windLabels?.join(', ') ?? 'ANY'
  const tide = `${tideTag(a.tidePreference)} (${a.tidePortName ?? 'Bermeo'})`
  const status = a.enabled === false ? 'pausada' : 'activa'

  return [
    `#${idx + 1} · ${a.name}`,
    `ID: ${a.id}`,
    `Spot: ${a.spot}`,
    `Olas: ${wave}`,
    `Energía: ${energy}`,
    `Periodo: ${period}`,
    `Viento: ${wind}`,
    `Marea: ${tide}`,
    `Estado: ${status}`,
  ].join('\n')
}

export function allAlertsAdminText(alerts: AlertRule[]): string {
  const blocks = alerts.map((a) => {
    const wave = `${fmtRangeNumber(a.waveMin)}-${fmtRangeNumber(a.waveMax)}`
    const energy = formatCompactRange(a.energyMin, a.energyMax, 4000)
    const period = formatCompactRange(a.periodMin, a.periodMax, 16)
    const wind = a.windLabels?.join(', ') ?? 'ANY'
    const tide = `${tideTag(a.tidePreference)} (${a.tidePortName ?? 'Bermeo'})`
    const status = a.enabled === false ? 'pausada' : 'activa'
    const notified = a.lastNotifiedAt
      ? a.lastNotifiedAt.replace('T', ' ').slice(0, 19)
      : 'nunca'

    return [
      `${a.name} [${a.id}]`,
      `chatId: ${a.chatId}`,
      `spot: ${a.spot}`,
      `olas: ${wave} | energia: ${energy} | periodo: ${period}`,
      `viento: ${wind} | marea: ${tide}`,
      `estado: ${status}`,
      `última notificación: ${notified}`,
    ].join('\n')
  })

  return `--- Todas las alertas (${alerts.length}) ---\n\n${blocks.join('\n\n────────\n\n')}`
}
