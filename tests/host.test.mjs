/**
 * Host-half tests: the node half must load, declare the right name, and never
 * throw (a throwing host apply fails the whole profile boot for a visual
 * feature).
 *
 * @module tests/host
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../lib/index.js'

test('the host half declares its identity and needs no service', () => {
  assert.equal(name, 'dsh-multi-chat')
  assert.ok(Array.isArray(inject))
  assert.deepEqual(inject, [])
  assert.equal(typeof apply, 'function')
})

test('the host half logs once through the optional logger', () => {
  const calls = []
  const ctx = { logger: (namespace) => ({ debug: (message) => calls.push([namespace, message]) }) }
  apply(ctx)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'dsh-multi-chat')
  assert.match(calls[0][1], /browser half/)
})

test('the host half tolerates every degraded context', () => {
  const degraded = [
    undefined,
    {},
    { logger: () => undefined },
    { logger: () => ({}) },
    { logger: () => ({ debug: () => { throw new Error('logger exploded') } }) },
    { logger: () => { throw new Error('logger factory exploded') } },
  ]
  for (const ctx of degraded) {
    assert.doesNotThrow(() => apply(ctx))
  }
})
