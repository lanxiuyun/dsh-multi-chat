/**
 * Headless, opt-in diagnostic snapshot for a running DSH local Web profile.
 * Requires --port and --token. It does not create or switch sessions.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
const port = flag('port')
const token = flag('token')
const debugPort = Number(flag('debug-port') ?? '9334')
if (!port || !token) {
  console.error('usage: node scripts/browser-diagnostics.mjs --port <port> --token <token> [--debug-port 9334]')
  process.exit(2)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = resolve(root, '.diagnostics-profile')
mkdirSync(profile, { recursive: true })
const candidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
const executable = candidates.find(existsSync)
if (!executable) throw new Error('Chrome/Edge not found')

const child = spawn(executable, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1680,1050',
  `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
], { stdio: 'ignore', detached: false })
child.on('error', (error) => console.error('browser launch failed:', error.message))

const delay = (ms) => new Promise((wake) => setTimeout(wake, ms))
let wsUrl
for (let attempt = 0; attempt < 60 && !wsUrl; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    const pages = await response.json()
    wsUrl = pages.find((page) => page.type === 'page')?.webSocketDebuggerUrl
  } catch {}
  if (!wsUrl) await delay(250)
}
if (!wsUrl) throw new Error('Chrome DevTools endpoint unavailable (browser may be blocked)')

const socket = new WebSocket(wsUrl)
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  pending.delete(message.id)
  if (!entry) return
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = ++nextId
  pending.set(id, { resolve: resolveCall, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text)
  return response.result?.result?.value
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await delay(7000)
  const report = await evaluate(`(() => ({
    origin: location.origin,
    width: window.innerWidth,
    height: window.innerHeight,
    title: document.title,
    pluginStyle: Boolean(document.querySelector('style[data-plugin-css="dsh-multi-chat/index.css"]')),
    gridSwitch: localStorage.getItem('dsh-multi-chat:grid'),
    panesSaved: localStorage.getItem('dsh-multi-chat:v1'),
    grids: document.querySelectorAll('.dsh-mc-grid').length,
    panes: [...document.querySelectorAll('.dsh-mc-pane')].map(node => ({
      title: node.querySelector('.dsh-mc-pane-title')?.textContent,
      active: node.hasAttribute('data-active')
    })),
    rowButtons: document.querySelectorAll('.dsh-mc-rowbtn').length
  }))()`)
  console.log(JSON.stringify(report, null, 2))
  await delay(500)
} finally {
  socket.close()
  child.kill()
}
