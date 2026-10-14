/**
 * Activation-contract tests (acceptance A1/A6/A8 + registration details):
 * drives the real browser half through `apply()` against fake client services
 * and asserts what lands in the slot registry, in the session retention ledger
 * and in local storage.
 *
 * @module tests/registration
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeCtx, createFakeSessions, createFakeSlots, createFakeWindow, createMemoryStorage, loadClientBundle, sessionRow } from './harness.mjs'

const { exports } = loadClientBundle()
const {
  createController,
  createDebugLogger,
  constants: {
    SLOT_MAIN,
    MAIN_PANEL_KEY,
    SLOT_PLUGINS_ITEM,
    SETTINGS_ITEM_ID,
    SLOT_PANE,
    SLOT_ROW_ACTION,
    ROW_ACTION_ID,
    MAIN_CONVERSATION_PRIORITY,
    DEFAULT_MAX_PANES,
    MAX_MAX_PANES,
  },
} = exports.__internals

const quietWarnings = (callback) => {
  const originalWarn = console.warn
  const originalError = console.error
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  console.error = (...args) => warnings.push(args.join(' '))
  try {
    callback()
  } finally {
    console.warn = originalWarn
    console.error = originalError
  }
  return warnings
}

/** Install a fake `globalThis.localStorage` for the duration of one callback. */
const withGlobalStorage = (storage, callback) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const previous = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  try {
    return callback()
  } finally {
    if (had) {
      Object.defineProperty(globalThis, 'localStorage', { value: previous, configurable: true, writable: true })
    } else {
      delete globalThis.localStorage
    }
  }
}

/** Build the standard props a registered component receives from the renderer. */
function slotProps(face, extra = {}) {
  const state = face.hooks.multiChat
  return {
    ...face,
    useMultiChat: (selector) => selector(state.getSnapshot()),
    useSessions: (selector) => selector({ ids: [], byId: {}, phase: 'ready' }),
    useSessionStatus: (selector) => selector(new Map()),
    renderFactorySlot: (name) => ({ type: 'factory', name }),
    SessionProvider: () => null,
    ...extra,
  }
}

test('the plugin declares a static inject array covering the services it uses', () => {
  assert.ok(Array.isArray(exports.inject))
  assert.deepEqual(exports.inject, ['slots', 'sessions'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.name, 'dsh-multi-chat/client')
})

test('a single session stays on the official view (no registration at all)', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({ a: sessionRow('a', { retainedBy: { mainView: 1 } }) })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })

  exports.apply(ctx)

  assert.equal(slots.live(SLOT_MAIN).length, 0, 'the official conversation view is untouched')
  assert.equal(slots.live(SLOT_ROW_ACTION).length, 0, 'no sidebar button without a multi-pane set')
})

test('following a second session mounts the grid; dropping to one unmounts it', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })

  exports.apply(ctx)
  assert.equal(slots.live(SLOT_MAIN).length, 0)

  // Clicking session B in the sidebar makes it the current session.
  sessions.setMain('b')
  const [main] = slots.live(SLOT_MAIN)
  assert.ok(main, 'clicking a second session registers the grid view')
  assert.equal(main.options.name, 'main')
  assert.equal(main.options.key, MAIN_PANEL_KEY, 'the conversation panel cell is the replacement point')
  assert.equal(main.options.priority, MAIN_CONVERSATION_PRIORITY)
  assert.ok(main.options.priority < 0, 'shadowing the official entry requires a lower priority')
  assert.deepEqual(main.options.children, { [SLOT_PANE]: { kind: 'single', scope: 'session' } })
  assert.equal(typeof main.component, 'function')

  // The sidebar row action is incremental: a fresh id, never an official one.
  const [row] = slots.live(SLOT_ROW_ACTION)
  assert.ok(row)
  assert.equal(row.options.id, ROW_ACTION_ID)
  assert.equal(typeof row.options.order, 'number')
  assert.equal(typeof row.options.inject, 'function')
  assert.notEqual(row.options.id, 'archive')
  assert.notEqual(row.options.id, 'pin')

  // Both pane sessions are retained under our own source.
  assert.deepEqual(
    sessions.retainCalls.map((call) => call.id).sort(),
    ['a', 'b'],
  )
  assert.ok(sessions.retainCalls.every((call) => call.source === 'multichat'))

  // Clicking A makes A current again: still two panes, highlight follows.
  sessions.setMain('a')
  assert.equal(slots.live(SLOT_MAIN).length, 1)
  const face = slots.live(SLOT_MAIN)[0].options.inject()
  assert.deepEqual(face.hooks.multiChat.getSnapshot().panes, ['a', 'b'])
  assert.equal(face.hooks.multiChat.getSnapshot().activeId, 'a')

  // Closing B leaves one pane → back to the official single-session view.
  assert.equal(face.closePane('b'), 'closed')
  assert.equal(slots.live(SLOT_MAIN).length, 0)
  assert.deepEqual(sessions.releaseCalls, ['b'])
})

