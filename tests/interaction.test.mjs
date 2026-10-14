/**
 * Real-DOM interaction tests (acceptance A3/A4/A7 + the drag/keyboard reorder
 * contract): renders the registered components with React DOM in jsdom, drives
 * store changes through real hooks, and exercises the actual pointer and
 * keyboard affordances.
 *
 * @module tests/interaction
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Fragment, createElement as h, useSyncExternalStore } from 'react'
import { JSDOM } from 'jsdom'
import { createFakeCtx, createFakeSessions, createFakeSlots, createMemoryStorage, loadClientBundle, sessionRow } from './harness.mjs'

const { exports } = loadClientBundle()
const {
  createController,
  components: { MultiChatRoot, SessionRowAction, MultiChatPane },
  constants: { SLOT_MAIN_CONVERSATION, SLOT_ROW_ACTION },
} = exports.__internals

// --- jsdom bootstrap (before react-dom is imported) -------------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
} catch {
  /* Node's navigator global may be non-configurable; the shell one is unused here. */
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createRoot } = await import('react-dom/client')
const { act } = await import('react')

const fire = async (element, type, init = {}) => {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
  })
}
const click = (element) => fire(element, 'click')
const pointerDown = (element, init) => fire(element, 'pointerdown', init)
const pointerMove = (element, init) => fire(element, 'pointermove', init)
const pointerUp = (element, init) => fire(element, 'pointerup', init)
const keyDown = async (element, init) => {
  await act(async () => {
    element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

/**
 * Build renderer-equivalent props for the occupant, with real observable hooks
 * bound to the given store. `SessionProvider` mirrors production: no DOM, just
 * the scope binding + children.
 */
function rootProps(controller, options = {}) {
  const store = controller.store
  const rows = options.rows ?? {}
  const status = options.status ?? new Map()
  return {
    useMultiChat: (selector) =>
      useSyncExternalStore(
        (listener) => store.subscribe(listener),
        () => selector(store.getSnapshot()),
        () => selector(store.getSnapshot()),
      ),
    useSessions: (selector) => selector({ ids: Object.keys(rows), byId: rows, phase: 'ready' }),
    useSessionStatus: (selector) => selector(status),
    renderFactorySlot: (name, props) =>
      h('div', { 'data-factory': name, 'data-variant': props.variant, 'data-phase': props.phase }),
    SessionProvider:
      options.SessionProvider ?? (({ children }) => h(Fragment, null, children ?? null)),
    getReference: (id) => controller.getReference(id),
    focusPane: (id) => controller.focusPane(id),
    closePane: (id) => controller.closePane(id),
    swapPanes: (left, right) => controller.swapPanes(left, right),
    movePaneToEnd: (id) => controller.movePaneToEnd(id),
    keepOnlyActive: () => controller.keepOnlyActive(),
    setEnabled: (value) => controller.setEnabled(value),
    canClosePane: (id) => controller.canClosePane(id),
    t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
  }
}

/** Mount one element and hand back the container plus a teardown. */
async function mount(element) {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return {
    container,
    /** @returns every element matching the selector. */
    queryAll: (selector) => [...container.querySelectorAll(selector)],
    /** @returns one element matching the selector. */
    query: (selector) => container.querySelector(selector),
    /** Lay the panes out as a deterministic 3-column grid for hit testing. */
    stubPaneRects(width = 400, height = 500) {
      this.queryAll('section.dsh-mc-pane').forEach((pane, index) => {
        const left = (index % 3) * width
        const top = Math.floor(index / 3) * height
        Object.defineProperty(pane, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top }),
        })
      })
    },
    paneFor: (sessionId) => container.querySelector(`section.dsh-mc-pane[data-mc-session="${sessionId}"]`),
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

/** A controller over the given sessions, ready to render. */
function makeController(ids, options = {}) {
  const slots = createFakeSlots()
  slots.declare(SLOT_MAIN_CONVERSATION)
  slots.declare(SLOT_ROW_ACTION)
  const rows = Object.fromEntries(
    ids.map((id) => [id, sessionRow(id, id === ids[0] ? { retainedBy: { mainView: 1 } } : {})]),
  )
  const sessions = createFakeSessions(rows)
  const opened = []
  const { ctx } = createFakeCtx({
    slots,
    sessions,
    ...(options.navigate === false ? {} : { uiWorkspace: { openSession: (id) => opened.push(id) } }),
  })
  const controller = createController({
    ctx,
    slots,
    sessions,
    storage: createMemoryStorage(),
    localeFace: { getSnapshot: () => ({ language: 'en' }) },
  })
  return { controller, sessions, slots, opened, rows, dispose: () => controller.dispose() }
}

test('clicking a non-active pane close button removes that pane from the DOM', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b', 'c'])
  sessions.setMain('b')
  sessions.setMain('c')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  assert.equal(view.queryAll('section.dsh-mc-pane').length, 3)

  const paneA = view.paneFor('a')
  await click(paneA.querySelector('button.dsh-mc-pane-close'))

  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'c'])
  assert.equal(view.queryAll('section.dsh-mc-pane').length, 2)
  assert.ok(view.paneFor('a') === null, 'the closed pane left the DOM')
  const active = view.queryAll('section.dsh-mc-pane[data-active]')
  assert.equal(active.length, 1)
  assert.equal(active[0].dataset.mcSession, 'c')

  await view.unmount()
  dispose()
})

