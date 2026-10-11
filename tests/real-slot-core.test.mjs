/**
 * Real-registry contract tests.
 *
 * The other suites drive the plugin through a faithful *fake* slot service.
 * This one drives it through `@deepseek-ai/dsh-client-ui-slots` — the exact
 * SlotCore implementation the shipped desktop app bundles — using a thin
 * adapter that mirrors the service's documented `inject`/`register` contract.
 * It therefore verifies the load-bearing claims of the design against the real
 * implementation:
 *
 *   - a lower `priority` shadows the official `main.conversation` occupant;
 *   - declaring `multichat.pane` (a fresh key) makes it live and is refused for
 *     an already-declared key (why `conversation.session` cannot be reused);
 *   - collapsing the declaration hands the cell back and folds the child slot;
 *   - the sidebar row action is an incremental `list` cell beside official ids.
 *
 * @module tests/real-slot-core
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createFakeSessions, createMemoryStorage, loadClientBundle, sessionRow } from './harness.mjs'

const { exports } = loadClientBundle()
const {
  createController,
  components: { MultiChatRoot, SessionRowAction },
  constants: {
    SLOT_MAIN,
    MAIN_PANEL_KEY,
    SLOT_PANE,
    SLOT_ROW_ACTION,
    ROW_ACTION_ID,
    MAIN_CONVERSATION_PRIORITY,
  },
} = exports.__internals

const component = () => null

/**
 * Build the real composition: `root` → `main` (keyed) with the official
 * conversation panel occupying the `conversation` cell at priority 0 (which in
 * turn declares `main.conversation`), plus the sidebar row-action list with the
 * official `archive` cell.
 *
 * The plugin replaces the *panel cell*, not the session-maybe child, so this is
 * the composition its registration has to win.
 */
function createComposition() {
  const core = new SlotCore()
  const disposers = {
    root: core.register(
      {
        name: 'root',
        children: {
          main: { kind: 'keyed', scope: 'root' },
          'sidebar.workspaces': { kind: 'single', scope: 'root' },
        },
      },
      component,
    ),
    officialConversation: core.register(
      {
        name: SLOT_MAIN,
        key: MAIN_PANEL_KEY,
        children: {
          'main.conversation': { kind: 'single', scope: 'session-maybe' },
          'conversation.session': { kind: 'single', scope: 'session' },
        },
      },
      component,
    ),
    sidebar: core.register(
      {
        name: 'sidebar.workspaces',
        children: { [SLOT_ROW_ACTION]: { kind: 'list', scope: 'root' } },
      },
      component,
    ),
    officialRowAction: core.register({ name: SLOT_ROW_ACTION, id: 'archive', order: 100 }, component),
  }
  return { core, disposers }
}

/**
 * A slot service over a real SlotCore, mirroring the documented lifetime
 * contract: the callback runs as soon as the key is declared, is disposed on
 * collapse, and re-runs on the next declaration.
 */
function createRealSlots(core) {
  const registrations = []
  return {
    registrations,
    inject(key, callback) {
      let dispose
      const activate = () => {
        if (dispose !== undefined) return
        dispose = callback() ?? (() => {})
      }
      const deactivate = () => {
        const current = dispose
        dispose = undefined
        current?.()
      }
      if (core.specDynamic(key) !== undefined) activate()
      const off = core.subscribeDeclaration(key, () => {
        if (core.specDynamic(key) !== undefined) activate()
        else deactivate()
      })
      return () => {
        off()
        deactivate()
      }
    },
    register(options, registeredComponent) {
      registrations.push({ options, component: registeredComponent })
      return core.register(options, registeredComponent)
    },
  }
}

test('a lower priority shadows the official conversation panel cell', () => {
  const { core } = createComposition()
  const official = core.entriesOfSlot(SLOT_MAIN)
  assert.equal(official.length, 1, 'the official entry is the only occupant of the cell')
  assert.equal(official[0].component, component)

  // The same keyed cell at the same priority must throw (the documented reason a
  // replacement needs its own priority).
  assert.throws(
    () => core.register({ name: SLOT_MAIN, key: MAIN_PANEL_KEY }, component),
    /already has an entry for key "conversation"/u,
  )

  const dispose = core.register(
    { name: SLOT_MAIN, key: MAIN_PANEL_KEY, priority: MAIN_CONVERSATION_PRIORITY },
    MultiChatRoot,
  )
  const winners = core.entriesOfSlot(SLOT_MAIN)
  assert.equal(winners.length, 1)
  assert.equal(winners[0].component, MultiChatRoot, 'the lower priority renders')
  assert.equal(winners[0].options.key, MAIN_PANEL_KEY)

  // Disposal hands the cell back to the official entry.
  dispose()
  assert.equal(core.entriesOfSlot(SLOT_MAIN)[0].component, component)
})