test('clicking three sessions yields three panes and three panes only', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
    c: sessionRow('c'),
  })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
  exports.apply(ctx)

  sessions.setMain('b')
  sessions.setMain('c')
  const face = slots.live(SLOT_MAIN)[0].options.inject()
  assert.deepEqual(face.hooks.multiChat.getSnapshot().panes, ['a', 'b', 'c'])
  assert.equal(face.hooks.multiChat.getSnapshot().activeId, 'c')
  assert.deepEqual(sessions.retainCalls.map((call) => call.id).sort(), ['a', 'b', 'c'])
})

test('debug logger remains silent unless explicitly enabled in local storage', () => {
  const messages = []
  const originalInfo = console.info
  console.info = (...args) => messages.push(args)
  try {
    createDebugLogger(createMemoryStorage())('disabled', { sessionCount: 2 })
    assert.equal(messages.length, 0)

    const storage = createMemoryStorage({ 'dsh-multi-chat:debug': '1' })
    createDebugLogger(storage)('enabled', { sessionCount: 2 })
    assert.equal(messages.length, 1)
    assert.equal(messages[0][0], '[dsh-multi-chat:debug]')
    assert.equal(messages[0][1].event, 'enabled')
    assert.equal(messages[0][1].sessionCount, 2)
  } finally {
    console.info = originalInfo
  }
})

test('opt-in diagnostic logs identify whether session changes mount the grid', () => {
  const logs = []
  const debug = (event, details) => logs.push({ event, details })
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
  const controller = createController({ ctx, slots, sessions, persist: false, debug })

  sessions.setMain('b')

  assert.ok(logs.some((row) => row.event === 'sessions:list' && row.details.sessionCount === 2))
  assert.ok(logs.some((row) => row.event === 'sessions:observe-current'))
  assert.ok(logs.some((row) => row.event === 'slots:registration-check' && row.details.paneCount === 2 && row.details.wanted))
  assert.ok(logs.some((row) => row.event === 'slots:mounted'))
  assert.equal(slots.live(SLOT_MAIN).length, 1)
  controller.dispose()
})

test('the pane ceiling (6 by default, 9 max) is enforced while following the shell', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
  const rows = Object.fromEntries(
    ids.map((id) => [id, sessionRow(id, id === 'a' ? { retainedBy: { mainView: 1 } } : {})]),
  )
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions(rows)
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
  exports.apply(ctx)

  for (const id of ids.slice(1)) sessions.setMain(id)
  const face = slots.live(SLOT_MAIN)[0].options.inject()
  const state = face.hooks.multiChat.getSnapshot()
  assert.equal(state.maxPanes, DEFAULT_MAX_PANES, 'the default ceiling is six (two full rows)')
  assert.equal(state.panes.length, DEFAULT_MAX_PANES)
  assert.equal(state.activeId, 'j')
  assert.ok(state.panes.includes('j'), 'the current session is always visible')
  assert.deepEqual(state.panes, ['e', 'f', 'g', 'h', 'i', 'j'], 'the oldest panes gave way')
  assert.deepEqual(sessions.releaseCalls, ['a', 'b', 'c', 'd'])

  // A raised ceiling fits three full rows.
  face.hooks.multiChat.setMaxPanes(MAX_MAX_PANES)
  sessions.setMain('a')
  sessions.setMain('b')
  assert.equal(face.hooks.multiChat.getSnapshot().panes.length, 8)
})

