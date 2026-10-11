# dsh-multi-chat — design notes (v0.2.0: equal-cell grid, drag reordering, composer fix)

> 中文版：[design.md](design.md). This is the implementation contract the code and the tests are
> held to.

## 1. Request and iteration

**Round 1**: a DSH plugin that shows several sessions in the conversation area — click a session
in the left sidebar and one appears on the right: one click → one, three clicks → three, with the
clicked session highlighted.

**Round 2 (this version)**:
1. Layout becomes an equal-cell grid, **at most three per row**;
2. panes can be **reordered by dragging** (handle in the pane's **top-right corner**; move only,
   no resizing);
3. bug fix: **with two panes the bottom input box disappeared**.

## 2. Scope

### 2.1 In scope

| # | Behaviour |
|---|---|
| R1 | Clicking a sidebar session adds a grid cell (follows `retainedBy.mainView`), so n clicks → n cells. |
| R2 | Equal-cell grid, max three per row (3x3 = 9 cap); rows share the height but never below ~420 px, beyond which the grid scrolls. |
| R3 | Narrow windows degrade 3 → 2 → 1 columns (container query on the centre column). |
| R4 | The clicked/current session is highlighted (ring, emphasized title, inverted badge, `data-active`). |
| R5 | **Drag reordering**: top-right handle grabs immediately; the header drags too (4 px travel, or 300 ms hold on touch); drop on a pane = swap, drop on empty space = move to end, `Esc` cancels, ghost follows the pointer, target outlined. |
| R6 | **Keyboard reordering**: focused handle + `Ctrl/Cmd + arrows` swaps with the neighbouring cell (grid-aware for up/down). |
| R7 | Per-pane close (the active pane must hand over first, else the control is disabled with a reason) and a toolbar "keep only active". |
| R8 | A sidebar row button to add/remove a session without navigating. |
| R9 | **Every pane keeps its own bottom-pinned, independently usable input box** — never scrolled away, never parked at the top on a blank session. |
| R10 | Pane order + ceiling persist in `localStorage`, with a v1 → v2 migration. |
| R11 | Error handling: missing services degrade silently, unknown sessions are dropped with a notice, a broken pane is contained, `apply` never throws. |
| R12 | Unit/contract/real-DOM tests, `npm test` green. |

### 2.2 Out of scope

| # | Not done | Why |
|---|---|---|
| N1 | No DSH source changes | Only documented extension points. |
| N2 | No second React app, iframe or `document.body` mounting | DSH UI red line. |
| N3 | No conversation rendering of our own | The official `conversation.content` Factory is reused. |
| N4 | No official conversation header | `conversation.header` belongs to the replaced entry; a third party can neither redeclare nor `renderSlot` it (the one deliberate regression). |
| N5 | No pane resizing / free positioning | Under an equal-cell grid, free sizes would break the model; the user confirmed "move only". |
| N6 | No host-side config | The client boot path passes no cordis config to browser plugins. |
| N7 | No cross-device sync | Pane order is browser-local view state. |

## 3. Acceptance criteria

