/**
 * Structural rendering tests (acceptance A1/A2/A7 + the style red lines):
 * the registered conversation occupant renders an equal-cell grid with one pane
 * per session, highlights the active one, binds each pane to its own session,
 * embeds the official conversation body in the variant that keeps the composer
 * sticky, and keeps the stylesheet inside the documented token system.
 *
 * @module tests/render
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Fragment, createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadClientBundle } from './harness.mjs'

const { exports } = loadClientBundle()
const {
  components: { MultiChatRoot, MultiChatBar, MultiChatPane, PaneBoundary, DragGhost },
  CSS,
  STYLE_TAG_ID,
  injectStyles,
  constants: { CONVERSATION_VARIANT, GRID_MAX_COLUMNS },
} = exports.__internals

const row = (id, extra = {}) => ({ id, displayTitle: `Session ${id}`, blank: false, retainedBy: {}, ...extra })

/**
 * Build the props the renderer would hand the occupant, from plain values.
 * @param options - panes/rows/references/etc.
 */
function slotProps(options) {
  const state = {
    panes: options.panes,
    activeId: options.activeId,
    maxPanes: options.maxPanes ?? 6,
    notice: options.notice,
  }
  const rows = Object.fromEntries(
    (options.rows ?? options.panes).map((entry) => {
      const id = typeof entry === 'string' ? entry : entry.id
      return [id, typeof entry === 'string' ? row(id) : entry]
    }),
  )
  const bound = []
  const factoryCalls = []
  return {
    bound,
    factoryCalls,
    props: {
      useMultiChat: (selector) => selector(state),
      useSessions: (selector) => selector({ ids: Object.keys(rows), byId: rows, phase: 'ready' }),
      useSessionStatus: (selector) => selector(options.status ?? new Map()),
      renderFactorySlot: (name, props) => {
        factoryCalls.push({ name, props })
        return h('div', {
          'data-factory': name,
          'data-variant': props.variant,
          'data-phase': props.phase,
          'data-hero': String(props.hero),
        })
      },
      // Production SessionProvider renders no DOM (context + Fragment only).
      SessionProvider: ({ session, children }) => {
        bound.push(session?.sessionId)
        return h(Fragment, null, children ?? null)
      },
      getReference: (id) => options.references?.[id],
      focusPane: options.focusPane ?? (() => {}),
      closePane: options.closePane ?? (() => {}),
      swapPanes: options.swapPanes ?? (() => {}),
      movePaneToEnd: options.movePaneToEnd ?? (() => {}),
      keepOnlyActive: options.keepOnlyActive ?? (() => {}),
      canClosePane: options.canClosePane ?? (() => true),
      t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
    },
  }
}

const paneSections = (html) => html.match(/<section class="dsh-mc-pane"[^>]*>/g) ?? []

test('one pane per session in an equal-cell grid, highlight on the active session only', () => {
  const { props } = slotProps({
    panes: ['a', 'b'],
    activeId: 'b',
    references: { a: { sessionId: 'a' }, b: { sessionId: 'b' } },
  })
  const html = renderToStaticMarkup(h(MultiChatRoot, props))
  const sections = paneSections(html)
  assert.equal(sections.length, 2)
  assert.equal((html.match(/data-active=""/g) ?? []).length, 2, 'the pane and its sequence badge are both marked')
  const activeSection = sections.find((section) => section.includes('data-mc-session="b"'))
  const inactiveSection = sections.find((section) => section.includes('data-mc-session="a"'))
  assert.match(activeSection, /data-active=""/, 'the clicked session is the highlighted one')
  assert.doesNotMatch(inactiveSection, /data-active=""/)
  assert.match(html, /class="dsh-mc-grid" data-count="2"/)
  assert.match(html, /class="dsh-mc-root" data-count="2"/)
})

test('three sessions render three panes, each bound to its own session', () => {
  const { props, bound, factoryCalls } = slotProps({
    panes: ['a', 'b', 'c'],
    activeId: 'c',
    references: { a: { sessionId: 'a' }, b: { sessionId: 'b' }, c: { sessionId: 'c' } },
  })
  const html = renderToStaticMarkup(h(MultiChatRoot, props))
  assert.equal(paneSections(html).length, 3)
  assert.deepEqual([...bound].sort(), ['a', 'b', 'c'], 'each pane opens its own session provider')
  assert.equal(factoryCalls.length, 3)
  assert.equal((html.match(/data-factory="conversation.content"/g) ?? []).length, 3)
})