test('clicking or focusing inside an inactive pane activates it without stealing the press', async () => {
  const { controller, sessions, rows, opened, dispose } = makeController(['a', 'b'])
  sessions.setMain('b')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))

  // A press alone must NOT navigate: the browser's own focus handling for the
  // clicked element has to run first (clicking straight into a composer used to
  // need a second click because the shell switch invalidated the focused node).
  await pointerDown(view.paneFor('a').querySelector('.dsh-mc-pane-body'))
  assert.deepEqual(opened, [], 'pointerdown must not navigate')

  // Focus is what activates the pane (e.g. the composer receiving focus).
  await act(async () => {
    view.paneFor('a').querySelector('.dsh-mc-pane-body').dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
  })
  assert.deepEqual(opened, ['a'], 'focusing inside the pane makes it current')

  // A plain click on non-focusable content also activates it.
  opened.length = 0
  await click(view.paneFor('a').querySelector('.dsh-mc-pane-body'))
  assert.deepEqual(opened, ['a'], 'clicking pane content makes it current')

  // The already-active pane never re-navigates.
  await act(async () => {
    view.paneFor('b').querySelector('.dsh-mc-pane-body').dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
  })
  await click(view.paneFor('b').querySelector('.dsh-mc-pane-body'))
  assert.deepEqual(opened, ['a'], 'the active pane issues no navigation')

  await view.unmount()
  dispose()
})

test('the composer keeps the focus it was clicked with (no activation on pointerdown)', async () => {
  const { controller, sessions, rows, opened, dispose } = makeController(['a', 'b'])
  sessions.setMain('b')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  const pane = view.paneFor('a')
  const input = dom.window.document.createElement('input')
  pane.querySelector('.dsh-mc-pane-body').appendChild(input)

  // Simulate the browser order: pointerdown → focus (jsdom fires focusin too).
  await pointerDown(input)
  await act(async () => {
    input.focus()
  })

  assert.equal(dom.window.document.activeElement, input, 'the clicked input still owns the focus')
  assert.deepEqual(opened, ['a'], 'and the pane became current')
  input.remove()
  await view.unmount()
  dispose()
})

