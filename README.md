# dsh-multi-chat

**Side-by-side sessions for the DeepSeek Harness web GUI, as an equal-cell grid.**
Click a session in the left sidebar and it joins the conversation area as its own pane: one
click → one session, three clicks → three sessions. At most **three panes per row**; the grid
degrades to two or one column when the window is narrow. The session you clicked (the shell's
current session) stays highlighted, every pane keeps its own bottom-pinned input box, and panes
can be reordered by dragging the **⠿ handle in the top-right corner** of a pane header.

中文说明：[README.zh.md](README.zh.md) · 设计依据：[docs/design.md](docs/design.md) ·
Design notes (EN): [docs/design.en.md](docs/design.en.md)

---

## What it does

| | |
|---|---|
| **Follow the sidebar** | Every session you click in the sidebar becomes a pane. The pane order survives a page reload. |
| **Equal-cell grid** | At most three equal cells per row (`3 × 3` = 9 panes max, six by default). Rows share the height but never below a comfortable pane height (~420 px); beyond that the grid scrolls. Narrow windows degrade 3 → 2 → 1 columns. |
| **Highlight** | The current session's pane is ringed, its title emphasized, and its sequence badge inverts. |
| **Focus by click** | Clicking inside a non-active pane asks the shell to make that session current (the official sidebar highlight follows). |
| **Reorder by drag** | Grab the ⠿ handle at the top-right of a pane header (immediate drag) or press the header itself (4 px of travel, or a 300 ms hold on touch). Drop on another pane to **swap** the two, drop on empty grid space to move the pane to the end, `Esc` cancels. The dragged pane follows the pointer as a ghost card and the drop target is outlined. |
| **Reorder by keyboard** | The handle is focusable: `Ctrl/⌘ + arrows` swaps with the neighbouring cell (grid-aware for up/down), otherwise nothing happens. |
| **Close** | Each pane has a close control. The active pane can only be closed by handing the shell over to a sibling — otherwise the control is disabled with a reason. The toolbar's **Keep only active** collapses the grid. |
| **Sidebar toggle** | Each session row gets an extra action button (next to archive/pin) that adds/removes that session as a pane **without** navigating. |
| **Degrade, never break** | A single pane → the official single-session UI is used untouched. Unknown/closed sessions render a note card. A crashed pane is contained by a pane-level error boundary. No `slots`/`sessions` service → the plugin stays inert instead of failing the web boot. |

## Install

The package is a DSH bundle plugin: the host half (`.` → `lib/index.js`) only exists so the
package becomes a loader entry; the browser half (`./client` → `lib/client.js`) is what the web
shell loads through the `dsh.client` declaration.

```powershell
dsh plugin --profile desktop add link:<path-to-this-package>
# then restart the desktop app / profile (bundle layers apply at boot)
```

Read-only check that the row composes (writes nothing):

```powershell
dsh --profile desktop --dump-config | Select-String dsh-multi-chat
```

Uninstall: `dsh plugin --profile desktop remove dsh-multi-chat`.

## Development

```powershell
npm install    # dev-only: react, react-dom, jsdom, yaml, @deepseek-ai/dsh-client-ui-slots
npm test       # 7 suites, 90 tests
npm run typecheck
```

**v0.2.4 change**: the grid is a wide-window feature, so a narrow window keeps the official single
session view. Below 720px of window width the plugin is completely inert — no session is retained, no
slot is replaced, and nothing is written to the shared storage (which the floating session window would
otherwise clobber with its own pane set). Widening the window brings the grid back; narrowing hands the
conversation area back. Verified live: 490×640 cold start shows the normal conversation, 1680×1050 shows
the grid, resizing switches both ways.

**v0.2.3 fix**: in a narrow window (the ~490 px floating session window) the grid toolbar wrapped into
three lines and squeezed the conversation. It now never wraps and degrades by width — dropping the drag
hint, then the usage counter, swapping the title for a compact "N panes" label — and the row height
yields to short windows (`min(420px, 62vh)`). Measured in a 490×640 window: one 37 px line, single
column, composer fully visible.

**v0.2.2 fixes** (reported from a live session, located in a real browser): the grid used to be
registered in a *session-scoped* slot, which the renderer remounts whenever the shell switches
session — so every switch rebuilt the grid and all pane conversations (the lag that grew with the
number of panes) and replaced the composer input mid-click (the "needs a second click to focus"
bug). The grid now lives in the **root-scope `main` / `conversation` panel cell** (same replacement
semantics, no remount), and pane activation runs on `focusin`/`click` instead of `pointerdown`.
Measured live: one click focuses the composer, session switching ≈ one frame, 5 panes ≈ 2.6k DOM
nodes with off-screen panes virtualised. Details: [docs/design.md](docs/design.md) §4.9.