test('the conversation body is embedded, which is what keeps the composer sticky', () => {
  const { props, factoryCalls } = slotProps({
    panes: ['a', 'b'],
    activeId: 'a',
    references: { a: { sessionId: 'a' }, b: { sessionId: 'b' } },
  })
  const html = renderToStaticMarkup(h(MultiChatRoot, props))
  assert.equal(CONVERSATION_VARIANT, 'embedded')
  for (const call of factoryCalls) {
    assert.equal(call.name, 'conversation.content')
    assert.equal(call.props.variant, 'embedded', 'variant main would leave the phase-gated composer rules dead')
    assert.equal(call.props.variant === 'main', false)
  }
  assert.equal((html.match(/data-variant="embedded"/g) ?? []).length, 2)
})

test('a blank session renders the hero phase; an unknown session settles', () => {
  const blank = slotProps({
    panes: ['a', 'b'],
    activeId: 'a',
    rows: [row('a', { blank: true }), row('b')],
    references: { a: { sessionId: 'a' }, b: { sessionId: 'b' } },
  })
  const blankHtml = renderToStaticMarkup(h(MultiChatRoot, blank.props))
  const phases = [...blankHtml.matchAll(/data-phase="([^"]*)"/g)].map((match) => match[1])
  assert.deepEqual(phases, ['hero', 'active'])

  const settling = slotProps({
    panes: ['a', 'pending-session'],
    activeId: 'a',
    rows: [row('a')],
    references: { a: { sessionId: 'a' }, 'pending-session': { sessionId: 'pending-session' } },
  })
  const settlingHtml = renderToStaticMarkup(h(MultiChatRoot, settling.props))
  assert.match(settlingHtml, /data-phase="settling"/)
  assert.match(settlingHtml, /data-phase="active"/)
})

test('panes without a live reference degrade to a note instead of binding', () => {
  const { props, bound } = slotProps({
    panes: ['a', 'b'],
    activeId: 'a',
    references: { a: { sessionId: 'a' } },
  })
  const html = renderToStaticMarkup(h(MultiChatRoot, props))
  assert.deepEqual(bound, ['a'], 'only the live session is bound')
  assert.match(html, /dsh-mc-pane-note/)
  assert.match(html, /pane\.unavailable/)
})