test('closing the active pane hands over to a sibling; without navigation it is disabled', async () => {
  const first = makeController(['a', 'b'])
  first.sessions.setMain('b')
  const view = await mount(h(MultiChatRoot, rootProps(first.controller, { rows: first.rows })))
  const activeClose = view.paneFor('b').querySelector('button.dsh-mc-pane-close')
  assert.equal(activeClose.disabled, false)
  await click(activeClose)
  assert.deepEqual(first.opened, ['a'], 'the sibling is focused first')
  assert.deepEqual(first.controller.store.getSnapshot().panes, ['a'])
  await view.unmount()
  first.dispose()

  const second = makeController(['a', 'b'], { navigate: false })
  second.sessions.setMain('b')
  const noNavView = await mount(h(MultiChatRoot, rootProps(second.controller, { rows: second.rows })))
  const lockedClose = noNavView.paneFor('b').querySelector('button.dsh-mc-pane-close')
  assert.equal(lockedClose.disabled, true)
  await click(lockedClose)
  assert.deepEqual(second.controller.store.getSnapshot().panes, ['a', 'b'], 'nothing changed')
  await noNavView.unmount()
  second.dispose()
})

test('the sidebar row button adds and removes a pane without navigating', async () => {
  const { controller, sessions, opened, slots, dispose } = makeController(['a', 'b'])
  sessions.setMain('b')
  const store = controller.store
  const props = {
    sessionId: 'a',
    displayTitle: 'Session a',
    useMultiChat: (selector) =>
      useSyncExternalStore(
        (listener) => store.subscribe(listener),
        () => selector(store.getSnapshot()),
        () => selector(store.getSnapshot()),
      ),
    togglePane: (id) => controller.togglePane(id),
    t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
  }
  const view = await mount(h(SessionRowAction, props))
  const button = view.query('button.dsh-mc-rowbtn')
  assert.equal(button.dataset.open, '')
  assert.equal(button.getAttribute('aria-pressed'), 'true')

  await click(button)
  assert.deepEqual(controller.store.getSnapshot().panes, ['b'])
  assert.deepEqual(opened, [], 'the toggle never navigates')
  assert.equal(view.query('button.dsh-mc-rowbtn').dataset.open, undefined)

  await click(view.query('button.dsh-mc-rowbtn'))
  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'a'], 'the reopened pane is appended last')
  assert.equal(view.query('.dsh-mc-rowidx').textContent, '2')

  await view.unmount()
  assert.equal(slots.live(SLOT_ROW_ACTION).length, 1, 'the registration is owned by the controller, not the view')
  dispose()
})

test('dragging a pane handle onto another pane swaps the two panes', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b', 'c'])
  sessions.setMain('b')
  sessions.setMain('c')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  view.stubPaneRects()

  const paneA = view.paneFor('a')
  const handleA = paneA.querySelector('button.dsh-mc-handle')
  // The handle grabs immediately (no threshold, no long press) — Q12.
  await pointerDown(handleA, { clientX: 10, clientY: 10, button: 0 })
  assert.ok(view.query('[data-mc-ghost]') !== null, 'the ghost appears as soon as the handle is grabbed')
  assert.equal(paneA.dataset.dragging, '', 'the dragged pane is marked')

  await pointerMove(paneA, { clientX: 420, clientY: 120 })
  assert.ok(view.query('[data-mc-ghost]') !== null, 'the ghost follows the pointer')
  assert.equal(view.paneFor('b').dataset.dropTarget, '', 'the hovered pane is the drop target')

  await pointerUp(paneA, { clientX: 420, clientY: 120 })
  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'a', 'c'])
  assert.ok(view.query('[data-mc-ghost]') === null, 'the ghost is gone after the drop')
  assert.equal(view.paneFor('b').dataset.dropTarget, undefined)
  assert.equal(view.queryAll('section.dsh-mc-pane[data-dragging]').length, 0)
  assert.equal(view.queryAll('section.dsh-mc-pane[data-active]')[0].dataset.mcSession, 'c', 'highlight untouched')

  await view.unmount()
  dispose()
})