| # | Criterion | Verified by |
|---|---|---|
| A1 | 1st/2nd/3rd sidebar click → 1/2/3 panes | `tests/registration.test.mjs`, `tests/render.test.mjs` |
| A2 | Only the current session's pane carries `data-active` | `tests/render.test.mjs` |
| A3 | Non-active panes close; the active pane is disabled when it cannot hand over | `tests/interaction.test.mjs`, `tests/store.test.mjs` |
| A4 | The sidebar button toggles a pane without navigating | `tests/interaction.test.mjs` |
| A5 | Over the ceiling: explicit opens refuse with a notice; following the shell replaces the oldest pane | `tests/store.test.mjs` |
| A6 | Unknown session ids never throw and never resurrect a session | `tests/registration.test.mjs` |
| A7 | One broken pane is contained | `tests/render.test.mjs`, `tests/interaction.test.mjs` |
| A8 | Missing `slots`/`sessions` registers nothing and throws nothing | `tests/registration.test.mjs` |
| A9 | Package contract (static `dsh.client.inject`, `platform: web`, `./client` export, patch row, bilingual locale) | `tests/manifest.test.mjs` |
| A10 | The stylesheet encodes the 3-column cap, the row-height floor/scroll and the width degradation | `tests/render.test.mjs` |
| A11 | **Drag swap**: handle grabs immediately → ghost → target outlined → drop swaps the two panes | `tests/interaction.test.mjs` |
| A12 | **Drop on empty space moves to the end**; `Esc` cancels without reordering; a header press within 4 px is a click (focus), not a drag | `tests/interaction.test.mjs` |
| A13 | **Keyboard swap**: `Ctrl/Cmd + Left/Right` swaps; unmodified arrows pass through; edge moves are no-ops | `tests/interaction.test.mjs`, `tests/store.test.mjs` |
| A14 | **The composer fix cannot regress**: the conversation body renders as `variant:'embedded'`, and the pane body carries no `container-type`/`cqw` width hack | `tests/render.test.mjs`, `tests/manifest.test.mjs` |
| A15 | Slot semantics match the official implementation | `tests/real-slot-core.test.mjs` (real `SlotCore`) |
| A16 | The package installs through the official channel and the browser really loads it | Isolated profile + `scripts/verify-served-bundle.mjs` |
| A17 | Everything passes | `npm test` (7 suites / 90 tests) |
| A18 | **A synchronous publish inside `retain` cannot recurse**: one retain per session, no list-handling / sync / stack warnings | `tests/registration.test.mjs` (faithful fake) + live-console re-check |
| A19 | **Drags cannot strand state**: release outside the panes, sub-threshold header release, and a second press while one is pending all leave no ghost, dashed outline or target ring | `tests/interaction.test.mjs` |
| A20 | The selection ring is a **single outer ring** (no inset double edge) and the drop target is a distinct dashed cool ring | `tests/render.test.mjs` |
| A21 | **The grid lives in a root-scope cell**: switching sessions never remounts the grid or its panes (the cause of both the lag and the lost focus) | `tests/real-slot-core.test.mjs` (`spec('main').scope === 'root'`) + `tests/registration.test.mjs` (`key='conversation'`) |
| A22 | **One click on a composer focuses it**: navigation runs on focusin/click, never on pointerdown | `tests/interaction.test.mjs` |
| A23 | More panes than one row (>3) turns on `content-visibility` virtualisation | `tests/render.test.mjs` (`data-virtualize` + rule) and a live node-count check |
| A24 | **The toolbar stays on one line in narrow windows** (e.g. the ~490px DSH floating session window) and degrades by width: never wraps, drops the drag hint at ≤640px, drops the usage counter and switches to the compact label at ≤480px; row height becomes `min(420px,62vh)` | `tests/render.test.mjs` + live 490×640 check |
| A25 | **Narrow windows (<720px) are not taken over**: no slot registration, no retained sessions, no writes to shared storage; widening restores the grid (re-adopting the current session) and narrowing hands the conversation area back | `tests/registration.test.mjs` (fake window + resize) + live 490×640 / 1680×1050 / 520×700 checks |
| A26 | **The column count follows the available width and fills the row**: two panes share the width (no empty third column), three across only when the width allows, panes never narrower than ~400px | `tests/render.test.mjs` (column template) + live 1680 / 1150 / 950 checks |
| A27 | **The official turn navigator works inside grid panes**: the official "hide below a 900px container" rule is out-specified by one pane-scoped rule; the official class prefix is read from the official stylesheet at runtime and nothing is injected without it | `tests/turn-rail.test.mjs` (four cases: rule shape, missing-stylesheet fallback, idempotency, prefix change + unrelated stylesheet) and a live check (`display:block`, 11 marks in a pane) |

## 4. Implementation

### 4.1 Extension points

