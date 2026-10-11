/**
 * Pure view-state tests (acceptance A5 + parts of A3/A6 + the grid reorder
 * contract): the pane ledger decides what "click one → one pane, click three →
 * three panes" means, including the ceiling, the highlight, drag reordering and
 * the persisted restore (with the v1 → v2 migration).
 *
 * @module tests/store
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryStorage, loadClientBundle } from './harness.mjs'

const { exports, globalScope } = loadClientBundle()
const {
  MultiChatStore,
  parsePersisted,
  normalizeMaxPanes,
  keyboardSwapTarget,
  paneIdAtPoint,
  mainSessionIdOf,
  createTranslator,
  constants: { STORAGE_KEY, STORAGE_VERSION, DEFAULT_MAX_PANES, MAX_MAX_PANES, GRID_MAX_COLUMNS },
} = exports.__internals

test('a fresh store is empty, with the default six-cell ceiling', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage() })
  const state = store.getSnapshot()
  assert.deepEqual(state.panes, [])
  assert.equal(state.activeId, undefined)
  assert.equal(state.maxPanes, DEFAULT_MAX_PANES)
  assert.equal(DEFAULT_MAX_PANES, 6)
  assert.equal(MAX_MAX_PANES, 9, 'three full rows of three')
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.panes), 'snapshots are frozen')
})

test('opening sessions yields one pane per session, in click order', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage() })
  assert.equal(store.open('a'), 'opened')
  assert.equal(store.open('b'), 'opened')
  assert.equal(store.open('c'), 'opened')
  assert.equal(store.open('b'), 'exists')
  assert.deepEqual(store.getSnapshot().panes, ['a', 'b', 'c'])
  assert.equal(store.open(''), 'invalid')
  assert.equal(store.open(undefined), 'invalid')
})

test('the pane ceiling refuses explicit opens but replaces the oldest on follow', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage(), maxPanes: 2 })
  store.open('a')
  store.observeActive('a')
  store.open('b')
  assert.equal(store.open('c'), 'limit')
  assert.deepEqual(store.getSnapshot().panes, ['a', 'b'])
  assert.equal(store.getSnapshot().notice.code, 'limit')
  // Following the shell (the user clicked a third session in the sidebar) must
  // still show that session: the oldest pane gives way.
  assert.equal(store.observeActive('c'), 'evicted')
  assert.deepEqual(store.getSnapshot().panes, ['b', 'c'])
  assert.equal(store.getSnapshot().activeId, 'c')
  assert.equal(store.getSnapshot().notice.code, 'evicted')
})

test('the active session is the highlight, and following it keeps membership', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage() })
  store.open('a')
  store.open('b')
  assert.equal(store.observeActive('a'), 'kept')
  assert.equal(store.getSnapshot().activeId, 'a')
  assert.deepEqual(store.getSnapshot().panes, ['a', 'b'])
  assert.equal(store.observeActive(undefined), 'invalid')
})

test('closing refuses to empty the pane set and hands the highlight over', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage() })
  store.open('a')
  assert.equal(store.close('a'), 'last')
  assert.deepEqual(store.getSnapshot().panes, ['a'])
  store.observeActive('a')
  store.open('b')
  store.observeActive('b')
  assert.equal(store.close('b'), 'closed')
  assert.deepEqual(store.getSnapshot().panes, ['a'])
  assert.equal(store.getSnapshot().activeId, 'a', 'the highlight moves to the remaining pane')
  assert.equal(store.close('zzz'), 'missing')
})

test('dropping an unusable pane bypasses the keep-one guard', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage() })
  store.open('ghost')
  assert.equal(store.drop('ghost', { code: 'unknown', sessionId: 'ghost' }), 'dropped')
  assert.deepEqual(store.getSnapshot().panes, [])
  assert.deepEqual(store.getSnapshot().notice, { code: 'unknown', sessionId: 'ghost' })
  assert.equal(store.drop('ghost'), 'missing')
})

test('dragging one pane onto another swaps their grid positions', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage() })
  for (const id of ['a', 'b', 'c', 'd']) store.open(id)
  assert.equal(store.swap('a', 'c'), 'swapped')
  assert.deepEqual(store.getSnapshot().panes, ['c', 'b', 'a', 'd'])
  assert.equal(store.getSnapshot().notice.code, 'moved')
  assert.equal(store.swap('b', 'b'), 'same')
  assert.deepEqual(store.getSnapshot().panes, ['c', 'b', 'a', 'd'])
  assert.equal(store.swap('c', 'ghost'), 'missing')
  assert.equal(store.swap('a', 'd'), 'swapped')
  assert.deepEqual(store.getSnapshot().panes, ['c', 'b', 'd', 'a'])
  assert.equal(store.getSnapshot().activeId, undefined, 'swapping never changes the highlight')
})

test('dropping on empty grid space moves the pane to the end', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage() })
  for (const id of ['a', 'b', 'c']) store.open(id)
  assert.equal(store.moveToEnd('a'), 'moved')
  assert.deepEqual(store.getSnapshot().panes, ['b', 'c', 'a'])
  assert.equal(store.moveToEnd('a'), 'already-last')
  assert.equal(store.moveToEnd('ghost'), 'missing')
})

test('the ceiling trims the oldest panes and keeps the active one', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage(), maxPanes: 9 })
  for (const id of ['a', 'b', 'c', 'd']) store.open(id)
  store.observeActive('d')
  assert.equal(store.setMaxPanes(2), 2)
  assert.deepEqual(store.getSnapshot().panes, ['c', 'd'], 'the active pane survives the trim')
  assert.equal(store.setMaxPanes(99), MAX_MAX_PANES)
  assert.equal(store.setMaxPanes('3'), 3)
  assert.equal(store.keepOnly('d'), 'kept')
  assert.deepEqual(store.getSnapshot().panes, ['d'])
  assert.equal(store.keepOnly('nope'), 'missing')
})

test('snapshots stay identity-stable until something really changes', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage() })
  let notifications = 0
  const unsubscribe = store.subscribe(() => {
    notifications += 1
  })
  const first = store.getSnapshot()
  store.open('a')
  const second = store.getSnapshot()
  assert.notEqual(first, second)
  assert.equal(notifications, 1)
  store.open('a')
  assert.equal(store.getSnapshot(), second, 're-opening an existing pane is a no-op')
  assert.equal(notifications, 1)
  store.observeActive('a')
  assert.notEqual(store.getSnapshot(), second)
  assert.equal(notifications, 2)
  store.observeActive('a')
  assert.equal(notifications, 2, 're-following the same session changes nothing')
  unsubscribe()
  store.open('b')
  assert.equal(notifications, 2, 'unsubscribed listeners stop hearing changes')
})

test('a throwing subscriber cannot break the store', () => {
  const store = new MultiChatStore({ storage: createMemoryStorage() })
  const seen = []
  store.subscribe(() => {
    throw new Error('subscriber exploded')
  })
  store.subscribe(() => seen.push('second'))
  const originalError = console.error
  console.error = () => {}
  try {
    assert.equal(store.open('a'), 'opened')
  } finally {
    console.error = originalError
  }
  assert.deepEqual(seen, ['second'])
})

test('persistence round-trips the pane order and writes the v2 payload', () => {
  const storage = createMemoryStorage()
  const first = new MultiChatStore({ storage })
  first.open('a')
  first.open('b')
  first.open('c')
  first.moveToEnd('a')
  const stored = JSON.parse(storage.getItem(STORAGE_KEY))
  assert.deepEqual(stored, {
    version: STORAGE_VERSION,
    panes: ['b', 'c', 'a'],
    maxPanes: DEFAULT_MAX_PANES,
  })
  assert.equal(stored.layout, undefined, 'the old columns/rows layout is gone')

  const second = new MultiChatStore({ storage })
  second.hydrate()
  assert.deepEqual(second.getSnapshot().panes, ['b', 'c', 'a'], 'the dragged order is restored')
  assert.equal(second.getSnapshot().activeId, undefined, 'the highlight is re-derived from the shell')
})

test('a v1 payload migrates: order and ceiling carry over, layout is dropped', () => {
  const storage = createMemoryStorage({
    [STORAGE_KEY]: JSON.stringify({ version: 1, panes: ['x', 'y', 'x', 7], layout: 'rows', maxPanes: 4 }),
  })
  const store = new MultiChatStore({ storage })
  assert.deepEqual(store.getSnapshot().panes, [])
  store.hydrate()
  assert.deepEqual(store.getSnapshot().panes, ['x', 'y'])
  assert.equal(store.getSnapshot().maxPanes, 4)
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).version, STORAGE_VERSION)
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).layout, undefined)
})

test('persistence survives hostile storage', () => {
  const throwing = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  const store = new MultiChatStore({ storage: throwing })
  store.hydrate()
  assert.deepEqual(store.getSnapshot().panes, [])
  assert.equal(store.open('a'), 'opened')

  const noStorage = new MultiChatStore({ storage: undefined })
  assert.equal(noStorage.open('a'), 'opened')
  assert.equal(noStorage.getSnapshot().panes.length, 1)
})

test('persisted payloads are validated as untrusted input', () => {
  const fallback = { maxPanes: 6 }
  assert.deepEqual(parsePersisted(undefined, fallback), { panes: [], maxPanes: 6 })
  assert.deepEqual(parsePersisted('{oops', fallback), { panes: [], maxPanes: 6 })
  assert.deepEqual(parsePersisted('"text"', fallback), { panes: [], maxPanes: 6 })
  assert.deepEqual(parsePersisted('[1,2]', fallback), { panes: [], maxPanes: 6 })
  assert.deepEqual(parsePersisted('{}', fallback), { panes: [], maxPanes: 6 })
  assert.deepEqual(
    parsePersisted(JSON.stringify({ panes: ['a', 7, 'a', null, 'b'], layout: 'sideways', maxPanes: 42 }), fallback),
    { panes: ['a', 'b'], maxPanes: 9 },
  )
  assert.deepEqual(
    parsePersisted(JSON.stringify({ panes: ['a', 'b', 'c'], maxPanes: 2 }), fallback),
    { panes: ['a', 'b'], maxPanes: 2 },
  )
})

test('normalizeMaxPanes clamps every input shape into 1..9', () => {
  assert.equal(normalizeMaxPanes(undefined), DEFAULT_MAX_PANES)
  assert.equal(normalizeMaxPanes('abc'), DEFAULT_MAX_PANES)
  assert.equal(normalizeMaxPanes(0), 1)
  assert.equal(normalizeMaxPanes(-3), 1)
  assert.equal(normalizeMaxPanes(3.9), 3)
  assert.equal(normalizeMaxPanes(1000), MAX_MAX_PANES)
})

test('the keyboard move helper walks the grid and stops at the edges', () => {
  const order = ['a', 'b', 'c', 'd']
  assert.equal(keyboardSwapTarget(order, 0, 'ArrowRight', 3), 1)
  assert.equal(keyboardSwapTarget(order, 0, 'ArrowLeft', 3), undefined)
  assert.equal(keyboardSwapTarget(order, 0, 'ArrowDown', 3), 3, 'one row down with 3 columns')
  assert.equal(keyboardSwapTarget(order, 3, 'ArrowUp', 3), 0)
  assert.equal(keyboardSwapTarget(order, 3, 'ArrowDown', 3), undefined)
  assert.equal(keyboardSwapTarget(order, 1, 'ArrowDown', 3), undefined)
  assert.equal(keyboardSwapTarget(order, 1, 'Enter', 3), undefined)
  assert.equal(keyboardSwapTarget(order, 1, 'ArrowDown', undefined), undefined, 'no column count → safe no-op')
  assert.equal(keyboardSwapTarget(order, 1, 'ArrowRight', undefined), 2, 'left/right need no column count')
})

test('drop targeting prefers elementFromPoint and falls back to pane rects', () => {
  const elements = new Map([
    ['a', { getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }) }],
    ['b', { getBoundingClientRect: () => ({ left: 100, top: 0, right: 200, bottom: 100 }) }],
  ])
  // No document in this test realm → rect fallback.
  assert.equal(paneIdAtPoint({ x: 150, y: 50 }, 'a', { elements }), 'b')
  assert.equal(paneIdAtPoint({ x: 50, y: 50 }, 'a', { elements }), undefined, 'never targets itself')
  assert.equal(paneIdAtPoint({ x: 500, y: 500 }, 'a', { elements }), undefined, 'empty space')

  // With elementFromPoint available it wins.
  const cell = { closest: () => ({ getAttribute: () => 'b' }) }
  globalScope.document = { elementFromPoint: () => cell }
  try {
    assert.equal(paneIdAtPoint({ x: 999, y: 999 }, 'a', { elements }), 'b')
    assert.equal(paneIdAtPoint({ x: 999, y: 999 }, 'b', { elements }), undefined, 'self-target ignored')
  } finally {
    delete globalScope.document
  }
})

test('the current session is read from mainView retention', () => {
  const row = (mainView) => ({ id: 'x', retainedBy: mainView === undefined ? {} : { mainView } })
  assert.equal(
    mainSessionIdOf({ list: { getSnapshot: () => ({ ids: ['a', 'b'], byId: { a: row(), b: row(1) } }) } }),
    'b',
  )
  assert.equal(
    mainSessionIdOf({ list: { getSnapshot: () => ({ ids: [], byId: { a: row(1) } }) } }),
    'a',
    'falls back to scanning byId when ids is empty',
  )
  assert.equal(mainSessionIdOf({ list: { getSnapshot: () => ({ ids: ['a'], byId: { a: row() } }) } }), undefined)
  assert.equal(mainSessionIdOf({ list: { getSnapshot: () => ({}) } }), undefined)
  assert.equal(mainSessionIdOf({ list: { getSnapshot: () => { throw new Error('nope') } } }), undefined)
  assert.equal(mainSessionIdOf(undefined), undefined)
})

test('the translator follows the locale face, the document and interpolation', () => {
  assert.equal(createTranslator({ getSnapshot: () => ({ language: 'zh-CN' }) })('bar.onlyActive'), '只保留当前')
  assert.equal(createTranslator({ getSnapshot: () => ({ language: 'en-US' }) })('bar.onlyActive'), 'Keep only active')
  const zh = createTranslator({ getSnapshot: () => ({ language: 'zh' }) })
  assert.equal(zh('bar.title', { count: 3 }), '3 个会话并排')
  assert.equal(zh('bar.used', { used: 3, max: 6 }), '已用 3/6 格')
  assert.equal(zh('pane.aria', { index: 2, title: 'T' }), '第 2 格：T')

  // With no usable locale face the shell language wins, then the browser's.
  const broken = createTranslator({ getSnapshot: () => { throw new Error('no locale') } })
  const shadow = (overrides, callback) => {
    const saved = {}
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = Object.getOwnPropertyDescriptor(globalScope, key)
      Object.defineProperty(globalScope, key, { value, configurable: true, writable: true })
    }
    try {
      return callback()
    } finally {
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor === undefined) delete globalScope[key]
        else Object.defineProperty(globalScope, key, descriptor)
      }
    }
  }
  shadow({ document: { documentElement: { getAttribute: () => 'en-GB' } }, navigator: { language: 'zz-ZZ' } }, () => {
    assert.equal(broken('bar.onlyActive'), 'Keep only active', 'the document language is honored')
  })
  shadow({ document: undefined, navigator: { language: 'zh-Hans' } }, () => {
    assert.equal(broken('bar.onlyActive'), '只保留当前', 'the browser language is the last fallback')
  })
  shadow({ document: undefined, navigator: undefined }, () => {
    assert.equal(broken('bar.onlyActive'), 'Keep only active', 'no language at all → English')
  })
  assert.equal(broken('missing.key'), 'missing.key', 'unknown keys fall back to the key')
  assert.equal(GRID_MAX_COLUMNS, 3)
})