test('an unknown persisted pane degrades to a notice instead of throwing', () => {
  const storage = createMemoryStorage({
    'dsh-multi-chat:v1': JSON.stringify({ version: 1, panes: ['ghost', 'a'], layout: 'columns', maxPanes: 4 }),
  })
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({ a: sessionRow('a', { retainedBy: { mainView: 1 } }) })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })

  const warnings = quietWarnings(() =>
    withGlobalStorage(storage, () => {
      exports.apply(ctx)
    }),
  )

  assert.ok(warnings.some((line) => line.includes('dropping unavailable pane "ghost"')))
  assert.deepEqual(sessions.retainCalls.map((call) => call.id), ['a'], 'a dead id is never retained')
  assert.equal(slots.live(SLOT_MAIN).length, 0, 'one usable pane → official view')
  const persisted = JSON.parse(storage.getItem('dsh-multi-chat:v1'))
  assert.deepEqual(persisted.panes, ['a'], 'the dead pane is pruned from storage')
  assert.equal(persisted.version, 2)
})

test('the plugin waits for late slot declarations and re-arms on redeclaration', () => {
  const slots = createFakeSlots()
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
  exports.apply(ctx)
  sessions.setMain('b')
  assert.equal(slots.live(SLOT_MAIN).length, 0, 'nothing to register into yet')

  slots.declare(SLOT_MAIN)
  assert.equal(slots.live(SLOT_MAIN).length, 1, 'the pending inject callback runs on declaration')

  slots.collapse(SLOT_MAIN)
  assert.equal(slots.live(SLOT_MAIN).length, 0, 'collapse removes our registration')
  assert.ok(
    slots.registrations.some((record) => record.options.name === SLOT_MAIN && record.disposed),
    'the registration disposer ran',
  )

  slots.declare(SLOT_MAIN)
  const live = slots.live(SLOT_MAIN)
  assert.equal(live.length, 1, 'a new declaration lifetime re-registers')
  assert.equal(live[0].disposed, false)
})

test('disposal releases every reference and removes both contributions', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const { ctx, dispose } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
  exports.apply(ctx)
  sessions.setMain('b')
  assert.equal(slots.live(SLOT_MAIN).length, 1)

  dispose()

  assert.equal(slots.live(SLOT_MAIN).length, 0)
  assert.equal(slots.live(SLOT_ROW_ACTION).length, 0, 'the sidebar button is removed with the plugin')
  assert.deepEqual(sessions.releaseCalls.sort(), ['a', 'b'])
})

test('activation never throws when services are missing or hostile', () => {
  const warnings = quietWarnings(() => {
    const { ctx } = createFakeCtx({})
    exports.apply(ctx)
  })
  assert.ok(warnings.some((line) => line.includes('slots service unavailable')))

  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const hostile = {
    get(name) {
      if (name === 'slots') return slots
      throw new Error(`service ${name} exploded`)
    },
  }
  quietWarnings(() => exports.apply(hostile))
  assert.equal(slots.live(SLOT_MAIN).length, 0)

  const brokenSlots = {
    inject: (key, callback) => {
      callback()
      return () => {}
    },
    register() {
      throw new Error('registration exploded')
    },
  }
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const errors = quietWarnings(() => {
    const { ctx } = createFakeCtx({ slots: brokenSlots, sessions, uiWorkspace: { openSession() {} } })
    exports.apply(ctx)
    sessions.setMain('b')
  })
  assert.ok(errors.some((line) => line.includes('slot registration failed')))
})

