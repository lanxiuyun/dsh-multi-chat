/**
 * Install-path verification helper: fetch the isolated verify profile's web UI,
 * pull the boot graph's combo URL that carries dsh-multi-chat, and prove the
 * served bytes are this package's browser half.
 *
 * Usage:
 *   dsh --profile <verify> --port 4399 --no-open          # in one shell
 *   node scripts/verify-served-bundle.mjs 4399 <token>    # in another
 */
const [port, token] = process.argv.slice(2)
if (port === undefined || token === undefined) {
  console.error('usage: node scripts/verify-served-bundle.mjs <port> <token>')
  process.exit(2)
}
const base = `http://127.0.0.1:${port}`

const first = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
const cookies = (first.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
const page = await fetch(`${base}/?token=${token}`, { headers: cookies === '' ? {} : { cookie: cookies } })
const html = await page.text()
console.log(`index status: ${page.status}, bytes: ${html.length}, auth cookie: ${cookies !== ''}`)

const graph = html.match(/__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})<\/script>/)
if (graph === null) {
  console.error('no __DSH_BOOT__ graph found in the page')
  process.exitCode = 1
} else {
  const boot = JSON.parse(graph[1])
  const entry = boot.entries.find((row) => row.id === 'dsh-multi-chat')
  console.log(`boot entry: ${JSON.stringify(entry)}`)
  const batch = boot.batches.find((row) => row.entries.includes('dsh-multi-chat'))
  console.log(`batch phase: ${batch?.phase}, url carries the entry: ${batch?.url.includes('dsh-multi-chat')}`)

  const urls = [...html.matchAll(/(?:src|href)="(plugins\/\?\?[^"]+)"/g)].map((match) =>
    match[1].replace(/&amp;/g, '&'),
  )
  const target = urls.find((url) => url.includes('dsh-multi-chat'))
  if (target === undefined) {
    console.error('no combo URL carries dsh-multi-chat')
    process.exitCode = 1
  } else {
    const served = await fetch(`${base}/${target}`, { headers: cookies === '' ? {} : { cookie: cookies } })
    const body = await served.text()
    const markers = [
      "id: 'dsh-multi-chat'",
      'dsh-mc-grid',
      'dsh-mc-handle',
      "variant: CONVERSATION_VARIANT",
      "CONVERSATION_VARIANT = 'embedded'",
      'multichat.pane',
      'main.conversation',
      'sidebar.workspaces.session.row.action',
      'sessions.retain',
    ]
    console.log(`combo status: ${served.status}, bytes: ${body.length}`)
    for (const marker of markers) {
      console.log(`  served body contains ${JSON.stringify(marker)}: ${body.includes(marker)}`)
    }
    const missing = markers.filter((marker) => !body.includes(marker))
    if (entry === undefined || missing.length > 0) process.exitCode = 1
  }
}
