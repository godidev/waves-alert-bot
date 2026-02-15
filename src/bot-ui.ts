import { GrammyError, InlineKeyboard } from 'grammy'
import type { RangeOption, TidePreferenceId } from './bot-options.js'
import { TIDE_PORT_OPTIONS, TIDE_PREF_OPTIONS } from './bot-options.js'

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
  const on = (d: string) => (selected.includes(d) ? '✅ ' : '')
  return new InlineKeyboard()
    .text(`${on('N')}N ↓ (337-22°)`, 'wind:N')
    .text(`${on('NE')}NE ↙ (22-67°)`, 'wind:NE')
    .row()
    .text(`${on('E')}E ← (67-112°)`, 'wind:E')
    .text(`${on('SE')}SE ↖ (112-157°)`, 'wind:SE')
    .row()
    .text(`${on('S')}S ↑ (157-202°)`, 'wind:S')
    .text(`${on('SW')}SW ↗ (202-247°)`, 'wind:SW')
    .row()
    .text(`${on('W')}W → (247-292°)`, 'wind:W')
    .text(`${on('NW')}NW ↘ (292-337°)`, 'wind:NW')
    .row()
    .text('ANY (sin filtro)', 'wind:ANY')
    .text('✅ Confirmar', 'wind:DONE')
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