test('controller-level: closing the active pane hands over, or refuses without navigation', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const opened = []
  const { ctx } = createFakeCtx({
    slots,
    sessions,
    uiWorkspace: { openSession: (id) => opened.push(id) },
  })
  const controller = createController({ ctx, slots, sessions, storage: createMemoryStorage() })
  sessions.setMain('b')
  assert.deepEqual(controller.store.getSnapshot().panes, ['a', 'b'])
  assert.equal(controller.store.getSnapshot().activeId, 'b')

  assert.equal(controller.canClosePane('b'), true)
  assert.equal(controller.closePane('b'), 'closed')
  assert.deepEqual(opened, ['a'], 'the sibling pane becomes the shell current session first')
  assert.deepEqual(controller.store.getSnapshot().panes, ['a'])
  assert.equal(controller.store.getSnapshot().activeId, 'a')
  sessions.setMain('a')
  assert.deepEqual(controller.store.getSnapshot().panes, ['a'], 'the suppressed follower stays quiet')
  controller.dispose()

  const noNavStorage = createMemoryStorage({
    'dsh-multi-chat:v1': JSON.stringify({ version: 2, panes: ['a', 'b'], maxPanes: 6 }),
  })
  const noNav = createController({
    ctx: createFakeCtx({ slots, sessions }).ctx,
    slots,
    sessions,
    storage: noNavStorage,
  })
  sessions.setMain('b')
  assert.equal(noNav.canClosePane('b'), false)
  assert.equal(noNav.closePane('b'), 'active-locked')
  assert.equal(noNav.canClosePane('a'), true, 'non-active panes stay closable')
  noNav.dispose()
})

test('controller-level: the sidebar button adds a session without switching the current one', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const opened = []
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession: (id) => opened.push(id) } })
  const controller = createController({ ctx, slots, sessions, storage: createMemoryStorage() })

  assert.equal(controller.togglePane('b'), 'opened')
  assert.deepEqual(controller.store.getSnapshot().panes, ['a', 'b'])
  assert.deepEqual(opened, [], 'pinning a session does not navigate')
  assert.equal(controller.store.getSnapshot().activeId, 'a', 'the followed session keeps the highlight')

  assert.equal(controller.togglePane('b'), 'closed')
  assert.deepEqual(controller.store.getSnapshot().panes, ['a'])
  assert.deepEqual(sessions.releaseCalls, ['b'])
  controller.dispose()
})

test('controller-level: reordering keeps references and lets keep-only collapse the grid', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
    c: sessionRow('c'),
  })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
  const controller = createController({ ctx, slots, sessions, storage: createMemoryStorage() })
  sessions.setMain('b')
  sessions.setMain('c')
  assert.deepEqual(controller.store.getSnapshot().panes, ['a', 'b', 'c'])

  assert.equal(controller.swapPanes('a', 'c'), 'swapped')
  assert.deepEqual(controller.store.getSnapshot().panes, ['c', 'b', 'a'])
  assert.deepEqual(sessions.releaseCalls, [], 'reordering never releases a session')
  assert.equal(controller.movePaneToEnd('c'), 'moved')
  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'a', 'c'])

  assert.equal(controller.keepOnlyActive(), 'kept')
  assert.deepEqual(controller.store.getSnapshot().panes, ['c'])
  assert.equal(controller.canClosePane('c'), false)
  assert.equal(controller.getReference('c')?.sessionId, 'c')
  assert.equal(controller.getReference('gone'), undefined)
  controller.dispose()
})

test('controller-level: a host config seed only moves the default ceiling', () => {
  const slots = createFakeSlots()
  const sessions = createFakeSessions({ a: sessionRow('a') })
  const { ctx } = createFakeCtx({ slots, sessions })
  const controller = createController({ ctx, slots, sessions, storage: createMemoryStorage(), maxPanes: 99 })
  assert.equal(controller.store.getSnapshot().maxPanes, MAX_MAX_PANES)
  controller.dispose()
})

test('controller-level: an unretainable persisted pane is dropped with a notice', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const storage = createMemoryStorage({
    'dsh-multi-chat:v1': JSON.stringify({ version: 2, panes: ['a', 'ghost'], maxPanes: 6 }),
  })
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
  const warnings = quietWarnings(() => {
    const controller = createController({ ctx, slots, sessions, storage })
    assert.deepEqual(controller.store.getSnapshot().panes, ['a'], 'the ghost pane is gone')
    assert.deepEqual(controller.store.getSnapshot().notice, { code: 'unknown', sessionId: 'ghost' })
    controller.dispose()
  })
  assert.ok(warnings.some((line) => line.includes('dropping unavailable pane "ghost"')))
  assert.deepEqual(JSON.parse(storage.getItem('dsh-multi-chat:v1')).panes, ['a'])
})