test('the grid lives in a root-scope cell so session switches cannot remount it', () => {
  const { core } = createComposition()
  // Root scope is the contract that matters for the reported bugs: a
  // session-maybe entry is remounted by the renderer whenever the shell switches
  // to a different session, which used to rebuild every pane's conversation (the
  // lag) and drop the focus of the composer the user had just clicked.
  assert.equal(core.spec(SLOT_MAIN).scope, 'root')
  assert.equal(core.spec(SLOT_MAIN).kind, 'keyed')
})

test('a fresh child key is required: reusing an official key is refused', () => {
  const { core } = createComposition()
  assert.throws(
    () =>
      core.register(
        {
          name: SLOT_MAIN,
          key: MAIN_PANEL_KEY,
          priority: MAIN_CONVERSATION_PRIORITY,
          children: { 'conversation.session': { kind: 'single', scope: 'session' } },
        },
        MultiChatRoot,
      ),
    /already declared/u,
    'that is exactly why the plugin declares its own multichat.pane key',
  )
})

test('declaring the pane child makes it live and folds it on disposal', () => {
  const { core } = createComposition()
  assert.equal(core.specDynamic(SLOT_PANE), undefined)
  const dispose = core.register(
    {
      name: SLOT_MAIN,
      key: MAIN_PANEL_KEY,
      priority: MAIN_CONVERSATION_PRIORITY,
      children: { [SLOT_PANE]: { kind: 'single', scope: 'session' } },
    },
    MultiChatRoot,
  )
  assert.deepEqual(core.specDynamic(SLOT_PANE), { kind: 'single', scope: 'session' })
  assert.ok(JSON.stringify(core.snapshot('root')).includes(SLOT_PANE), 'the declared child appears in the topology')

  dispose()
  assert.equal(core.specDynamic(SLOT_PANE), undefined, 'collapse folds the declared child')
})

test('the sidebar action is an incremental list cell beside the official one', () => {
  const { core } = createComposition()
  core.register({ name: SLOT_ROW_ACTION, id: ROW_ACTION_ID, order: 150 }, SessionRowAction)
  const cells = core.entriesOfSlot(SLOT_ROW_ACTION).map((entry) => entry.options.id)
  assert.deepEqual(cells.sort(), ['archive', ROW_ACTION_ID].sort())
  assert.equal(core.entries(SLOT_ROW_ACTION).length, 2, 'the official cell is untouched')
})

test('the real controller lands as the winner and collapses on dispose', () => {
  const { core } = createComposition()
  const slots = createRealSlots(core)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const effects = []
  const ctx = {
    get: (name) => (name === 'slots' ? slots : name === 'sessions' ? sessions : undefined),
    effect: (callback) => {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
  }

  const controller = createController({ ctx, slots, sessions, storage: createMemoryStorage() })
  assert.equal(core.entriesOfSlot(SLOT_MAIN)[0].component, component, 'single session → official view')

  sessions.setMain('b')
  const winners = core.entriesOfSlot(SLOT_MAIN)
  assert.equal(winners[0].component, MultiChatRoot)
  assert.equal(winners[0].options.priority, MAIN_CONVERSATION_PRIORITY)
  assert.equal(winners[0].options.key, MAIN_PANEL_KEY)
  assert.deepEqual(core.specDynamic(SLOT_PANE), { kind: 'single', scope: 'session' })
  assert.equal(
    core.entriesOfSlot(SLOT_ROW_ACTION).some((entry) => entry.options.id === ROW_ACTION_ID),
    true,
  )
  assert.equal(controller.debug.isRegistered(), true)

  // Dropping back to a single pane restores the official conversation view.
  assert.equal(controller.closePane('a'), 'closed')
  assert.equal(core.entriesOfSlot(SLOT_MAIN)[0].component, component)
  assert.equal(core.specDynamic(SLOT_PANE), undefined)
  assert.equal(controller.debug.isRegistered(), false)

  controller.dispose()
  assert.equal(sessions.releaseCalls.includes('b'), true, 'no session reference is leaked')
})

test('a real declaration collapse after the fact re-arms the plugin', () => {
  const core = new SlotCore()
  const slots = createRealSlots(core)
  const sessions = createFakeSessions({
    a: sessionRow('a', { retainedBy: { mainView: 1 } }),
    b: sessionRow('b'),
  })
  const ctx = {
    get: (name) => (name === 'slots' ? slots : name === 'sessions' ? sessions : undefined),
    effect: () => () => {},
  }
  const controller = createController({ ctx, slots, sessions, storage: createMemoryStorage() })
  sessions.setMain('b')
  assert.equal(controller.debug.isRegistered(), true)
  assert.equal(core.entriesOfSlot(SLOT_MAIN).length, 0, 'the slot is not declared yet')

  const rootDispose = core.register(
    {
      name: 'root',
      children: { main: { kind: 'keyed', scope: 'root' } },
    },
    component,
  )
  assert.equal(core.entriesOfSlot(SLOT_MAIN).length, 1)
  assert.equal(core.entriesOfSlot(SLOT_MAIN)[0].component, MultiChatRoot)

  rootDispose()
  assert.equal(core.entriesOfSlot(SLOT_MAIN).length, 0, 'collapse removed the contribution')
  controller.dispose()
})