test('every pane header carries the top-right move handle and a close control', () => {
  const { props } = slotProps({
    panes: ['a', 'b', 'c'],
    activeId: 'a',
    references: { a: { sessionId: 'a' }, b: { sessionId: 'b' }, c: { sessionId: 'c' } },
    canClosePane: (id) => id !== 'a',
  })
  const html = renderToStaticMarkup(h(MultiChatRoot, props))
  const handles = html.match(/<button[^>]*dsh-mc-handle[^>]*>/g) ?? []
  assert.equal(handles.length, 3, 'one handle per pane')
  for (const handle of handles) {
    assert.match(handle, /data-drag-handle=""/)
    assert.match(handle, /aria-label="handle\.aria/)
    assert.match(handle, /type="button"/)
  }
  // The handle must come before the close control (top-right order).
  const header = html.slice(html.indexOf('dsh-mc-pane-head'), html.indexOf('</header>'))
  assert.ok(header.indexOf('dsh-mc-handle') < header.indexOf('dsh-mc-pane-close'))
  const closeButtons = html.match(/<button[^>]*dsh-mc-pane-close[^>]*>/g) ?? []
  assert.equal(closeButtons.length, 3)
  assert.equal(closeButtons.filter((button) => button.includes('disabled')).length, 1)
  assert.match(html, /pane\.closeLocked/)
})

test('the running indicator only shows for running sessions', () => {
  const status = new Map([
    ['a', { running: true }],
    ['b', { running: false }],
  ])
  const { props } = slotProps({
    panes: ['a', 'b'],
    activeId: 'a',
    references: { a: { sessionId: 'a' }, b: { sessionId: 'b' } },
    status,
  })
  const html = renderToStaticMarkup(h(MultiChatRoot, props))
  assert.equal((html.match(/dsh-mc-dot/g) ?? []).length, 1)
  assert.match(html, /pane\.running/)
})

test('the toolbar reports the pane count, cell usage, the drag hint and the notice', () => {
  const { props } = slotProps({
    panes: ['a', 'b', 'c'],
    activeId: 'c',
    maxPanes: 6,
    notice: { code: 'evicted' },
    references: { a: { sessionId: 'a' }, b: { sessionId: 'b' }, c: { sessionId: 'c' } },
  })
  const html = renderToStaticMarkup(h(MultiChatRoot, props))
  assert.match(html, /bar\.title\{&quot;count&quot;:3\}/)
  assert.match(html, /bar\.used\{&quot;used&quot;:3,&quot;max&quot;:6\}/)
  assert.match(html, /bar\.dragHint/)
  assert.match(html, /notice\.evicted/)
  assert.match(html, /bar\.onlyActive/, 'the keep-only-active action stays')
  // The old columns/rows toggle is gone: the grid is the only layout.
  assert.doesNotMatch(html, /bar\.toRows|bar\.toColumns/)
  const buttons = html.match(/<button[^>]*dsh-mc-bar-btn[^>]*>/g) ?? []
  assert.equal(buttons.length, 1)
})

test('the drag ghost carries the dragged pane identity for the pointer layer', () => {
  const html = renderToStaticMarkup(h(DragGhost, { sessionId: 'b', index: 1, title: 'Session b' }))
  assert.match(html, /class="dsh-mc-ghost"/)
  assert.match(html, /data-mc-session="b"/)
  assert.match(html, /aria-hidden="true"/)
  assert.match(html, /Session b/)
})

test('a pane-level error boundary is what contains a broken pane', () => {
  assert.equal(typeof PaneBoundary.getDerivedStateFromError, 'function')
  assert.deepEqual(PaneBoundary.getDerivedStateFromError(new Error('x')), { failed: true })
  const boundary = new PaneBoundary({ sessionId: 'a', t: (key) => key })
  boundary.state = { failed: true }
  const html = renderToStaticMarkup(boundary.render())
  assert.match(html, /data-error=""/)
  assert.match(html, /pane\.error/)
  assert.match(html, /data-mc-session="a"/)
})

test('the grid is at most three equal columns and degrades by width', () => {
  assert.equal(GRID_MAX_COLUMNS, 3)
  assert.match(CSS, /\.dsh-mc-grid\{[^}]*display:grid/)
  assert.match(CSS, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/)
  assert.match(CSS, /grid-auto-rows:minmax\(420px,1fr\)/, 'rows share the height but never below a usable pane')
  assert.match(CSS, /@container \(width<=1100px\)\{\.dsh-mc-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/)
  assert.match(CSS, /@container \(width<=720px\)\{\.dsh-mc-grid\{grid-template-columns:minmax\(0,1fr\)\}\}/)
})

test('the pane body is the official embedding host box and carries no width hacks', () => {
  const bodyRule = CSS.match(/\.dsh-mc-pane-body\{[^}]*\}/)?.[0] ?? ''
  assert.match(bodyRule, /flex:1 1 auto/)
  assert.match(bodyRule, /min-height:0/)
  assert.match(bodyRule, /flex-direction:column/)
  assert.doesNotMatch(bodyRule, /container-type/, 'the cqw width hack is gone: embedded computes its own width')
  assert.doesNotMatch(CSS, /cqw/, 'no container-query width units anywhere')
  assert.doesNotMatch(CSS, /--dsh-chat-user-width/)
})

test('the grid virtualises off-screen panes once it has to scroll', () => {
  const three = slotProps({
    panes: ['a', 'b', 'c'],
    activeId: 'a',
    references: { a: { sessionId: 'a' }, b: { sessionId: 'b' }, c: { sessionId: 'c' } },
  })
  const threeHtml = renderToStaticMarkup(h(MultiChatRoot, three.props))
  assert.doesNotMatch(threeHtml, /data-virtualize/, 'a single row needs no virtualisation')

  const five = slotProps({
    panes: ['a', 'b', 'c', 'd', 'e'],
    activeId: 'a',
    references: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id) => [id, { sessionId: id }])),
  })
  const fiveHtml = renderToStaticMarkup(h(MultiChatRoot, five.props))
  assert.match(fiveHtml, /data-virtualize=""/, 'more panes than one row enables it')
  assert.match(CSS, /\.dsh-mc-grid\[data-virtualize\] \.dsh-mc-pane\{content-visibility:auto/)
  assert.match(CSS, /contain-intrinsic-size:auto 420px/)
})

