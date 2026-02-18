import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCleanupDeleteList } from '../src/bot/flow-cleanup.js'

test('buildCleanupDeleteList elimina duplicados y conserva solo confirmación final', () => {
  const ids = [10, 11, 12, 11, 13]
  const out = buildCleanupDeleteList(ids, 12)
  assert.deepEqual(out, [10, 11, 13])
})
