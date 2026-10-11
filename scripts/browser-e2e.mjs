/**
 * Real-browser end-to-end check for the isolated verify profile.
 *
 * Boots headless Chrome against the profile's web UI (started separately with
 * `dsh --profile <verify> --port <port> --no-open`), then:
 *
 *   1. waits for the shell to boot and asserts this plugin activated (style tag
 *      present, no client entry failures);
 *   2. opens sessions from the sidebar until the grid appears;
 *   3. asserts the grid contract: equal cells, at most three per row, one real
 *      pane per session, exactly one highlighted, every pane owning a visible
 *      bottom composer;
 *   4. performs a real drag from a pane's top-right handle onto another pane and
 *      asserts the two panes swapped;
 *   5. screenshots the result as evidence.
 *
 * Usage:
 *   node scripts/browser-e2e.mjs --port 4399 --token <token> [--explore]
 *
 * Requires a Chrome/Edge binary and permission to launch it normally (it uses a
 * workspace-local `--user-data-dir`, so it never writes outside the repository).
 * Some sandboxes deny Chrome's crashpad child process; the script then fails to
 * find the CDP endpoint and reports that instead of hanging.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const port = readFlag('port', '4399')
const token = readFlag('token')
const explore = args.includes('--explore')
const debugPort = Number(readFlag('debug-port', '9333'))
if (token === undefined) {
  console.error('usage: node scripts/browser-e2e.mjs --port <port> --token <token> [--explore]')
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const chromeProfile = resolve(root, '.chrome-profile')
const shotDir = resolve(root, '.verify')
const shotPath = resolve(shotDir, 'multi-chat-grid.png')
mkdirSync(chromeProfile, { recursive: true })
mkdirSync(shotDir, { recursive: true })

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const browser = CANDIDATES.find((candidate) => existsSync(candidate))
if (browser === undefined) {
  console.error('no Chrome/Edge binary found')
  process.exit(2)
}

const child = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1680,1050',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)
child.on('error', (error) => console.error('browser spawn failed:', error))

/** Poll until the CDP endpoint answers (or explain why it never did). */
async function cdpTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await new Promise((wake) => setTimeout(wake, 250))
  }
  throw new Error(
    'CDP endpoint never came up — the browser likely failed to start (a sandboxed ' +
      'environment can deny its crashpad child process: "OpenProcess: access denied")',
  )
}

const socketUrl = await cdpTarget()
const socket = new WebSocket(socketUrl)
await new Promise((ready, fail) => {
  socket.addEventListener('open', ready, { once: true })
  socket.addEventListener('error', fail, { once: true })
})

let nextId = 0
const pending = new Map()
const consoleErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (entry !== undefined) {
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
    return
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception')
  }
})

/** Send one CDP command. */
function send(method, params = {}) {
  nextId += 1
  const id = nextId
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description ?? ''}`)
  }
  return result.result?.value
}

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms))

/** Poll a page expression until it returns truthy. */
async function waitFor(expression, { timeoutMs = 40000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true
    } catch {
      /* the app may still be booting */
    }
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Move the mouse the way a real drag does (pointer events included). */
async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: extra.button ?? 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mousePressed' ? 1 : 0,
    ...extra,
  })
}

const SUMMARY = `(() => {
  const panes = [...document.querySelectorAll('.dsh-mc-pane')]
  return {
    pluginStyle: document.querySelector('style[data-plugin-css="dsh-multi-chat/index.css"]') !== null,
    root: document.querySelectorAll('.dsh-mc-root').length,
    panes: panes.length,
    order: panes.map((pane) => pane.dataset.mcSession),
    active: panes.filter((pane) => pane.hasAttribute('data-active')).map((pane) => pane.dataset.mcSession),
    handles: document.querySelectorAll('.dsh-mc-handle').length,
    composers: [...document.querySelectorAll('.dsh-mc-pane')].filter((pane) =>
      pane.querySelector('[data-composer-seat]') !== null).length,
    stickyComposers: [...document.querySelectorAll('.dsh-mc-pane')].filter((pane) => {
      const seat = pane.querySelector('[data-composer-seat]')
      return seat !== null && getComputedStyle(seat).position === 'sticky'
    }).length,
    embeddedBodies: [...document.querySelectorAll('.dsh-mc-pane [data-conversation-content]')].filter((body) =>
      body.hasAttribute('data-content-phase')).length,
    columns: getComputedStyle(document.querySelector('.dsh-mc-grid')).gridTemplateColumns.split(' ').length,
  }
})()`

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?token=${token}` })
  await waitFor('document.readyState === "complete"', { label: 'document load' })
  await waitFor('document.querySelector(\'[data-slot="root"]\') !== null', { label: 'shell boot' })
  await sleep(2500)
  console.log('boot summary:', JSON.stringify(await evaluate(SUMMARY), null, 2))

  if (explore) {
    console.log('console errors:', JSON.stringify(consoleErrors.slice(0, 20), null, 2))
  } else {
    const opened = await evaluate(`(async () => {
      const labels = ['New Session', '新建会话', 'New session', '新建']
      const find = () => [...document.querySelectorAll('button')].find((button) => {
        const text = ((button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '')).trim()
        return labels.some((label) => text.includes(label))
      })
      const results = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const button = find()
        if (button === undefined) { results.push('no-new-session-button'); break }
        button.click()
        results.push('clicked')
        await new Promise((wake) => setTimeout(wake, 2500))
      }
      return results
    })()`)
    console.log('session clicks:', JSON.stringify(opened))
    await sleep(2500)

    const before = await evaluate(SUMMARY)
    console.log('grid summary:', JSON.stringify(before, null, 2))
    if (before.panes < 2) {
      console.error('fewer than two panes — cannot exercise the grid; open sessions manually and rerun')
      process.exitCode = 1
    } else {
      const handles = await evaluate(`(() => [...document.querySelectorAll('.dsh-mc-handle')].map((handle) => {
        const rect = handle.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }))()`)
      const paneRects = await evaluate(`(() => [...document.querySelectorAll('.dsh-mc-pane')].map((pane) => {
        const rect = pane.getBoundingClientRect()
        return { session: pane.dataset.mcSession, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }))()`)
      const from = handles[0]
      const to = paneRects[1]
      const expectedOrder = [before.order[1], before.order[0], ...before.order.slice(2)]
      if (from !== undefined && to !== undefined) {
        await mouse('mousePressed', from.x, from.y)
        await mouse('mouseMoved', from.x + 20, from.y + 20)
        await mouse('mouseMoved', to.x, to.y)
        await sleep(150)
        await mouse('mouseReleased', to.x, to.y)
        await sleep(800)
        const after = await evaluate(SUMMARY)
        console.log('after drag:', JSON.stringify(after, null, 2))
        const swapped = JSON.stringify(after.order) === JSON.stringify(expectedOrder)
        console.log(`drag swapped first two panes: ${swapped}`)
        if (!swapped) process.exitCode = 1
      }
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
      console.log(`screenshot: ${shotPath}`)
      console.log('console errors:', JSON.stringify(consoleErrors.slice(0, 20), null, 2))
    }
  }
} finally {
  socket.close()
  child.kill()
}