test('the inject face exposes exactly the callbacks the components use', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const { ctx } = createFakeCtx({
    slots,
    sessions,
    uiWorkspace: { openSession() {} },
    locale: { getSnapshot: () => ({ language: 'zh' }) },
  })
  exports.apply(ctx)
  sessions.setMain('b')
  const face = slots.live(SLOT_MAIN)[0].options.inject()
  assert.equal(typeof face.t, 'function')
  assert.equal(face.t('bar.onlyActive'), '只保留当前')
  for (const name of [
    'getReference',
    'focusPane',
    'closePane',
    'canClosePane',
    'togglePane',
    'swapPanes',
    'movePaneToEnd',
    'keepOnlyActive',
  ]) {
    assert.equal(typeof face[name], 'function', `${name} must be exposed`)
  }
  assert.equal(face.swapPanes('a', 'b'), 'swapped')
  assert.deepEqual(face.hooks.multiChat.getSnapshot().panes, ['b', 'a'])
  assert.equal(face.movePaneToEnd('b'), 'moved')
  assert.deepEqual(face.hooks.multiChat.getSnapshot().panes, ['a', 'b'])
})

test('a retention publish inside retain() cannot recurse (stack-overflow regression)', () => {
  // The faithful fake publishes the retention snapshot synchronously from inside
  // `retain`, which re-enters the plugin's list subscription before the reference
  // could be recorded. Before the pending-retain marker + sync guard this
  // overflowed the stack in a real browser ("Maximum call stack size exceeded")
  // and broke session opening, so assert both: one retain per session, and no
  // failure warnings at all.
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
    c: sessionRow('c'),
  })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })

  const warnings = quietWarnings(() => {
    exports.apply(ctx)
    sessions.setMain('b')
    sessions.setMain('c')
  })

  const retained = new Map()
  for (const call of sessions.retainCalls) retained.set(call.id, (retained.get(call.id) ?? 0) + 1)
  assert.deepEqual([...retained.entries()].sort(), [['a', 1], ['b', 1], ['c', 1]])
  assert.deepEqual(
    warnings.filter((line) => /list handling failed|sync failed|call stack|subscriber failed/i.test(line)),
    [],
    'no recursion or listener failure may be reported',
  )
  const face = slots.live(SLOT_MAIN)[0].options.inject()
  assert.deepEqual(face.hooks.multiChat.getSnapshot().panes, ['a', 'b', 'c'])
  assert.equal(face.hooks.multiChat.getSnapshot().activeId, 'c')
})

test('releasing a pane publishes retention without recursing either', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
  const warnings = quietWarnings(() => exports.apply(ctx))
  sessions.setMain('b')
  const face = slots.live(SLOT_MAIN)[0].options.inject()

  const releaseWarnings = quietWarnings(() => {
    assert.equal(face.closePane('a'), 'closed')
  })
  assert.deepEqual(sessions.releaseCalls, ['a'])
  assert.deepEqual(
    [...warnings, ...releaseWarnings].filter((line) => /call stack|sync failed|list handling failed/i.test(line)),
    [],
  )
})

test('a narrow window keeps the official view and touches nothing else', () => {
  // The DSH floating session window is ~490px wide: panes stacked in one column
  // are worse than the normal conversation, so the plugin stays inert there. It
  // must also keep its hands off shared storage, or the floating window would
  // overwrite the pane set the main window owns.
  const fakeWindow = createFakeWindow(490)
  const narrow = loadClientBundle({ globals: { window: fakeWindow } })
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const stored = JSON.stringify({ version: 2, panes: ['a', 'b'], maxPanes: 6 })
  const storage = createMemoryStorage({ 'dsh-multi-chat:v1': stored })

  withGlobalStorage(storage, () => {
    const { ctx, dispose } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
    narrow.exports.apply(ctx)
    sessions.setMain('b')

    assert.equal(slots.live(SLOT_MAIN).length, 0, 'the official conversation view stays in place')
    assert.equal(slots.live(SLOT_ROW_ACTION).length, 0, 'no sidebar affordance either')
    assert.deepEqual(sessions.retainCalls, [], 'no session is held live for panes that are not shown')
    assert.equal(storage.getItem('dsh-multi-chat:v1'), stored, 'shared storage is left untouched')
    assert.equal(fakeWindow.resizeListeners, 1, 'the width transition is still observed')

    // Widening the same window past the threshold brings the grid back.
    fakeWindow.setWidth(1280)
    assert.equal(slots.live(SLOT_MAIN).length, 1, 'the grid comes back')
    assert.deepEqual(sessions.retainCalls.map((call) => call.id).sort(), ['a', 'b'])
    const face = slotProps(slots.live(SLOT_MAIN)[0].options.inject())
    assert.deepEqual(face.hooks.multiChat.getSnapshot().panes, ['a', 'b'])

    // Narrowing again hands the conversation area (and the references) back.
    fakeWindow.setWidth(520)
    assert.equal(slots.live(SLOT_MAIN).length, 0, 'narrowing restores the official view')
    assert.deepEqual(sessions.releaseCalls.sort(), ['a', 'b'])
    assert.equal(storage.getItem('dsh-multi-chat:v1'), stored, 'the stored pane set survives')
    dispose()
  })
})