| Purpose | Slot | Contract |
|---|---|---|
| Conversation replacement | `main.conversation` | `single` + `session-maybe`, declared by ui-conversation's `main` (key `conversation`); `priority: -1000` shadows the official occupant, disposal restores it. |
| Per-pane session binding | `SessionProvider` | Handed to entries that declare a non-`root` child; `<SessionProvider session={reference}>` binds another session — the documented "concurrent subtrees targeting different Sessions". |
| Pane body | Factory `conversation.content` | Every kit carries `renderFactorySlot`; its `views`/`widthControls` local slots have official fallbacks. |
| Sidebar row action | `sidebar.workspaces.session.row.action` | `list` + `root`, owner props `{sessionId, displayTitle}`; a fresh `id` extends the official cells. |
| Session navigation | `ctx.uiWorkspace.openSession(id)` | Soft-get; falls back to a local highlight. |

### 4.2 Why the composer disappeared, and the fix (A14)

**Root cause (high confidence, verified in the shipped bundle)**: the sticky composer lives on a
*phase-gated* rule (`dsh-client-ui-conversation/lib/client.js:15721`):

```css
.uPhUma_root[data-phase=active] .uPhUma_composerSeat,
.uPhUma_embeddedBody[data-content-phase=active] .uPhUma_composerSeat{
  z-index:7; background:linear-gradient(...); position:sticky; bottom:0
}
```

with twin rules for `.uPhUma_viewArea{flex:1 0 auto;min-height:auto}`, hero centring and settling
hiding. The element carrying `div.uPhUma_root[data-phase=...]` is the official `ConversationRoot` —
**exactly what this plugin replaces** (`ui-conversation:15941-15948`). Both halves of every
selector therefore died: the composer returned to normal flow (scrolling the transcript pushed it
thousands of pixels above the viewport) and, on a blank session, `viewArea` is null so the
default `flex-start` parked it at the **top** of the pane.

**Fix (one word)**: render the Factory with `variant:'embedded'`. `ui-conversation:16254` adds the
`uPhUma_embeddedBody` class only for that variant, and `16258` always emits `data-content-phase`,
so all four embedded branches come back (sticky composer, viewArea sizing, hero centring, settling
hiding) together with the official content width
`--dsh-chat-content-width:min(calc(100% - 32px),920px)`. The official subagent panel embeds a
conversation the same way (`dsh-client-ui-subagent:782-786` inside the host box at `:677` =
`{width:100%;min-width:0;height:100%;min-height:0;display:flex}`), and
`.dsh-mc-pane-body` matches that host contract. The previous version's
`container-type:inline-size` + `--dsh-chat-user-width:min(100cqw - 28px,920px)` width hack is
**deleted**.

**Hypotheses ruled out with evidence**: no `@container` rule can hide the composer in a narrow
pane (only two exist repo-wide, both keyed to nearer containers); `container-type`/`contain:layout`
above the scrollport cannot break sticky; `--dsh-composer-height` /
`--dsh-conversation-viewport-height` are written per pane by a ResizeObserver on the seat's own
parent and every consumer has a fallback.

> Production note: `SessionProvider` renders **no DOM** (React context + Fragment only). The test
> fake used to render a `div[data-provider]`, which would have broken the height chain — it now
> matches production so tests cannot mask that class of bug.

### 4.3 Grid