test('dropping a pane on empty grid space moves it to the end', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b', 'c'])
  sessions.setMain('b')
  sessions.setMain('c')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  view.stubPaneRects()

  const paneA = view.paneFor('a')
  await pointerDown(paneA.querySelector('button.dsh-mc-handle'), { clientX: 10, clientY: 10, button: 0 })
  await pointerMove(paneA, { clientX: 5000, clientY: 5000 })
  assert.equal(view.queryAll('section.dsh-mc-pane[data-drop-target]').length, 0, 'no pane is hovered')
  await pointerUp(paneA, { clientX: 5000, clientY: 5000 })

  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'c', 'a'])
  await view.unmount()
  dispose()
})

test('Escape cancels an in-flight drag', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b'])
  sessions.setMain('b')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  view.stubPaneRects()

  const paneA = view.paneFor('a')
  await pointerDown(paneA.querySelector('button.dsh-mc-handle'), { clientX: 10, clientY: 10, button: 0 })
  await pointerMove(paneA, { clientX: 420, clientY: 120 })
  assert.ok(view.query('[data-mc-ghost]') !== null, 'the ghost is live')

  await keyDown(dom.window, { key: 'Escape' })
  assert.ok(view.query('[data-mc-ghost]') === null, 'the ghost is dropped on cancel')
  assert.equal(view.queryAll('section.dsh-mc-pane[data-dragging]').length, 0)

  await pointerUp(paneA, { clientX: 420, clientY: 120 })
  assert.deepEqual(controller.store.getSnapshot().panes, ['a', 'b'], 'the order is unchanged')
  await view.unmount()
  dispose()
})

test('Ctrl+arrow on a focused handle swaps with the neighbouring pane', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b', 'c'])
  sessions.setMain('b')
  sessions.setMain('c')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))

  const handleA = view.paneFor('a').querySelector('button.dsh-mc-handle')
  await keyDown(handleA, { key: 'ArrowRight', ctrlKey: true })
  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'a', 'c'])

  // Arrow keys without the modifier are left to the browser (no reorder).
  await keyDown(view.paneFor('a').querySelector('button.dsh-mc-handle'), { key: 'ArrowRight' })
  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'a', 'c'])

  // A move past the edge is a no-op.
  await keyDown(view.paneFor('b').querySelector('button.dsh-mc-handle'), { key: 'ArrowLeft', ctrlKey: true })
  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'a', 'c'])

  await view.unmount()
  dispose()
})

test('a header press only becomes a drag after the pointer travels', async () => {
  const { controller, sessions, rows, opened, dispose } = makeController(['a', 'b'])
  sessions.setMain('b')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  view.stubPaneRects()

  const paneA = view.paneFor('a')
  const header = paneA.querySelector('[data-mc-head]')
  const title = paneA.querySelector('.dsh-mc-pane-title')

  // Press + tiny move + release: a click, not a drag → nothing happens on the
  // press itself; focusing the header is what activates the pane.
  await pointerDown(title, { clientX: 200, clientY: 20, button: 0 })
  await pointerMove(paneA, { clientX: 202, clientY: 21 })
  assert.ok(view.query('[data-mc-ghost]') === null, 'below the 4px threshold nothing starts')
  await pointerUp(paneA, { clientX: 202, clientY: 21 })
  assert.deepEqual(controller.store.getSnapshot().panes, ['a', 'b'])
  assert.deepEqual(opened, [], 'a sub-threshold header press does nothing by itself')
  await act(async () => {
    header.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
  })
  assert.deepEqual(opened, ['a'], 'focusing the header activates the pane')

  // Press + travel + release over the sibling: a real drag → swap.
  await pointerDown(title, { clientX: 200, clientY: 20, button: 0 })
  await pointerMove(paneA, { clientX: 240, clientY: 30 })
  assert.equal(paneA.dataset.dragging, '', 'the threshold turns the press into a drag')
  await pointerMove(paneA, { clientX: 460, clientY: 120 })
  await pointerUp(paneA, { clientX: 460, clientY: 120 })
  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'a'])

  await view.unmount()
  dispose()
})

