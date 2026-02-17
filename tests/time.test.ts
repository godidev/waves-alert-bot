import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMadridLocalDateTime } from '../src/time.js'

test('parseMadridLocalDateTime convierte hora local de invierno a UTC', () => {
  const parsed = parseMadridLocalDateTime('2026-01-15', '12:00')
  assert.ok(parsed)
  assert.equal(parsed?.toISOString(), '2026-01-15T11:00:00.000Z')
})

test('parseMadridLocalDateTime convierte hora local de verano a UTC', () => {
  const parsed = parseMadridLocalDateTime('2026-07-15', '12:00')
  assert.ok(parsed)
  assert.equal(parsed?.toISOString(), '2026-07-15T10:00:00.000Z')
})

test('parseMadridLocalDateTime devuelve null para hora inexistente en salto DST', () => {
  const parsed = parseMadridLocalDateTime('2026-03-29', '02:30')
  assert.equal(parsed, null)
})
