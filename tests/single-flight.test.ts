import test from 'node:test'
import assert from 'node:assert/strict'
import { createSingleFlightRunner } from '../src/core/single-flight.js'

test('single flight skips overlapping runs and allows next run after completion', async () => {
  let executions = 0
  let resolveGate!: () => void
  const gate = new Promise<void>((resolve) => {
    resolveGate = () => resolve()
  })

  const runner = createSingleFlightRunner(async () => {
    executions++
    await gate
  })

  const first = runner()
  const second = await runner()
  assert.equal(second, false)
  assert.equal(executions, 1)

  resolveGate()
  const firstResult = await first
  assert.equal(firstResult, true)

  const third = await runner()
  assert.equal(third, true)
  assert.equal(executions, 2)
})