test('a pointer released outside the panes cannot strand a drag', async () => {
  // Regression: pane-level pointer handlers alone never saw a `pointerup` that
  // happened outside the grid, so the ghost card and the drop ring stayed behind
  // and the next move over a pane started a phantom drag.
  const { controller, sessions, rows, dispose } = makeController(['a', 'b', 'c'])
  sessions.setMain('b')
  sessions.setMain('c')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  view.stubPaneRects()

  const paneA = view.paneFor('a')
  await pointerDown(paneA.querySelector('button.dsh-mc-handle'), { clientX: 10, clientY: 10, button: 0 })
  await pointerMove(paneA, { clientX: 420, clientY: 120 })
  assert.equal(view.paneFor('b').dataset.dropTarget, '', 'the sibling became the target')

  // Release far away, over the sidebar, not on any pane.
  await fire(dom.window, 'pointerup', { clientX: 120, clientY: 400 })
  assert.ok(view.query('[data-mc-ghost]') === null, 'the ghost is gone')
  assert.equal(view.queryAll('section.dsh-mc-pane[data-dragging]').length, 0)
  assert.equal(view.queryAll('section.dsh-mc-pane[data-drop-target]').length, 0)
  assert.deepEqual(controller.store.getSnapshot().panes, ['b', 'a', 'c'], 'the drop still committed the swap')

  // A later move over a pane must not start a phantom drag from the stale press.
  await pointerMove(paneA, { clientX: 460, clientY: 140 })
  assert.ok(view.query('[data-mc-ghost]') === null, 'no phantom drag')
  assert.equal(view.queryAll('section.dsh-mc-pane[data-dragging]').length, 0)

  await view.unmount()
  dispose()
})

test('a header press released outside neither drags nor strands state', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b'])
  sessions.setMain('b')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  view.stubPaneRects()

  const paneA = view.paneFor('a')
  await pointerDown(paneA.querySelector('.dsh-mc-pane-title'), { clientX: 200, clientY: 20, button: 0 })
  await pointerMove(paneA, { clientX: 202, clientY: 21 })
  await fire(dom.window, 'pointerup', { clientX: 130, clientY: 420 })

  assert.ok(view.query('[data-mc-ghost]') === null, 'a sub-threshold press never mounted a ghost')
  assert.equal(view.queryAll('section.dsh-mc-pane[data-dragging]').length, 0)
  assert.deepEqual(controller.store.getSnapshot().panes, ['a', 'b'], 'the order is untouched')

  // …and the next pointermove over a pane stays inert.
  await pointerMove(paneA, { clientX: 300, clientY: 60 })
  assert.equal(view.queryAll('section.dsh-mc-pane[data-dragging]').length, 0)
  assert.equal(view.queryAll('section.dsh-mc-pane[data-drop-target]').length, 0)

  await view.unmount()
  dispose()
})

test('a second press while a press is pending resets the first one', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b', 'c'])
  sessions.setMain('b')
  sessions.setMain('c')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  view.stubPaneRects()

  const paneA = view.paneFor('a')
  const handleA = paneA.querySelector('button.dsh-mc-handle')
  await pointerDown(handleA, { clientX: 10, clientY: 10, button: 0 })
  // A second press (never released) must reset the first, not stack on it.
  await pointerDown(view.paneFor('b').querySelector('button.dsh-mc-handle'), { clientX: 420, clientY: 30, button: 0 })
  assert.equal(view.queryAll('section.dsh-mc-pane[data-dragging]').length, 1, 'only the newest press drags')
  assert.equal(view.paneFor('b').dataset.dragging, '')

  await fire(dom.window, 'pointerup', { clientX: 420, clientY: 30 })
  assert.equal(view.queryAll('section.dsh-mc-pane[data-dragging]').length, 0)

  await view.unmount()
  dispose()
})

