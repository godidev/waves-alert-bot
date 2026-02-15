export function buildCleanupDeleteList(
  messageIds: number[],
  keepMessageId?: number,
): number[] {
  const unique = [...new Set(messageIds)]
  return unique.filter((id) => !keepMessageId || id !== keepMessageId)
}