test('switching the grid off leaves the official view in place but keeps the settings card', () => {
  // The settings card is the only way back on, so it must survive the grid being
  // switched off — and it must not depend on any pane being open either.
  const storage = createMemoryStorage({
    'dsh-multi-chat:grid': 'off',
    'dsh-multi-chat:v1': JSON.stringify({ version: 2, panes: ['a'], maxPanes: 6 }),
  })
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  slots.declare(SLOT_PLUGINS_ITEM)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const { ctx, dispose } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })

  withGlobalStorage(storage, () => {
    exports.apply(ctx)
    const [card] = slots.live(SLOT_PLUGINS_ITEM)
    assert.ok(card, 'the settings card is registered even with the grid off')
    assert.equal(card.options.id, 'multi-chat')
    assert.equal(typeof card.options.label(), 'string')
    const face = card.options.inject()
    assert.equal(face.enabled, false, 'the card reads the stored preference')
    assert.equal(typeof face.setEnabled, 'function')

    sessions.setMain('b')
    assert.equal(slots.live(SLOT_MAIN).length, 0, 'no grid while switched off')
    assert.deepEqual(sessions.retainCalls, [], 'and no session is held live')

    // Switching back on from the card re-adopts the shell's session and mounts
    // the grid for the remembered pane plus it.
    face.setEnabled(true)
    assert.equal(face.enabled, true)
    assert.equal(slots.live(SLOT_MAIN).length, 1, 'the grid comes back')
    assert.deepEqual(sessions.retainCalls.map((call) => call.id).sort(), ['a', 'b'])
    assert.deepEqual(face.hooks.multiChat.getSnapshot().panes, ['a', 'b'])
    assert.equal(slots.live(SLOT_PLUGINS_ITEM).length, 1, 'still exactly one card')

    // ... and off again hands the conversation area back.
    face.setEnabled(false)
    assert.equal(slots.live(SLOT_MAIN).length, 0)
    assert.deepEqual(sessions.releaseCalls.sort(), ['a', 'b'])
    dispose()
  })
})

test('the registered components and the inject face line up', () => {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN)
  slots.declare(SLOT_ROW_ACTION)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const { ctx } = createFakeCtx({ slots, sessions, uiWorkspace: { openSession() {} } })
  exports.apply(ctx)
  sessions.setMain('b')

  const conversation = slots.live(SLOT_MAIN)[0]
  const rowAction = slots.live(SLOT_ROW_ACTION)[0]
  // Components are identity-checked rather than invoked: they are real React
  // components (hooks included) and are rendered in tests/render + tests/interaction.
  assert.equal(conversation.component, exports.__internals.components.MultiChatRoot)
  assert.equal(rowAction.component, exports.__internals.components.SessionRowAction)

  const face = slotProps(conversation.options.inject())
  assert.equal(face.getReference('a')?.sessionId, 'a')
  assert.equal(face.canClosePane('b'), true)
  assert.equal(face.canClosePane('a'), true)
  assert.equal(face.swapPanes('a', 'b'), 'swapped')
  assert.deepEqual(face.hooks.multiChat.getSnapshot().panes, ['b', 'a'])
  assert.equal(face.movePaneToEnd('a'), 'already-last')
})