test('a pane that throws is contained while its siblings keep rendering', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b', 'c'])
  sessions.setMain('b')
  sessions.setMain('c')
  const Boom = () => {
    throw new Error('pane exploded')
  }
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const view = await mount(
      h(
        MultiChatRoot,
        rootProps(controller, {
          rows,
          SessionProvider: ({ session, children }) =>
            session?.sessionId === 'b' ? h(Boom, null) : h(Fragment, null, children ?? null),
        }),
      ),
    )
    assert.equal(view.queryAll('section.dsh-mc-pane[data-error]').length, 1)
    assert.equal(view.query('section.dsh-mc-pane[data-error]').dataset.mcSession, 'b')
    assert.equal(view.queryAll('section.dsh-mc-pane').length, 3, 'the grid survives one broken pane')
    assert.equal(view.queryAll('section.dsh-mc-pane[data-active]')[0].dataset.mcSession, 'c')
    assert.ok(errors.some((line) => line.includes('pane "b" crashed')))
    await view.unmount()
  } finally {
    console.error = originalError
  }
  dispose()
})

test('toolbar keep-only leaves the enabled preference on and clicking another session rebuilds the grid', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b', 'c'])
  sessions.setMain('b')
  sessions.setMain('c')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  // The bar carries two actions now (exit grid, keep only active): pick the
  // keep-only one by its label rather than by position.
  const keepButton = view
    .queryAll('button.dsh-mc-bar-btn')
    .find((button) => /bar\.onlyActive/.test(button.textContent ?? ''))
  assert.ok(keepButton, 'the keep-only-active action is present')

  await click(keepButton)
  assert.deepEqual(controller.store.getSnapshot().panes, ['c'])
  assert.equal(view.queryAll('section.dsh-mc-pane').length, 1)
  assert.equal(controller.store.getSnapshot().enabled, true, 'keep-only changes pane membership, not the grid preference')

  sessions.setMain('a')
  assert.deepEqual(controller.store.getSnapshot().panes, ['c', 'a'])
  assert.equal(controller.debug.isRegistered(), true, 'the next session click restores the multi-pane grid')

  await view.unmount()
  dispose()
})

test('the toolbar exit action switches the grid off and the store remembers it', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b'])
  sessions.setMain('b')
  const view = await mount(h(MultiChatRoot, rootProps(controller, { rows })))
  const exitButton = view
    .queryAll('button.dsh-mc-bar-btn')
    .find((button) => /bar\.exit/.test(button.textContent ?? ''))
  assert.ok(exitButton, 'the exit action is present')

  await click(exitButton)
  assert.equal(controller.store.getSnapshot().enabled, false, 'the preference flips off')
  assert.equal(controller.debug.isRegistered(), false, 'and the official view takes the area back')

  // Switching back on restores the grid from the remembered panes.
  controller.setEnabled(true)
  assert.equal(controller.store.getSnapshot().enabled, true)
  assert.equal(controller.debug.isRegistered(), true)

  await view.unmount()
  dispose()
})

test('an unavailable session renders the note card and never binds a provider', async () => {
  const { controller, sessions, rows, dispose } = makeController(['a', 'b'])
  sessions.setMain('b')
  const props = rootProps(controller, { rows })
  const stable = props.getReference
  props.getReference = (id) => (id === 'b' ? undefined : stable(id))
  const view = await mount(h(MultiChatRoot, props))
  assert.equal(view.queryAll('[data-factory]').length, 1)
  assert.equal(view.queryAll('.dsh-mc-pane-note').length, 1)
  assert.match(view.query('.dsh-mc-pane-note').textContent, /pane\.unavailable/)
  await view.unmount()
  dispose()
})

test('the pane components are exported for direct mounting', () => {
  // React.memo returns an exotic object, not a function.
  assert.ok(MultiChatPane !== undefined && MultiChatPane !== null, 'MultiChatPane is exported')
  assert.equal(typeof SessionRowAction, 'function')
})