**v0.2.1 fixes**: switching a session no longer walks a `retain` → publish → `retain` recursion (it
used to overflow the stack, slow every switch down and leave the pane ring and the sidebar highlight
disagreeing); dragging can no longer strand a ghost or a drop ring when the pointer is released
outside the grid; the selection ring is a single crisp outer ring instead of a double-drawn edge.
Details and the reproduction evidence: [docs/design.md](docs/design.md) §4.8.

| Suite | Covers |
|---|---|
| `tests/manifest.test.mjs` | package/bundle/client-half/patch/locale contract, plus "the composer fix stays in place" |
| `tests/host.test.mjs` | the inert host half never throws |
| `tests/store.test.mjs` | pane ledger: follow adds panes, ceiling 6/9, eviction, highlight, `swap`/`moveToEnd`, persistence + the v1→v2 migration, untrusted payloads, drop targeting, keyboard steps |
| `tests/registration.test.mjs` | activation contract: no registration for one pane, shadow registration for 2+, retention/release, sidebar button, unknown sessions, disposal, missing services |
| `tests/real-slot-core.test.mjs` | the same wiring driven through the **real** `SlotCore` shipped by `@deepseek-ai/dsh-client-ui-slots` |
| `tests/render.test.mjs` | structural rendering: equal-cell grid, single highlight, handle + close per header, `variant: 'embedded'` for the conversation body, hero/settling phases, token-only stylesheet |
| `tests/interaction.test.mjs` | React DOM in jsdom: pointer drag → swap, drop on empty → move to end, `Esc` cancel, header 4 px threshold, `Ctrl+Arrow` keyboard swap, close/focus, sidebar toggle, toolbar, pane-level crash containment |

End-to-end install verification (optional, needs a running profile):

```powershell
# isolated profile that never touches your desktop profile
$env:DSH_HOME="$PWD\..\.dsh-verify"
dsh --profile multichat-verify --from-default-profile web --dump-config
dsh plugin --profile multichat-verify add link:$PWD
dsh --profile multichat-verify --port 4399 --no-open
# then, in another shell:
npm run e2e:served   -- 4399 <token-from-the-printed-url>   # boot graph + served bundle
npm run e2e:browser  -- --port 4399 --token <token>          # real drag + screenshot
```

`e2e:browser` needs permission to launch Chrome/Edge normally; some sandboxes deny Chrome's
crashpad child process and the script then reports that instead of hanging.

`lib/client.js` is the shipped browser bundle: a single readable file in the official
module-loader wrapper (`window.__ModuleLoader__.load({ id, factory })`) with `require('react')`
as its only import. No build step — edit the file and the client HMR driver picks it up while
`pnpm run dev:web` watches the checkout.

## How it works (short version)

1. `ctx.sessions.list` is observed; the session with `retainedBy.mainView > 0` is the shell's
   current session. Each new current session joins an ordered pane set, which *is* the grid order.
2. Every pane holds its own `sessions.retain(id, { source: 'multichat' })` reference, so the
   client keeps that session's scope alive even after the user navigates away.
3. While 2+ panes are open the plugin registers into the documented `main.conversation`
   **replacement point** (`single` slot, lower `priority`) and renders one
   `<SessionProvider session={reference}>` subtree per pane around the official
   `conversation.content` Factory — rendered as **`variant: 'embedded'`**, which is what keeps
   the composer's phase-gated `position: sticky; bottom: 0` alive without the official
   conversation root (see [docs/design.md](docs/design.md) §4.2). With one pane the registration
   is disposed, restoring the official view.
4. Styles use one tagged `<style>` element and only `--dsw-alias-*` / `--dsw-radius-*` theme
   tokens, so light and dark themes both work.

## Known limitations

- The official conversation header (title breadcrumbs, view tabs, header actions) belongs to the
  entry the plugin replaces and cannot be rendered by a third party, so grid mode draws its own
  compact pane headers instead.
- Panes keep their sessions open, so N panes mean N live session streams; the default ceiling is
  six, and the hard cap is nine.
- Drag reordering is pointer-based (mouse/touch/pen) plus the keyboard shortcut; there is no
  auto-scroll while dragging near the grid edge.
- The client boot path does not pass cordis config to browser plugins, so all knobs live in the
  grid toolbar / `localStorage` rather than in `cordis.patch.yml`.

## License

MIT — see [LICENSE](LICENSE).