test('the selection ring is one crisp outer ring, distinct from the drop target', () => {
  const activeRule = CSS.match(/\.dsh-mc-pane\[data-active\]\{[^}]*\}/)?.[0] ?? ''
  assert.match(activeRule, /box-shadow:0 0 0 2px/)
  assert.doesNotMatch(activeRule, /inset/, 'a border plus an inset shadow double-drew the edge')
  const dropRule = CSS.match(/\.dsh-mc-pane\[data-drop-target\]\{[^}]*\}/)?.[0] ?? ''
  assert.match(dropRule, /border-style:dashed/)
  assert.match(dropRule, /box-shadow:0 0 0 2px/)
  assert.notEqual(activeRule, dropRule, 'active and drop target must not share one treatment')
})

test('styles stay inside the theme-token system and use one namespace', () => {
  const colors = CSS.match(/(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/g) ?? []
  assert.deepEqual(colors, [], 'hard-coded colors are not allowed in a DSH UI plugin')
  const customProperties = [...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1])
  assert.ok(customProperties.length >= 10)
  for (const property of customProperties) {
    assert.ok(
      property.startsWith('--dsw-alias-') || property.startsWith('--dsw-radius-') || property.startsWith('--dsh-'),
      `${property} is not a theme token`,
    )
  }
  const classes = [...CSS.matchAll(/(?:^|[\s,}])\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((match) => match[1])
  assert.ok(classes.length >= 18)
  assert.ok(classes.every((name) => name.startsWith('dsh-mc-')), 'every class is namespaced')
  // Drag affordances the pointer layer depends on.
  assert.match(CSS, /\.dsh-mc-pane\[data-dragging\]/)
  assert.match(CSS, /\.dsh-mc-pane\[data-drop-target\]/)
  assert.match(CSS, /\.dsh-mc-handle:focus-visible/)
  assert.match(CSS, /touch-action:none/)
})

test('style injection is idempotent, tagged and removable', () => {
  const created = []
  const head = {
    appendChild(node) {
      created.push(node)
    },
  }
  const fakeDocument = {
    head,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    querySelector: (selector) => created.find((node) => selector.includes(node.dataset.pluginCss)) ?? null,
  }
  const previous = globalThis.document
  globalThis.document = fakeDocument
  try {
    const first = injectStyles()
    assert.equal(created.length, 1)
    assert.equal(created[0].dataset.plugin, 'dsh-multi-chat')
    assert.equal(created[0].dataset.pluginCss, STYLE_TAG_ID)
    assert.equal(created[0].textContent, CSS)
    const second = injectStyles()
    assert.equal(created.length, 1, 'the tag is injected once')
    assert.doesNotThrow(() => {
      first()
      second()
    })
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }

  const previousDocument = globalThis.document
  delete globalThis.document
  try {
    assert.equal(typeof injectStyles(), 'function')
  } finally {
    if (previousDocument !== undefined) globalThis.document = previousDocument
  }
})

test('panes and the toolbar are labelled for assistive tech', () => {
  const { props } = slotProps({
    panes: ['a', 'b'],
    activeId: 'a',
    references: { a: { sessionId: 'a' }, b: { sessionId: 'b' } },
  })
  const html = renderToStaticMarkup(h(MultiChatRoot, props))
  assert.match(html, /aria-label="pane\.aria\{&quot;index&quot;:2,&quot;title&quot;:&quot;Session b&quot;\}"/)

  const paneHtml = renderToStaticMarkup(
    h(MultiChatPane, {
      sessionId: 'b',
      index: 1,
      active: true,
      title: 'Session b',
      blank: false,
      running: false,
      reference: { sessionId: 'b' },
      renderFactorySlot: () => h('div', null),
      SessionProvider: ({ children }) => h(Fragment, null, children),
      dragging: true,
      dropTarget: false,
      canClose: true,
      onFocusPane: () => {},
      onClosePane: () => {},
      onHandleKeyDown: () => {},
      onPointerDown: () => {},
      setPaneElement: () => {},
      t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
    }),
  )
  assert.match(paneHtml, /data-dragging=""/)
  assert.match(paneHtml, /dsh-mc-pane-body/)
  assert.match(paneHtml, /Session b/, 'the title arrives as a primitive from the root')

  const barHtml = renderToStaticMarkup(
    h(MultiChatBar, {
      state: { panes: ['a', 'b'], activeId: 'a', maxPanes: 6, notice: undefined },
      t: (key) => key,
      keepOnlyActive: () => {},
    }),
  )
  assert.match(barHtml, /data-window-drag="true"/)
})
