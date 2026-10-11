/**
 * TurnNavigator override tests (acceptance A27).
 *
 * The official turn rail hides itself inside any conversation narrower than
 * 900px, which is every grid pane. The plugin restores it with one scoped rule
 * whose official class prefix is read from the official stylesheet at runtime —
 * this suite pins that behaviour, including the no-official-stylesheet fallback
 * and idempotency across grid mounts.
 *
 * @module tests/turn-rail
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { loadClientBundle } from './harness.mjs'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
const { exports } = loadClientBundle({ globals: { document: dom.window.document } })
const { installTurnRailOverride, turnRailOverrideCss, TURN_RAIL_STYLE_TAG_ID } = exports.__internals

/** The shape of the official stylesheet (prefix is build-specific). */
const OFFICIAL_CSS = [
  '.PvW7sq_slot{z-index:7;height:0;position:absolute;container-type:inline-size}',
  '.PvW7sq_frame{width:28px;position:absolute;right:12px}',
  '.PvW7sq_mark:before{width:20px;height:2px}',
  '@container (width<=900px){.PvW7sq_frame{display:none}}',
].join('')

const RAIL_TAG = `style[data-plugin-css=${JSON.stringify(TURN_RAIL_STYLE_TAG_ID)}]`

/** Install a fake copy of the official stylesheet. */
function addOfficialStylesheet(document, css = OFFICIAL_CSS) {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@deepseek-ai/dsh-client-ui-chat'
  tag.dataset.pluginCss = '@deepseek-ai/dsh-client-ui-chat/TurnNavigator.module.css'
  tag.textContent = css
  document.head.appendChild(tag)
  return tag
}

test('the override out-specifies the official hide rule inside our panes only', () => {
  // A class + attribute selector beats the official class-only rule, so the
  // hidden frame is restored wherever that rule sits in the cascade.
  assert.equal(turnRailOverrideCss('PvW7sq'), '.dsh-mc-pane [class*="PvW7sq_frame"]{display:block}')
  assert.match(turnRailOverrideCss('PvW7sq'), /^\.dsh-mc-pane /, 'scoped to panes: the official view keeps its own rule')
  assert.doesNotMatch(turnRailOverrideCss('PvW7sq'), /container-type/, 'official container semantics stay untouched')
})

test('nothing is injected while the official stylesheet is absent', () => {
  const document = dom.window.document
  document.head.innerHTML = ''
  assert.equal(installTurnRailOverride(), undefined)
  assert.equal(document.querySelector(RAIL_TAG), null)
})

test('the prefix is read from the official stylesheet and the rule is installed once', () => {
  const document = dom.window.document
  document.head.innerHTML = ''
  addOfficialStylesheet(document)

  assert.equal(installTurnRailOverride(), 'PvW7sq')
  const tag = document.querySelector(RAIL_TAG)
  assert.ok(tag, 'the override has its own stylesheet tag')
  assert.match(tag.textContent, /\.dsh-mc-pane \[class\*="PvW7sq_frame"\]\{display:block\}/)
  assert.doesNotMatch(tag.textContent, /_slot/, 'only the frame is restored')
  assert.equal(tag.dataset.plugin, 'dsh-multi-chat')
  assert.equal(tag.dataset.turnRailPrefix, 'PvW7sq')

  // Grid mounts call this repeatedly: still exactly one tag, and no throw.
  assert.equal(installTurnRailOverride(), 'PvW7sq')
  assert.equal(installTurnRailOverride(), 'PvW7sq')
  assert.equal(document.querySelectorAll(RAIL_TAG).length, 1)
})

test('a rebuild with a different prefix is still resolved, and a foreign stylesheet is ignored', () => {
  const document = dom.window.document
  document.head.innerHTML = ''
  addOfficialStylesheet(document, '.Zz9Qq1_slot{container-type:inline-size}@container (width<=900px){.Zz9Qq1_frame{display:none}}')
  assert.equal(installTurnRailOverride(), 'Zz9Qq1')
  assert.match(document.querySelector(RAIL_TAG).textContent, /Zz9Qq1_frame/)

  document.head.innerHTML = ''
  const unrelated = document.createElement('style')
  unrelated.dataset.pluginCss = '@deepseek-ai/dsh-client-ui-chat/Chat.module.css'
  unrelated.textContent = '.Ab12Cd_slot{container-type:inline-size}'
  document.head.appendChild(unrelated)
  assert.equal(installTurnRailOverride(), undefined, 'only the TurnNavigator stylesheet is a prefix source')
  assert.equal(document.querySelector(RAIL_TAG), null)
})
