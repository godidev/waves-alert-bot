import { GrammyError, InlineKeyboard } from 'grammy'
import type { RangeOption, TidePreferenceId } from './bot-options.js'
import {
  TIDE_PORT_OPTIONS,
  TIDE_PREF_OPTIONS,
  WIND_SECTORS,
} from './bot-options.js'

interface EditReplyMarkupContext {
  editMessageReplyMarkup: (options: {
    reply_markup: InlineKeyboard
  }) => Promise<unknown>
}

export async function safeEditReplyMarkup(
  ctx: EditReplyMarkupContext,
  replyMarkup: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: replyMarkup })
  } catch (err) {
    if (
      err instanceof GrammyError &&
      err.description?.includes('message is not modified')
    ) {
      return
    }
    throw err
  }
}

export function keyboardFromOptions(
  prefix: string,
  options: RangeOption[],
  selected: string[],
  allowDone = true,
): InlineKeyboard {
  const kb = new InlineKeyboard()
  options.forEach((o, idx) => {
    const txt = `${selected.includes(o.id) ? '✅ ' : ''}${o.label}`
    kb.text(txt, `${prefix}:${o.id}`)
    if (idx % 2 === 1) kb.row()
  })
  kb.row()
  if (allowDone) kb.text('✅ Confirmar', `${prefix}:DONE`)
  return kb
}

export function windKeyboard(selected: string[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  WIND_SECTORS.forEach((s, idx) => {
    const prefix = selected.includes(s.id) ? '✅ ' : ''
    kb.text(
      `${prefix}${s.label} (${Math.floor(s.min)}-${Math.floor(s.max)}°)`,
      `wind:${s.id}`,
    )
    if (idx % 2 === 1) kb.row()
  })
  kb.text('ANY (sin filtro)', 'wind:ANY').text('✅ Confirmar', 'wind:DONE')
  return kb
}

export function tidePortKeyboard(selected?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
  TIDE_PORT_OPTIONS.forEach((p) => {
    kb.text(
      `${selected === p.id ? '✅ ' : ''}${p.label}`,
      `tideport:${p.id}`,
    ).row()
  })
  kb.text('✅ Confirmar', 'tideport:DONE')
  return kb
}

export function tidePreferenceKeyboard(
  selected?: TidePreferenceId,
): InlineKeyboard {
  const kb = new InlineKeyboard()
  TIDE_PREF_OPTIONS.forEach((p) => {
    kb.text(
      `${selected === p.id ? '✅ ' : ''}${p.label}`,
      `tidepref:${p.id}`,
    ).row()
  })
  return kb
}

export function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Guardar alerta', 'confirm:SAVE')
    .text('❌ Cancelar', 'confirm:CANCEL')
}
