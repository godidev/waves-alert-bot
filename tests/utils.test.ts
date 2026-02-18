import test from 'node:test'
import assert from 'node:assert/strict'
import { windArrowFromDegrees } from '../src/core/utils.js'

test('windArrowFromDegrees: 180° apunta arriba y 270° apunta derecha', () => {
  assert.equal(windArrowFromDegrees(180), '↑')
  assert.equal(windArrowFromDegrees(270), '→')
})