- Three equal columns (`repeat(3,minmax(0,1fr))`), container queries degrade to two at <=1100 px and
  one at <=720 px (the container is `.dsh-mc-root`'s `container-type:inline-size`).
- `grid-auto-rows:minmax(420px,1fr)`: one row fills the height, two rows share it, anything below
  420 px overflows into `overflow-y:auto`.
- Order is data: the store's `panes` array *is* the grid order; swapping only changes the array,
  and React keys (`sessionId`) move DOM nodes instead of remounting them (conversation state is
  preserved).

### 4.4 Drag reordering (R5/R6)

- **Handle**: an always-visible grip button at the top-right of each pane header (left of close),
  semi-transparent, brighter on hover, outlined on `:focus-visible`.
- **Grab semantics**: the handle drags immediately; the header needs 4 px of mouse travel, or a
  300 ms hold on touch/pen (so header clicks keep working as clicks).
- **Pointer capture** on the pane element, so move/up arrive even outside it; `Esc` (global
  capture-phase keydown) cancels.
- **Drop targeting**: `document.elementFromPoint` → `[data-mc-session]`, with a
  `getBoundingClientRect` fallback for layout-less environments. Self-targets are ignored; another
  pane = swap; empty space = move to end.
- **Feedback**: dragged pane `data-dragging`, hovered pane `data-drop-target`, a ghost card moved
  by writing `transform` through a ref (no per-frame React render); `MultiChatPane` is memoized so
  the official subtree is not reconciled during a drag.
- **Keyboard**: on the focused handle, `Ctrl/Cmd + Left/Right` is +/-1 and `Up/Down` is +/-column
  count (read from computed styles, defaulting to 3); edge moves are no-ops and other keys are
  untouched.

### 4.5 Retention and following

Each pane holds `sessions.retain(id, { source: 'multichat' })` and releases it on close; the
official `publishMain` only reads `retainedBy.mainView`, so our source never steals "current".
Retention waits for `list.phase === 'ready'` so restored panes are not misread before the catalog
baseline arrives; `retain` throws for unknown sessions, and the controller catches, drops the pane
and surfaces a notice instead of resurrecting anything. Closing the active pane focuses a sibling
first and suppresses the follower via `suppressedId`; without navigation the close is refused.

### 4.6 Persistence and migration (R10)

The key stays `dsh-multi-chat:v1`, writing `{version: 2, panes, maxPanes}`. Reads are validated as
untrusted input (non-empty string ids, deduped, truncated to the ceiling); the v1 `layout` field is
ignored (that mode is gone). Ceiling: default 6, hard cap 9.

### 4.7 Failure handling and visuals

`apply` is wrapped in try/catch (a throwing browser half fails the web boot); a pane-level
`PaneBoundary` contains one broken pane; entry-level failures are contained by the official
`SlotErrorBoundary`, which restores the default view. One tagged `<style>` element, `dsh-mc-`
prefixed classes, colours/borders exclusively from `--dsw-alias-*` / `--dsw-radius-*` tokens.

### 4.8 v0.2.1 fixes (located by reproducing in a real browser)

**F1 (critical) slow session switching + inconsistent highlight: mutual recursion from a
synchronous publish inside `retain`.** Reproduced in headless Chrome against the isolated
profile:

```
[dsh-multi-chat] session list handling failed: RangeError: Maximum call stack size exceeded  at syncReferences
[client-store] subscriber failed: RangeError: Maximum call stack size exceeded  at UiSession.watchMainRetention
Sidebar Session opening failed: RangeError: Maximum call stack size exceeded
```

`sessions.retain(id)` publishes the session list **synchronously** (`publishRetention` →
`list.set`), while `syncReferences()` stored the reference only *after* `retain()` returned — so the
nested list callback saw "this id is not retained yet", called `retain` again, published again, and
recurred until the stack overflowed. Every switch walked that path (hence "switching is slow"), and
the exceptions broke UiSession's main-binding projection, leaving the pane ring and the official
sidebar highlight disagreeing (the "blue border looks wrong" report).

Fixed in two layers: (1) a `pendingRetains` marker registered *before* the call, so a re-entrant
pass skips the id; (2) a `syncNow()` re-entrancy gate — while `syncing`, requests only set
`resyncRequested`, the current call finishes in up to four bounded passes, and any remainder is
deferred with `queueMicrotask` instead of deepening the stack.

Regression tests: the fake session controller in `tests/harness.mjs` now faithfully publishes from
inside `retain` (the exact trigger), and two new cases assert "one retain per session" plus "no
list-handling / sync / stack warnings" — the old code overflows on them.

**F2 stranded drags (the other source of the "wrong border").** Move/up listeners lived on the pane
elements only, so a pointer released outside the grid (sidebar, window edge, another app) never
delivered `pointerup`: the ghost card, the dragged pane's dashed outline and the target ring stayed
on screen, and the next move started a phantom drag from the stale press. Now the press records a
session and move/up/cancel/blur are handled on the **window** (capture phase); a new press resets any
previous session; events are validated by `pointerId`; and drop-target probing is throttled (60 ms or
12 px of travel) because `elementFromPoint` forces layout. New regression tests: release outside,
sub-threshold header press released outside, and a second press while one is pending.

**F3 selection ring rendering**: `border: .5px` plus `box-shadow: inset 0 0 0 1px` double-drew the
edge (fuzzy/offset at fractional device pixel ratios). The active pane now uses a single 2 px outer
ring (`box-shadow:0 0 0 2px color-mix(…)`), and the drop target is a **dashed, cooler** ring so the
two treatments can never be confused.

**F4 extra switching/scroll cost**: panes now receive `title`/`blank` primitives instead of the whole
row object (the list projection mints a new row on every publish, which defeated `React.memo` and
re-rendered every official conversation subtree); `onHandleKeyDown` reads the current order through a
ref so its identity is stable; sidebar row buttons use two primitive selectors instead of subscribing
to the whole snapshot.

**Honest verification boundary**: in the isolated profile's browser, the host's "new session" action
is a no-op without provider/workspace context, so the grid, drag and composer could not be exercised
end to end there. What this round verified live: the recursion is gone, the console is clean, sessions
open, and the plugin activates. The visual acceptance of grid/drag/composer stays with the user in
their own desktop profile (the plugin is installed; a restart applies it).

### 4.9 v0.2.2 fixes (located with live screenshots and numbers)

**F5 (critical) wrong registration point → the whole grid was remounted on every session switch.**
The previous version registered into `main.conversation` (`session-maybe`). The renderer remounts
`session-maybe` entries whenever the shell switches to a different session ("component-local state
must not leak between sessions"), so **every switch rebuilt the grid and all N conversation
subtrees**. That produced both reports at once:
- "the UI gets laggy as more conversations open" — the rebuild grows with N;
- "clicking the composer needs a second click" — the input being pressed was replaced mid-click, so
  the browser's focus landed on a dead node.

Fix: register into the **keyed `conversation` cell of `main`** (`root` scope) — the same replacement
semantics (a lower priority shadows the official conversation panel cell), but a root-scope cell is
never remounted by a session change. In addition, pane activation moved from `pointerdown` to
**`focusin` / `click`**, so the browser finishes its own focus work first. Live re-check (4 panes,
headless Chrome, onboarding modals dismissed):

```
one click into an inactive pane's composer → activeElement = DIV.Q7WfXG_input (the input itself)
                                             inComposer = true, and that pane became current
switch latency ≈ 24 ms (including CDP round-trips ⇒ about one frame)
```

**F6 cost with many panes**: as soon as panes exceed one row (>3) the grid sets `data-virtualize`,
which turns on `content-visibility:auto` + `contain-intrinsic-size:auto 420px` for panes, so
off-screen conversations skip layout/paint; persistence now writes only when the pane order or the
ceiling actually changes (a highlight change no longer touches synchronous storage). Live numbers:
**5 panes, 2651 DOM nodes total** (~400–900 per pane including the official conversation body),
console clean.

**F7 headless-verification gotcha (recorded to avoid false conclusions)**: a fresh profile opens two
onboarding modals ("内测声明" and "添加 API Key") whose mask (`div._mask_…`) swallows
`elementFromPoint` and synthetic clicks — dismiss them ("继续 / 稍后配置") before testing
interaction, or synthetic clicks appear to do nothing. The isolated profile cannot create listable
sessions without credentials, so the live grid checks were driven by **seeding the plugin's own
persisted pane set with real session ids**.

**F8 the toolbar wrapped into three lines in a narrow window (v0.2.3)**: every item in `.dsh-mc-bar`
could shrink and wrap, so in the ~490px floating session window it became "3 sessions / side by side",
"3/4 / cells", "drag the handle… / to reorder" — three lines that squeezed the conversation. Now:
`flex-wrap:nowrap` + `white-space:nowrap`, with `min-width:0` + ellipsis on the title/hint/usage, and
progressive disclosure by container width (`≤640px` drops the drag hint; `≤480px` drops the usage
counter and swaps the title for the compact "{count} panes" label, keeping the keep-only button). Row
height also yields to short windows: `minmax(min(420px,62vh),1fr)` → 397px rows in a 640px-tall window.
Live 490×640 check: toolbar **one line, 37px**, single column, composer visible, console clean.

**F9 narrow windows (the DSH floating session window) no longer get the grid (v0.2.4)**: that window is
only ~490px wide, where N panes stacked in one column are worse than the official single-session view.
The plugin is now gated by window width: below `innerWidth < 720` (the narrowest CSS breakpoint) it is
**fully inert** — it does not follow the shell's session, retains nothing, registers nothing, and
**writes nothing to localStorage** (the floating window shares storage with the main window, so a write
would clobber the pane set the main window owns). A `resize` listener switches both ways: narrowing
releases the references and hands the conversation area back; widening re-adopts the session the shell
shows and mounts the grid again. Unknown/zero widths read as "wide" (fail-open) so a missing signal can
never disable the feature. Live checks: **cold start at 490×640 = 0 grids / 0 toolbars / one official
conversation body with a working composer**; widening to 1680×1050 = 4 panes, 4 composers; narrowing to
520×700 = the official view again; console clean throughout.

**F10 the column count was hard-coded to three, leaving an empty column with two panes (v0.2.5)**:
`.dsh-mc-grid` used `repeat(3,minmax(0,1fr))`, so two panes occupied the first two columns and left a third
of the row empty (confirmed by the user's screenshot). It is now
`repeat(auto-fit,minmax(max(400px,30%),1fr))`: `auto-fit` **collapses the tracks no pane lands in**, so two
panes share the row; `max(400px,30%)` provides both the pane floor (~400px) and the three-per-row cap
(four 30% tracks can never fit, and once 30% exceeds 400px that percentage is the binding constraint).
Live numbers (1680px window, 1384px of grid content): two panes = 2×688px filling 100%; three =
3×456px; four = 3×456 + 1×456 (equal cells, the last row keeps its gap — confirmed with the user);
a 1150px window gives two columns; a 950px window gives two; console clean throughout.

**F11 the official turn navigator disappeared inside grid panes (v0.2.6)**: reported as "the conversation
history panel on the right is gone". The official `TurnNavigator` in `dsh-client-ui-chat` (the
fixed-pitch turn rail with its hover preview) carries its own rule

```
.<prefix>_frame{…position:absolute;right:12px;width:28px…}
@container (width<=900px){.<prefix>_frame{display:none}}
```

i.e. **the official UI hides it whenever the conversation is narrower than 900px**, and grid panes are
456–688px — so the element rendered but hid itself (live evidence: `display:"none"`,
`containerType:"inline-size"`, container width 447px, slot chain
`conversation.view → conversation.session → main → root`).

The fix leaves the official container semantics alone and adds one pane-scoped rule with higher
specificity: `.dsh-mc-pane [class*="<prefix>_frame"]{display:block}` (a class plus an attribute selector
beats the official class-only rule wherever it sits, and `display:block` is exactly what that div gets
from the UA sheet in the untouched official view). The build-specific prefix is parsed from the official
stylesheet at runtime; when it is absent nothing is injected. Panes clip their overflow, and both the
28px rail at `right:12px` and the `min(300px, 100cqw - 120px)` preview fit inside a pane, so nothing
bleeds into a neighbour.

Live re-check: inside the pane the element reports `display:"block"`, `marks:11`, `28×102px`, and the
screenshot shows the tick rail back at the pane's right edge.

## 5. Known limitations and risks

1. **The official conversation header is replaced** (breadcrumbs, view tabs, header actions) —
   inherent to replacing a single slot.
2. **Each pane keeps a session stream alive**; more panes cost more host work (default 6, cap 9).
3. **The plugin depends on the official internal `conversation.content` Factory** and its
   `embedded` variant semantics; if upstream removes it the plugin degrades to note cards instead
   of crashing.
4. **No auto-scroll while dragging** near the grid edge, so long grids need a scroll before the
   final drop.
5. **No in-browser visual check ran inside this session's sandbox**: Chrome/Edge's crashpad child
   is denied (`OpenProcess: access denied` → self-terminating), so `scripts/browser-e2e.mjs`
   (real-drag assertions + screenshot) ships as a tool for a normal machine. What did run here:
   jsdom real-DOM interaction tests (drag, keyboard, cancel), real `SlotCore` contract tests, and
   real-profile install + bundle-serving verification.
