/**
 * dsh-multi-chat — browser half (single-file client bundle).
 *
 * Loads in the web GUI through the `dsh.client` manifest declaration: the
 * client-modules loader only *registers* this factory and materializes it with
 * a synchronous CommonJS `require` when the entry activates, so the module
 * shape mirrors the official client bundles
 * (`window.__ModuleLoader__.load({ id, factory })`) and requires nothing but
 * the platform seed module `react`.
 *
 * Behaviour (full contract in docs/design.md):
 *
 * 1. Watches `ctx.sessions.list` for the session the shell currently shows
 *    (`retainedBy.mainView > 0`). Every new current session joins an ordered
 *    pane set, so clicking n sessions in the sidebar yields n panes.
 * 2. Keeps its own `sessions.retain(id, { source: 'multichat' })` reference per
 *    pane: without it the client retires a session's scope the moment the user
 *    navigates away, and the pane could not bind it.
 * 3. While 2+ panes are open, shadows the documented `main.conversation`
 *    replacement point (`single` slot, lower `priority`) and renders an equal
 *    cell grid — at most three panes per row, degrading to two/one by available
 *    width — with one session-scoped subtree per pane:
 *    `<SessionProvider session={reference}>` plus the official
 *    `conversation.content` Factory rendered as `variant: 'embedded'`.
 *
 *    The `embedded` variant is load-bearing, not cosmetic: the official
 *    `ConversationRoot` (which this plugin replaces) is what puts
 *    `[data-phase=active]` on the conversation root, and the composer's
 *    `position: sticky; bottom: 0` lives on
 *    `.uPhUma_root[data-phase=active] .uPhUma_composerSeat,
 *     .uPhUma_embeddedBody[data-content-phase=active] .uPhUma_composerSeat`.
 *    With `variant: 'main'` and no root, *both* halves of that selector die and
 *    the composer leaves the flow (it scrolls away with the transcript, and a
 *    blank session parks it at the top). `embedded` re-arms the second half via
 *    `data-content-phase`, which the Factory always renders. The official
 *    subagent panel embeds a conversation exactly this way.
 * 4. Panes are reorderable: a grip handle at the top-right of each pane header
 *    (and the header itself) starts a drag; dropping on another pane swaps the
 *    two, dropping on empty grid space moves the pane to the end, Esc cancels,
 *    and `Ctrl/⌘ + arrow keys` on the focused handle swaps with a neighbour.
 * 5. Adds one incremental action button per sidebar session row to add/remove
 *    that session from the pane set without changing the current session.
 *
 * Failure policy: activation never throws (a throwing browser half fails the
 * whole web boot); a broken pane is contained by a pane-level error boundary,
 * and a broken entry is contained by the official slot error boundary, which
 * abdicates the entry and restores the default conversation view.
 *
 * @module dsh-multi-chat/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-multi-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // #region constants

    /** Client plugin name (informational; the loader entry owns the module id). */
    const PLUGIN_NAME = 'dsh-multi-chat/client'
    /** localStorage key holding the persisted pane order and ceiling. */
    const STORAGE_KEY = 'dsh-multi-chat:v1'
    /** Persisted payload version (v2 dropped the old columns/rows `layout`). */
    const STORAGE_VERSION = 2
    /** Retention source name for pane-held session references. */
    const RETENTION_SOURCE = 'multichat'
    /**
     * Conversation-area replacement point. `main` is a **keyed, root-scope**
     * slot whose cell is selected by the active panel id (`'conversation'` for
     * the built-in conversation panel), and the slot docs define "lowest
     * priority renders" as the replacement mechanism.
     *
     * Registering HERE rather than into the session-maybe `main.conversation`
     * child matters for two live-reported bugs: the renderer remounts
     * `session-maybe` entries whenever the shell switches to a *different*
     * session ("component-local state must not leak between sessions"), so a
     * grid anchored there was fully re-created — every pane's conversation
     * subtree with it — on each session switch. That cost grew with the number
     * of open panes (the reported lag) and destroyed the input the user had just
     * clicked (the composer needed a second click to focus). A root-scope cell
     * keeps the grid mounted across session switches.
     */
    const SLOT_MAIN = 'main'
    /** Keyed cell of `main` that shows the conversation panel. */
    const MAIN_PANEL_KEY = 'conversation'
    /** Session-scoped child slot declared only to obtain the SessionProvider seat. */
    const SLOT_PANE = 'multichat.pane'
    /** Incremental sidebar session-row action list. */
    const SLOT_ROW_ACTION = 'sidebar.workspaces.session.row.action'
    /** Official conversation-body Factory (session-maybe scope). */
    const FACTORY_CONVERSATION_CONTENT = 'conversation.content'
    /**
     * Factory variant. `embedded` is the officially sanctioned embedding mode
     * (the subagent panel uses it) and the only one that keeps the phase-gated
     * composer rules alive without the official conversation root.
     */
    const CONVERSATION_VARIANT = 'embedded'
    /** Row id inside the sidebar action list (a fresh id extends, never replaces). */
    const ROW_ACTION_ID = 'multi-chat'
    /**
     * Shadowing priority for the conversation panel cell. The official entry
     * sits at 0 and the slot docs define "lowest renders" as the replacement
     * mechanism. Kept far from the dynamic-package allocator (which counts down
     * from 0).
     */
    const MAIN_CONVERSATION_PRIORITY = -1000
    /** Place of our row button among the official archive/pin buttons. */
    const ROW_ACTION_ORDER = 150
    /** Pane ceiling: default 6 (two full rows), hard cap 9 (three full rows). */
    const DEFAULT_MAX_PANES = 6
    const MIN_MAX_PANES = 1
    const MAX_MAX_PANES = 9
    /** Grid shape: at most this many equal cells per row. */
    const GRID_MAX_COLUMNS = 3
    /** Minimum comfortable pane height; taller grids scroll instead. */
    const GRID_MIN_ROW_PX = 420
    /** Pointer travel (px) before a header press becomes a drag. */
    const DRAG_THRESHOLD_PX = 4
    /** Touch/pen press-and-hold before a header press becomes a drag. */
    const TOUCH_LONG_PRESS_MS = 300
    /** Drop-target probe interval while dragging (elementFromPoint forces layout). */
    const DROP_PROBE_MS = 60
    /** …or probe early once the pointer travelled this far since the last probe. */
    const DROP_PROBE_TRAVEL_PX = 12
    /** Bounded sync passes before deferring the remainder off the current stack. */
    const MAX_SYNC_PASSES = 4
    /** Style tag identity (also how the HMR driver finds the tag on rebuild). */
    const STYLE_TAG_ID = 'dsh-multi-chat/index.css'

    const MESSAGES = {
      en: {
        'bar.title': '{count} sessions side by side',
        'bar.used': '{used}/{max} cells',
        'bar.onlyActive': 'Keep only active',
        'bar.onlyActiveTitle': 'Close every pane except the active session',
        'bar.dragHint': 'Drag a pane’s ⠿ handle to move it',
        'pane.aria': 'Pane {index}: {title}',
        'pane.running': 'This session is running',
        'pane.close': 'Close this pane',
        'pane.closeLocked': 'The active pane stays open — open another pane first',
        'pane.unavailable': 'This session is not available in the current client',
        'pane.closed': 'This session is not open',
        'pane.error': 'This pane failed to render',
        'handle.aria': 'Move “{title}” — drag, or press Ctrl with the arrow keys',
        'row.add': 'Show “{title}” side by side',
        'row.remove': 'Remove “{title}” from the side-by-side view',
        'notice.limit': 'At most {max} sessions at once',
        'notice.evicted': 'Pane limit reached — replaced the oldest pane',
        'notice.unknown': 'Session {id} is no longer available',
        'notice.moved': 'Pane order updated',
      },
      zh: {
        'bar.title': '{count} 个会话并排',
        'bar.used': '已用 {used}/{max} 格',
        'bar.onlyActive': '只保留当前',
        'bar.onlyActiveTitle': '关闭除当前会话以外的所有面板',
        'bar.dragHint': '拖动面板右上角 ⠿ 把手可调整位置',
        'pane.aria': '第 {index} 格：{title}',
        'pane.running': '该会话正在运行',
        'pane.close': '关闭该面板',
        'pane.closeLocked': '当前会话面板保持打开——请先打开另一个面板',
        'pane.unavailable': '该会话在当前客户端中不可用',
        'pane.closed': '该会话未打开',
        'pane.error': '该面板渲染失败',
        'handle.aria': '移动「{title}」——可拖动，或按住 Ctrl 加方向键',
        'row.add': '把「{title}」加入并排视图',
        'row.remove': '把「{title}」移出并排视图',
        'notice.limit': '最多同时显示 {max} 个会话',
        'notice.evicted': '已达面板上限，已替换最早的面板',
        'notice.unknown': '会话 {id} 已不可用',
        'notice.moved': '已更新面板顺序',
      },
    }

    // #endregion

    // #region i18n

    /**
     * Resolve the display language: the locale service first (when present),
     * then the document language the shell publishes, then the browser.
     * @param localeFace - optional `ctx.locale` face.
     * @returns a BCP-47-ish language tag, never empty.
     */
    function resolveLanguage(localeFace) {
      try {
        const snapshot = localeFace?.getSnapshot?.()
        const candidate =
          snapshot?.language ?? snapshot?.locale ?? snapshot?.current ?? snapshot?.tag
        if (typeof candidate === 'string' && candidate.length > 0) return candidate
      } catch {
        /* fall through */
      }
      try {
        const attribute = globalThis.document?.documentElement?.getAttribute?.('lang')
        if (typeof attribute === 'string' && attribute.length > 0) return attribute
      } catch {
        /* fall through */
      }
      try {
        const language = globalThis.navigator?.language
        if (typeof language === 'string' && language.length > 0) return language
      } catch {
        /* fall through */
      }
      return 'en'
    }

    /**
     * Build the translator used by every component in this bundle.
     * @param localeFace - optional locale service face, read on every call so a
     * language switch is picked up by the next render.
     * @returns `t(key, params)` with `{name}` interpolation and an English fallback.
     */
    function createTranslator(localeFace) {
      return function t(key, params) {
        const table = /^zh/i.test(resolveLanguage(localeFace)) ? MESSAGES.zh : MESSAGES.en
        const template = table[key] ?? MESSAGES.en[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/gu, (match, name) =>
          params[name] === undefined ? match : String(params[name]),
        )
      }
    }

    // #endregion

    // #region styles

    /**
     * Scope styles. Every color/border comes from `--dsw-alias-*` theme tokens
     * so light/dark themes and future rebrands work without changes.
     */
    const CSS = [
      '.dsh-mc-root{box-sizing:border-box;container-type:inline-size;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);flex-direction:column;min-width:0;height:100%;display:flex;position:relative}',
      '.dsh-mc-bar{align-items:center;gap:8px;border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);flex:none;min-height:34px;padding:4px 12px;font-size:12px;line-height:18px;display:flex}',
      '.dsh-mc-bar-title{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsh-mc-bar-count{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
      '.dsh-mc-bar-hint{color:var(--dsw-alias-label-caption)}',
      '.dsh-mc-bar-notice{color:var(--dsw-alias-state-warn-primary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.dsh-mc-bar-spacer{flex:1 1 auto}',
      '.dsh-mc-bar-btn{appearance:none;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:.5px solid transparent;border-radius:var(--dsw-radius-sm,6px);padding:2px 8px;font-size:12px;line-height:18px}',
      '.dsh-mc-bar-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      // Equal-cell grid: never more than three columns, degrading 3 → 2 → 1 by
      // available width; rows share the height, but never below a usable pane
      // height — beyond that the grid scrolls.
      '.dsh-mc-grid{flex:1 1 auto;gap:8px;min-height:0;padding:8px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:minmax(420px,1fr);overflow-y:auto}',
      '@container (width<=1100px){.dsh-mc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@container (width<=720px){.dsh-mc-grid{grid-template-columns:minmax(0,1fr)}}',
      '.dsh-mc-grid[data-count="1"]{gap:0;padding:0}',
      // Off-screen panes are the main cost once the grid scrolls: skip rendering
      // them (the remembered 420px keeps the row heights stable).
      '.dsh-mc-grid[data-virtualize] .dsh-mc-pane{content-visibility:auto;contain-intrinsic-size:auto 420px}',
      '.dsh-mc-pane{background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;min-width:0;min-height:0;display:flex;position:relative;overflow:hidden;transition:border-color .15s ease,box-shadow .15s ease,opacity .15s ease}',
      // One crisp outer ring for the current session. A border plus an inset
      // box-shadow double-drew the edge (visible as a fuzzy/offset outline at
      // fractional device pixel ratios), so the ring is a single outer shadow.
      '.dsh-mc-pane[data-active]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)}',
      '.dsh-mc-pane[data-dragging]{opacity:.45;border-style:dashed}',
      // The drop target is deliberately a different treatment from the active
      // ring (dashed + cooler colour) so the two can never be confused.
      '.dsh-mc-pane[data-drop-target]{border-color:var(--dsw-alias-label-primary-bluish);border-style:dashed;box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-primary-bluish) 55%, transparent)}',
      '.dsh-mc-pane[data-error]{border-color:var(--dsw-alias-state-error-primary)}',
      '.dsh-mc-pane-head{align-items:center;gap:6px;background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;padding:4px 6px 4px 8px;font-size:12px;line-height:18px;display:flex;cursor:grab;touch-action:none}',
      '.dsh-mc-pane-idx{color:var(--dsw-alias-label-caption);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;flex:none;justify-content:center;align-items:center;width:18px;height:18px;font-size:11px;font-variant-numeric:tabular-nums;display:inline-flex}',
      '.dsh-mc-pane[data-active] .dsh-mc-pane-idx{color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-state-business-primary)}',
      '.dsh-mc-dot{background:var(--dsw-alias-state-business-primary);border-radius:50%;flex:none;width:6px;height:6px;animation:dsh-mc-pulse 1.4s ease-in-out infinite}',
      '@keyframes dsh-mc-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '.dsh-mc-pane-title{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;overflow:hidden}',
      '.dsh-mc-pane[data-active] .dsh-mc-pane-title{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsh-mc-handle{appearance:none;cursor:grab;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:var(--dsw-radius-sm,6px);flex:none;justify-content:center;align-items:center;width:22px;height:22px;padding:0;display:inline-flex;opacity:.55;touch-action:none}',
      '.dsh-mc-handle:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-mc-handle:focus-visible{opacity:1;outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dsh-mc-handle[data-dragging]{cursor:grabbing;opacity:1;color:var(--dsw-alias-label-primary)}',
      '.dsh-mc-pane-close{appearance:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:var(--dsw-radius-sm,6px);flex:none;justify-content:center;align-items:center;width:22px;height:22px;padding:0;display:inline-flex}',
      '.dsh-mc-pane-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-mc-pane-close:disabled{cursor:default;opacity:.35}',
      // The official embedding host-box contract (same shape the subagent panel
      // uses): a definite-height flex column so the conversation body's
      // `flex:1;min-height:0` chain stays definite.
      '.dsh-mc-pane-body{flex:1 1 auto;flex-direction:column;min-width:0;min-height:0;display:flex}',
      '.dsh-mc-pane-note{color:var(--dsw-alias-label-tertiary);flex:1 1 auto;justify-content:center;align-items:center;padding:24px;text-align:center;font-size:13px;display:flex}',
      '.dsh-mc-ghost{z-index:60;pointer-events:none;align-items:center;gap:6px;max-width:280px;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);display:flex;position:fixed;top:0;left:0}',
      '.dsh-mc-ghost-idx{color:var(--dsw-alias-label-caption);font-size:11px;font-variant-numeric:tabular-nums}',
      '.dsh-mc-ghost-title{text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;overflow:hidden}',
      '.dsh-mc-rowbtn{appearance:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:var(--dsw-radius-sm,6px);align-items:center;gap:2px;height:22px;padding:0 4px;display:inline-flex;position:relative}',
      '.dsh-mc-rowbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-mc-rowbtn[data-open]{color:var(--dsw-alias-label-primary-bluish)}',
      '.dsh-mc-rowbtn[data-active]{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-mc-rowidx{font-size:10px;line-height:1;font-variant-numeric:tabular-nums}',
    ].join('\n')

    /**
     * Inject the stylesheet once, tagged the way the client HMR driver expects.
     * @returns a disposer removing this plugin's tag (no-op when absent).
     */
    function injectStyles() {
      try {
        const doc = globalThis.document
        if (doc?.head === undefined || typeof doc.createElement !== 'function') return () => {}
        const selector = `style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`
        if (doc.querySelector(selector) !== null) return () => {}
        const tag = doc.createElement('style')
        tag.dataset.plugin = 'dsh-multi-chat'
        tag.dataset.pluginCss = STYLE_TAG_ID
        tag.textContent = CSS
        doc.head.appendChild(tag)
        return () => {
          try {
            tag.remove()
          } catch {
            /* ignore */
          }
        }
      } catch (error) {
        console.warn('[dsh-multi-chat] style injection failed:', error)
        return () => {}
      }
    }

    // #endregion

    // #region store

    /**
     * Clamp a candidate pane ceiling.
     * @param value - untrusted candidate.
     * @returns an integer within [MIN_MAX_PANES, MAX_MAX_PANES].
     */
    function normalizeMaxPanes(value) {
      const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
      if (!Number.isFinite(numeric)) return DEFAULT_MAX_PANES
      return Math.min(MAX_MAX_PANES, Math.max(MIN_MAX_PANES, Math.trunc(numeric)))
    }

    /**
     * Keep one entry per session id, preserving order.
     * @param values - untrusted list.
     * @returns non-empty string ids, deduplicated.
     */
    function dedupeIds(values) {
      const seen = new Set()
      const result = []
      for (const value of values ?? []) {
        if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
        seen.add(value)
        result.push(value)
      }
      return result
    }

    /**
     * Validate a persisted payload (untrusted: it is user-writable storage).
     * v1 payloads carried a `layout` field for the old columns/rows modes; it is
     * dropped here, while the pane order and the ceiling carry over.
     * @param raw - `localStorage.getItem` result.
     * @param fallback - defaults for absent/invalid fields.
     * @returns a usable `{ panes, maxPanes }`.
     */
    function parsePersisted(raw, fallback) {
      const base = { panes: [], maxPanes: normalizeMaxPanes(fallback?.maxPanes) }
      if (typeof raw !== 'string' || raw.length === 0) return base
      let value
      try {
        value = JSON.parse(raw)
      } catch {
        return base
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return base
      const maxPanes = normalizeMaxPanes(value.maxPanes ?? fallback?.maxPanes)
      return { panes: dedupeIds(value.panes).slice(0, maxPanes), maxPanes }
    }

    /** Freeze one store snapshot (stable identity while nothing changes). */
    function freezeState(state) {
      return Object.freeze({
        panes: Object.freeze([...state.panes]),
        activeId: state.activeId,
        maxPanes: state.maxPanes,
        notice: state.notice === undefined ? undefined : Object.freeze({ ...state.notice }),
      })
    }

    /** Field-wise equality for two snapshots (drives notification suppression). */
    function sameState(left, right) {
      if (left === right) return true
      if (
        left.activeId !== right.activeId ||
        left.maxPanes !== right.maxPanes ||
        left.notice?.code !== right.notice?.code ||
        left.notice?.sessionId !== right.notice?.sessionId ||
        left.panes.length !== right.panes.length
      ) {
        return false
      }
      for (let index = 0; index < left.panes.length; index += 1) {
        if (left.panes[index] !== right.panes[index]) return false
      }
      return true
    }

    /**
     * The pane ledger: an ordered session set (which is also the grid order)
     * plus the active highlight, the pane ceiling and the last user-facing
     * notice.
     *
     * Pure view state — it touches neither Cordis services nor the network,
     * which is why it is unit-tested directly through `__internals`.
     */
    class MultiChatStore {
      /**
       * @param options - `storage` (localStorage-like), `maxPanes` seed,
       * `persist` (default true).
       */
      constructor(options) {
        const config = options ?? {}
        this.storage = config.storage
        this.persistEnabled = config.persist !== false
        this.listeners = new Set()
        this.suppressedId = undefined
        this.persistedSignature = undefined
        this.snapshot = freezeState({
          panes: [],
          activeId: undefined,
          maxPanes: normalizeMaxPanes(config.maxPanes),
          notice: undefined,
        })
      }

      /**
       * Subscribe to snapshot changes.
       * @param listener - called with no arguments after a commit.
       * @returns unsubscribe.
       */
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }

      /** @returns the current frozen snapshot (stable between changes). */
      getSnapshot() {
        return this.snapshot
      }

      /**
       * Commit a candidate snapshot, persist it and notify subscribers.
       * @param next - partial next state.
       * @returns the committed snapshot.
       */
      commit(next) {
        const candidate = freezeState({
          panes: next.panes ?? this.snapshot.panes,
          activeId: 'activeId' in next ? next.activeId : this.snapshot.activeId,
          maxPanes: next.maxPanes ?? this.snapshot.maxPanes,
          notice: 'notice' in next ? next.notice : this.snapshot.notice,
        })
        if (sameState(candidate, this.snapshot)) return this.snapshot
        this.snapshot = candidate
        this.persist()
        for (const listener of [...this.listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-multi-chat] store subscriber failed:', error)
          }
        }
        return candidate
      }

      /** Load the persisted pane order/ceiling, ignoring anything invalid. */
      hydrate() {
        const stored = parsePersisted(this.readRaw(), { maxPanes: this.snapshot.maxPanes })
        this.commit({
          panes: stored.panes,
          maxPanes: stored.maxPanes,
          activeId: undefined,
          notice: undefined,
        })
      }

      /** @returns the raw persisted payload, or undefined when unavailable. */
      readRaw() {
        try {
          return this.storage?.getItem?.(STORAGE_KEY) ?? undefined
        } catch {
          return undefined
        }
      }

      /** Write the persistable slice of the current state (best-effort). */
      persist() {
        if (!this.persistEnabled) return
        // Only the pane order and the ceiling are persisted: writing on every
        // highlight change would hit synchronous storage on each session switch.
        const signature = `${this.snapshot.panes.join('\u0000')}|${this.snapshot.maxPanes}`
        if (signature === this.persistedSignature) return
        this.persistedSignature = signature
        try {
          this.storage?.setItem?.(
            STORAGE_KEY,
            JSON.stringify({
              version: STORAGE_VERSION,
              panes: [...this.snapshot.panes],
              maxPanes: this.snapshot.maxPanes,
            }),
          )
        } catch {
          /* storage full/blocked — pane state is a view preference, not data */
        }
      }

      /**
       * Add one session to the pane set.
       * @param id - session identity.
       * @returns `'opened' | 'exists' | 'limit' | 'invalid'`.
       */
      open(id) {
        if (typeof id !== 'string' || id.length === 0) return 'invalid'
        if (this.snapshot.panes.includes(id)) return 'exists'
        if (this.snapshot.panes.length >= this.snapshot.maxPanes) {
          this.commit({ notice: { code: 'limit' } })
          return 'limit'
        }
        this.commit({ panes: [...this.snapshot.panes, id], notice: undefined })
        return 'opened'
      }

      /**
       * Remove one session from the pane set, refusing to empty it. When the
       * removed pane was active, the newest remaining pane takes the highlight.
       * @param id - session identity.
       * @returns `'closed' | 'missing' | 'last'`.
       */
      close(id) {
        const panes = this.snapshot.panes
        if (!panes.includes(id)) return 'missing'
        if (panes.length <= 1) return 'last'
        const remaining = panes.filter((pane) => pane !== id)
        const activeId =
          this.snapshot.activeId === id ? remaining[remaining.length - 1] : this.snapshot.activeId
        this.commit({ panes: remaining, activeId, notice: undefined })
        return 'closed'
      }

      /**
       * Force-remove a pane that turned out to be unusable (unknown session),
       * bypassing the "keep one" guard because the pane cannot render at all.
       * @param id - session identity.
       * @param notice - optional notice to surface.
       * @returns `'dropped' | 'missing'`.
       */
      drop(id, notice) {
        if (!this.snapshot.panes.includes(id)) return 'missing'
        const remaining = this.snapshot.panes.filter((pane) => pane !== id)
        const activeId =
          this.snapshot.activeId === id ? remaining[remaining.length - 1] : this.snapshot.activeId
        this.commit({ panes: remaining, activeId, notice })
        return 'dropped'
      }

      /** Flip one session in/out of the pane set. */
      toggle(id) {
        return this.snapshot.panes.includes(id) ? this.close(id) : this.open(id)
      }

      /**
       * Follow the session the shell currently shows.
       * @param id - current session identity.
       * @returns `'added' | 'kept' | 'evicted' | 'ignored' | 'invalid'`.
       */
      observeActive(id) {
        if (typeof id !== 'string' || id.length === 0) return 'invalid'
        if (this.suppressedId !== undefined) {
          if (this.suppressedId === id) return 'ignored'
          this.suppressedId = undefined
        }
        if (this.snapshot.panes.includes(id)) {
          this.commit({ activeId: id, notice: undefined })
          return 'kept'
        }
        if (this.snapshot.panes.length >= this.snapshot.maxPanes) {
          // Following the shell means the user just clicked a session, so the new
          // session becomes current and the OLDEST pane gives way.
          const victim = this.snapshot.panes[0]
          const remaining = this.snapshot.panes.filter((pane) => pane !== victim)
          this.commit({ panes: [...remaining, id], activeId: id, notice: { code: 'evicted' } })
          return 'evicted'
        }
        this.commit({ panes: [...this.snapshot.panes, id], activeId: id, notice: undefined })
        return 'added'
      }

      /**
       * Move the highlight without changing membership.
       * @param id - session identity.
       * @returns `'activated' | 'missing'`.
       */
      activate(id) {
        if (!this.snapshot.panes.includes(id)) return 'missing'
        this.commit({ activeId: id })
        return 'activated'
      }

      /**
       * Keep exactly one pane.
       * @param id - pane to keep.
       * @returns `'kept' | 'missing'`.
       */
      keepOnly(id) {
        if (typeof id !== 'string' || !this.snapshot.panes.includes(id)) return 'missing'
        this.commit({ panes: [id], activeId: id, notice: undefined })
        return 'kept'
      }

      /**
       * Exchange the grid positions of two panes (drag-and-drop semantics).
       * @param leftId - first pane.
       * @param rightId - second pane.
       * @returns `'swapped' | 'same' | 'missing'`.
       */
      swap(leftId, rightId) {
        const panes = this.snapshot.panes
        const leftIndex = panes.indexOf(leftId)
        const rightIndex = panes.indexOf(rightId)
        if (leftIndex < 0 || rightIndex < 0) return 'missing'
        if (leftIndex === rightIndex) return 'same'
        const next = [...panes]
        next[leftIndex] = rightId
        next[rightIndex] = leftId
        this.commit({ panes: next, notice: { code: 'moved' } })
        return 'swapped'
      }

      /**
       * Move one pane to the end of the grid order (drop on empty space).
       * @param id - session identity.
       * @returns `'moved' | 'already-last' | 'missing'`.
       */
      moveToEnd(id) {
        const panes = this.snapshot.panes
        const index = panes.indexOf(id)
        if (index < 0) return 'missing'
        if (index === panes.length - 1) return 'already-last'
        const next = panes.filter((pane) => pane !== id)
        next.push(id)
        this.commit({ panes: next, notice: { code: 'moved' } })
        return 'moved'
      }

      /**
       * Change the pane ceiling, trimming the oldest panes if needed.
       * @param value - candidate ceiling.
       * @returns the applied ceiling.
       */
      setMaxPanes(value) {
        const maxPanes = normalizeMaxPanes(value)
        let panes = [...this.snapshot.panes]
        while (panes.length > maxPanes) {
          const victim = panes.find((pane) => pane !== this.snapshot.activeId) ?? panes[0]
          panes = panes.filter((pane) => pane !== victim)
        }
        this.commit({ maxPanes, panes, notice: undefined })
        return maxPanes
      }

      /** Clear the current notice. */
      clearNotice() {
        this.commit({ notice: undefined })
      }

      /**
       * Suppress the follow-watcher for one id until a different session
       * becomes current (used when the user closes the active pane).
       * @param id - session identity to suppress.
       */
      suppress(id) {
        this.suppressedId = id
      }
    }

    // #endregion

    // #region service helpers

    /**
     * Read one optional client service without assuming a context shape.
     * @param ctx - client context.
     * @param name - service name.
     * @returns the service, or undefined.
     */
    function readService(ctx, name) {
      try {
        if (typeof ctx?.get === 'function') return ctx.get(name)
        return ctx?.[name]
      } catch {
        return undefined
      }
    }

    /** @returns a usable localStorage, or undefined (blocked/private mode). */
    function safeStorage() {
      try {
        const storage = globalThis.localStorage
        if (storage === undefined || storage === null) return undefined
        const probe = 'dsh-multi-chat:probe'
        storage.setItem(probe, '1')
        storage.removeItem(probe)
        return storage
      } catch {
        return undefined
      }
    }

    /**
     * The global that owns DOM events. In the browser `window` IS the global,
     * but a layout-less test DOM exposes it separately, so prefer it when set.
     * @returns an event target (or the plain global as a safe last resort).
     */
    function eventGlobal() {
      try {
        return globalThis.window ?? globalThis
      } catch {
        return globalThis
      }
    }

    /**
     * Defer work off the current stack without depending on a timer.
     * @param callback - work to run in a microtask.
     */
    function scheduleMicrotask(callback) {
      try {
        queueMicrotask(callback)
      } catch {
        Promise.resolve().then(callback)
      }
    }

    /** @returns whether one session row is the shell's current session. */
    function isMainRow(row) {
      return row !== undefined && row !== null && (row.retainedBy?.mainView ?? 0) > 0
    }

    /**
     * The session the shell currently shows in the conversation area.
     * @param sessions - `ctx.sessions` client controller.
     * @returns the session id, or undefined while none is current.
     */
    function mainSessionIdOf(sessions) {
      if (sessions === undefined || sessions === null) return undefined
      let list
      try {
        list = sessions.list?.getSnapshot?.()
      } catch {
        return undefined
      }
      const byId = list?.byId
      if (byId === undefined || byId === null) return undefined
      const ids = Array.isArray(list.ids) ? list.ids : Object.keys(byId)
      for (const id of ids) if (isMainRow(byId[id])) return id
      for (const id of Object.keys(byId)) if (isMainRow(byId[id])) return id
      return undefined
    }

    /**
     * Resolve the pane id under a viewport point (for drop targeting).
     * @param point - `{x, y}` in client coordinates.
     * @param draggedId - the pane being dragged (never its own target).
     * @param layout - `{ elements }`: per-pane elements for the rect fallback.
     * @returns the target session id, or undefined for "empty grid space".
     */
    function paneIdAtPoint(point, draggedId, layout) {
      try {
        const found = globalThis.document?.elementFromPoint?.(point.x, point.y)
        const id = found?.closest?.('[data-mc-session]')?.getAttribute?.('data-mc-session')
        if (typeof id === 'string' && id.length > 0) return id === draggedId ? undefined : id
      } catch {
        /* fall through to the rect probe */
      }
      for (const [id, element] of layout?.elements ?? []) {
        if (id === draggedId) continue
        try {
          const rect = element.getBoundingClientRect()
          if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
            return id
          }
        } catch {
          /* ignore */
        }
      }
      return undefined
    }

    /**
     * Grid neighbour for a keyboard swap request.
     * @param order - pane ids in grid order.
     * @param index - moving pane index.
     * @param key - `ArrowLeft|ArrowRight|ArrowUp|ArrowDown`.
     * @param columns - current column count (for up/down steps).
     * @returns the neighbour index, or undefined when the move leaves the grid.
     */
    function keyboardSwapTarget(order, index, key, columns) {
      const step =
        key === 'ArrowLeft'
          ? -1
          : key === 'ArrowRight'
            ? 1
            : key === 'ArrowUp'
              ? -columns
              : key === 'ArrowDown'
                ? columns
                : 0
      if (step === 0 || !Number.isFinite(step)) return undefined
      const next = index + step
      return next >= 0 && next < (order?.length ?? 0) ? next : undefined
    }

    /**
     * Column count of the rendered grid (falls back to the 3-column maximum
     * when computed styles are unavailable, e.g. in a layout-less test DOM).
     * @param element - the grid element.
     * @returns a positive column count.
     */
    function gridColumnCount(element) {
      try {
        const tracks = globalThis.getComputedStyle?.(element)?.gridTemplateColumns
        if (typeof tracks === 'string' && tracks.length > 0) {
          const count = tracks.split(/\s+/u).filter((track) => track.length > 0 && track !== 'none').length
          if (count > 0) return count
        }
      } catch {
        /* ignore */
      }
      return GRID_MAX_COLUMNS
    }

    // #endregion

    // #region components

    /** Two-pane glyph used by the sidebar row button. */
    function PanesGlyph(props) {
      const size = typeof props?.size === 'number' ? props.size : 14
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 1.6, y: 2.6, width: 5.4, height: 10.8, rx: 1.3 }),
        h('rect', { x: 9, y: 2.6, width: 5.4, height: 10.8, rx: 1.3, strokeOpacity: 0.55 }),
      )
    }

    /** Grip glyph for the pane drag handle. */
    function GripGlyph() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 12 12',
          fill: 'currentColor',
          'aria-hidden': true,
        },
        ...[2, 6, 10].flatMap((y) =>
          [3, 9].map((x) => h('circle', { key: `${x}-${y}`, cx: x, cy: y, r: 1.05 })),
        ),
      )
    }

    /** Close glyph for one pane header. */
    function CloseGlyph() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 4l8 8M12 4l-8 8' }),
      )
    }

    /**
     * Pane-level error boundary: one broken session must not take down the
     * grid (and must not abdicate the whole conversation entry).
     */
    class PaneBoundary extends React.Component {
      /** @param props - `sessionId` + `t`. */
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      /** @returns the failed state for the next render pass. */
      static getDerivedStateFromError() {
        return { failed: true }
      }

      /** @param error - the render error. */
      componentDidCatch(error) {
        console.error(`[dsh-multi-chat] pane "${this.props.sessionId}" crashed:`, error)
      }

      /** @returns the contained subtree or the pane-level failure card. */
      render() {
        if (this.state.failed) {
          return h(
            'section',
            { className: 'dsh-mc-pane', 'data-error': '', 'data-mc-session': this.props.sessionId },
            h('div', { className: 'dsh-mc-pane-note' }, this.props.t('pane.error')),
          )
        }
        return this.props.children
      }
    }

    /** The floating card that follows the pointer while a pane is dragged. */
    const DragGhost = React.forwardRef(function DragGhost(props, ref) {
      return h(
        'div',
        {
          className: 'dsh-mc-ghost',
          'data-mc-ghost': '',
          'data-mc-session': props.sessionId,
          ref,
          'aria-hidden': true,
        },
        h(GripGlyph, null),
        h('span', { className: 'dsh-mc-ghost-idx' }, String(props.index + 1)),
        h('span', { className: 'dsh-mc-ghost-title' }, props.title),
      )
    })

    /**
     * Pane header: sequence badge, running dot, title, move handle, close.
     * The handle is the always-visible drag affordance at the top-right.
     */
    function MultiChatPaneHeader(props) {
      const { index, title, active, running, canClose, dragging, onClose, onHandleKeyDown, t } = props
      return h(
        'header',
        { className: 'dsh-mc-pane-head', 'data-mc-head': '' },
        h('span', { className: 'dsh-mc-pane-idx', 'data-active': active ? '' : undefined }, String(index + 1)),
        running
          ? h('span', { className: 'dsh-mc-dot', title: t('pane.running'), 'aria-hidden': true })
          : null,
        h('span', { className: 'dsh-mc-pane-title', title }, title),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-mc-handle',
            'data-drag-handle': '',
            'data-dragging': dragging ? '' : undefined,
            title: t('handle.aria', { title }),
            'aria-label': t('handle.aria', { title }),
            onKeyDown: onHandleKeyDown,
          },
          h(GripGlyph, null),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-mc-pane-close',
            title: canClose ? t('pane.close') : t('pane.closeLocked'),
            'aria-label': t('pane.close'),
            disabled: !canClose,
            onClick: (event) => {
              event.stopPropagation()
              if (canClose) onClose()
            },
          },
          h(CloseGlyph, null),
        ),
      )
    }

    /**
     * One session pane: binds the session through `SessionProvider` and renders
     * the official conversation body Factory in its embeddable variant.
     *
     * Memoized: the drag feedback re-renders the root on every hovered-cell
     * change, and the official transcript must not be reconciled for that.
     */
    const MultiChatPane = React.memo(function MultiChatPane(props) {
      const {
        sessionId,
        index,
        active,
        title: rawTitle,
        blank,
        running,
        reference,
        renderFactorySlot,
        SessionProvider,
        dragging,
        dropTarget,
        onFocusPane,
        onClosePane,
        onHandleKeyDown,
        onPointerDown,
        onPaneFocus,
        onPaneClick,
        setPaneElement,
        t,
      } = props
      const title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : sessionId
      const hero = blank === true
      const phase = blank === undefined ? 'settling' : hero ? 'hero' : 'active'
      const attachPane = React.useCallback(
        (element) => setPaneElement(sessionId, element),
        [sessionId, setPaneElement],
      )
      const body =
        reference === undefined
          ? h('div', { className: 'dsh-mc-pane-note' }, t('pane.unavailable'))
          : h(
              SessionProvider,
              {
                session: reference,
                empty: () => h('div', { className: 'dsh-mc-pane-note' }, t('pane.closed')),
              },
              h(
                'div',
                { className: 'dsh-mc-pane-body' },
                renderFactorySlot(FACTORY_CONVERSATION_CONTENT, {
                  variant: CONVERSATION_VARIANT,
                  phase,
                  hero,
                }),
              ),
            )
      return h(
        'section',
        {
          className: 'dsh-mc-pane',
          'data-mc-session': sessionId,
          'data-mc-index': String(index),
          'data-active': active ? '' : undefined,
          'data-dragging': dragging ? '' : undefined,
          'data-drop-target': dropTarget ? '' : undefined,
          'aria-label': t('pane.aria', { index: index + 1, title }),
          ref: attachPane,
          onPointerDown: (event) => onPointerDown(event, sessionId, active),
          onFocusCapture: (event) => onPaneFocus(event, sessionId, active),
          onClick: (event) => onPaneClick(event, sessionId, active),
        },
        h(MultiChatPaneHeader, {
          index,
          title,
          active,
          running,
          canClose: props.canClose,
          dragging,
          onClose: () => onClosePane(sessionId),
          onHandleKeyDown: (event) => onHandleKeyDown(event, sessionId),
          t,
        }),
        body,
      )
    })

    /** Grid toolbar: pane count, cell usage, notice, keep-one action. */
    function MultiChatBar(props) {
      const { state, t, keepOnlyActive } = props
      const notice = state.notice
      return h(
        'div',
        { className: 'dsh-mc-bar', 'data-window-drag': true },
        h('span', { className: 'dsh-mc-bar-title' }, t('bar.title', { count: state.panes.length })),
        h(
          'span',
          { className: 'dsh-mc-bar-count' },
          t('bar.used', { used: state.panes.length, max: state.maxPanes }),
        ),
        h('span', { className: 'dsh-mc-bar-hint' }, t('bar.dragHint')),
        notice === undefined
          ? null
          : h(
              'span',
              { className: 'dsh-mc-bar-notice', role: 'status' },
              t(`notice.${notice.code}`, { max: state.maxPanes, id: notice.sessionId }),
            ),
        h('span', { className: 'dsh-mc-bar-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-mc-bar-btn',
            title: t('bar.onlyActiveTitle'),
            onClick: () => keepOnlyActive(),
          },
          t('bar.onlyActive'),
        ),
      )
    }

    /**
     * The `main.conversation` occupant while 2+ panes are open: an equal-cell
     * grid (max three per row) of session panes, the current session
     * highlighted, every pane reorderable by dragging its handle.
     */
    function MultiChatRoot(props) {
      const {
        useMultiChat,
        useSessions,
        useSessionStatus,
        renderFactorySlot,
        SessionProvider,
        getReference,
        focusPane,
        closePane,
        swapPanes,
        movePaneToEnd,
        keepOnlyActive,
        canClosePane,
        t,
      } = props
      const state = useMultiChat((value) => value)
      const rows = useSessions((value) => value?.byId)
      const status = useSessionStatus((value) => value)

      // Drag interaction state is deliberately NOT in the store: it is ephemeral
      // view state, and only two panes ever change while a drag is active.
      const gridRef = React.useRef(null)
      const ghostRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const paneElements = React.useRef(new Map())
      const pointer = React.useRef({ x: 0, y: 0 })
      const [drag, setDrag] = React.useState(null)

      /** Track one pane's element for the drop-target rect fallback. */
      const setPaneElement = React.useCallback((sessionId, element) => {
        if (element === null || element === undefined) paneElements.current.delete(sessionId)
        else paneElements.current.set(sessionId, element)
      }, [])

      const applyGhostTransform = React.useCallback(() => {
        const ghost = ghostRef.current
        if (ghost === null || ghost === undefined) return
        ghost.style.transform = `translate3d(${pointer.current.x + 14}px, ${pointer.current.y + 14}px, 0)`
      }, [])

      React.useEffect(() => {
        if (drag !== null) applyGhostTransform()
      }, [drag, applyGhostTransform])

      const endDrag = React.useCallback((options) => {
        const session = dragRef.current
        if (session === null) return
        if (session.longPressTimer !== undefined) clearTimeout(session.longPressTimer)
        dragRef.current = null
        setDrag(null)
        if (options?.commit === true && session.started === true) {
          const targetId = session.targetId
          if (typeof targetId === 'string' && targetId.length > 0 && targetId !== session.id) {
            swapPanes(session.id, targetId)
          } else {
            movePaneToEnd(session.id)
          }
        }
      }, [movePaneToEnd, swapPanes])

      const startDrag = React.useCallback((session) => {
        if (session.started) return
        session.started = true
        setDrag({ id: session.id, targetId: undefined })
      }, [])

      const onPointerDown = React.useCallback(
        (event, sessionId, active) => {
          if (event.button !== undefined && event.button !== 0 && event.pointerType !== 'touch') return
          // A press that arrives while a previous one never saw its pointerup
          // must not stack up: reset first (belt and braces next to the
          // window-level listeners below).
          if (dragRef.current !== null) endDrag({ commit: false })
          const target = event.target
          const handle = target?.closest?.('[data-drag-handle]')
          const head = target?.closest?.('[data-mc-head]')
          const button = target?.closest?.('button')
          pointer.current = { x: event.clientX, y: event.clientY }
          const session = {
            id: sessionId,
            pointerId: event.pointerId,
            pointerType: event.pointerType ?? 'mouse',
            startX: event.clientX,
            startY: event.clientY,
            started: false,
            targetId: undefined,
            lastProbe: 0,
            mode: undefined,
            longPressTimer: undefined,
            active,
          }
          if (handle !== null && handle !== undefined) {
            event.preventDefault()
            session.mode = 'handle'
            dragRef.current = session
            startDrag(session)
            return
          }
          if (head !== null && head !== undefined && (button === null || button === undefined)) {
            session.mode = 'header'
            dragRef.current = session
            if (session.pointerType === 'touch' || session.pointerType === 'pen') {
              session.longPressTimer = setTimeout(() => startDrag(session), TOUCH_LONG_PRESS_MS)
            }
            return
          }
          // Content presses are left entirely to the browser: stealing the
          // pointerdown here used to break the click-to-focus of the composer
          // (the shell switch invalidated the node being focused). Activation
          // happens on focusin / click instead (see the panel below), i.e. after
          // the browser has done its own focus work.
        },
        [endDrag, startDrag],
      )

      /**
       * Window-level pointer tracking. Pane-level handlers used to be the only
       * path, so a pointer released outside the panes (sidebar, window edge,
       * another app) never delivered its `pointerup` and left a stranded drag:
       * a ghost card and a drop ring that would not go away, plus a phantom drag
       * starting on the next move. Listening on the window fixes that class.
       */
      const onWindowPointerMove = React.useCallback(
        (event) => {
          const session = dragRef.current
          if (session === null) return
          if (session.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== session.pointerId) {
            return
          }
          pointer.current = { x: event.clientX, y: event.clientY }
          if (session.started !== true) {
            const travel = Math.hypot(event.clientX - session.startX, event.clientY - session.startY)
            if (travel < DRAG_THRESHOLD_PX) return
            startDrag(session)
          }
          applyGhostTransform()
          // elementFromPoint forces layout, so probe on a budget (time OR travel)
          // while the ghost keeps following the pointer every frame.
          const now = Date.now()
          const last = session.lastProbePoint ?? { x: session.startX, y: session.startY }
          const travelled = Math.hypot(event.clientX - last.x, event.clientY - last.y)
          if (now - session.lastProbe < DROP_PROBE_MS && travelled < DROP_PROBE_TRAVEL_PX) return
          session.lastProbe = now
          session.lastProbePoint = { x: event.clientX, y: event.clientY }
          const targetId = paneIdAtPoint(pointer.current, session.id, { elements: paneElements.current })
          if (targetId !== session.targetId) {
            session.targetId = targetId
            setDrag((current) => (current === null ? current : { ...current, targetId }))
          }
        },
        [applyGhostTransform, startDrag],
      )

      const onWindowPointerUp = React.useCallback(
        (event) => {
          const session = dragRef.current
          if (session === null) return
          if (session.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== session.pointerId) {
            return
          }
          // Presses that never travelled are simply released: pane activation is
          // driven by focusin/click, never by the press itself.
          endDrag({ commit: session.started === true })
        },
        [endDrag],
      )

      const onWindowPointerCancel = React.useCallback(() => {
        endDrag({ commit: false })
      }, [endDrag])

      React.useEffect(() => {
        const target = eventGlobal()
        const onBlur = () => endDrag({ commit: false })
        target.addEventListener?.('pointermove', onWindowPointerMove, true)
        target.addEventListener?.('pointerup', onWindowPointerUp, true)
        target.addEventListener?.('pointercancel', onWindowPointerCancel, true)
        target.addEventListener?.('blur', onBlur, true)
        return () => {
          target.removeEventListener?.('pointermove', onWindowPointerMove, true)
          target.removeEventListener?.('pointerup', onWindowPointerUp, true)
          target.removeEventListener?.('pointercancel', onWindowPointerCancel, true)
          target.removeEventListener?.('blur', onBlur, true)
        }
      }, [endDrag, onWindowPointerCancel, onWindowPointerMove, onWindowPointerUp])

      const panesRef = React.useRef(state.panes)
      panesRef.current = state.panes

      /**
       * Make one pane the shell's current session. Wired to focusin/click rather
       * than pointerdown so the browser's own focus handling (clicking straight
       * into a pane's composer) always lands first.
       */
      const activatePane = React.useCallback(
        (sessionId, active) => {
          if (active === true) return
          focusPane(sessionId)
        },
        [focusPane],
      )

      const onPaneFocus = React.useCallback(
        (event, sessionId, active) => {
          activatePane(sessionId, active)
        },
        [activatePane],
      )

      const onPaneClick = React.useCallback(
        (event, sessionId, active) => {
          if (active === true) return
          const target = event.target
          if (target?.closest?.('button')) return
          if (target?.closest?.('[data-drag-handle]')) return
          activatePane(sessionId, active)
        },
        [activatePane],
      )

      const onHandleKeyDown = React.useCallback(
        (event, sessionId) => {
          if (!(event.ctrlKey || event.metaKey)) return
          const order = panesRef.current
          const index = order.indexOf(sessionId)
          if (index < 0) return
          const next = keyboardSwapTarget(order, index, event.key, gridColumnCount(gridRef.current))
          if (next === undefined) return
          event.preventDefault()
          swapPanes(sessionId, order[next])
        },
        [swapPanes],
      )

      React.useEffect(() => {
        if (drag === null) return undefined
        const target = eventGlobal()
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          endDrag({ commit: false })
        }
        target.addEventListener?.('keydown', onKeyDown, true)
        return () => target.removeEventListener?.('keydown', onKeyDown, true)
      }, [drag, endDrag])

      const draggingRow = drag === null ? undefined : rows?.[drag.id]

      return h(
        'div',
        { className: 'dsh-mc-root', 'data-count': String(state.panes.length) },
        h(MultiChatBar, { state, t, keepOnlyActive }),
        h(
          'div',
          {
            className: 'dsh-mc-grid',
            'data-count': String(state.panes.length),
            // Once the grid is guaranteed to scroll (more panes than one full
            // row), let the browser skip rendering off-screen panes entirely.
            'data-virtualize':
              state.panes.length > GRID_MAX_COLUMNS ? '' : undefined,
            ref: gridRef,
          },
          state.panes.map((sessionId, index) => {
            const row = rows?.[sessionId]
            return h(
              PaneBoundary,
              { key: sessionId, sessionId, t },
              h(MultiChatPane, {
                sessionId,
                index,
                active: sessionId === state.activeId,
                // Primitives, not the row object: the list projection mints a new
                // row on every publish, which would defeat the memo and re-render
                // every official conversation subtree on unrelated churn.
                title: row?.displayTitle ?? row?.title,
                blank: row === undefined ? undefined : row.blank === true,
                running: status?.get?.(sessionId)?.running === true,
                reference: getReference(sessionId),
                renderFactorySlot,
                SessionProvider,
                canClose: canClosePane(sessionId),
                dragging: drag !== null && drag.id === sessionId,
                dropTarget: drag !== null && drag.targetId === sessionId,
                onFocusPane: focusPane,
                onClosePane: closePane,
                onHandleKeyDown,
                onPointerDown,
                onPaneFocus,
                onPaneClick,
                setPaneElement,
                t,
              }),
            )
          }),
        ),
        drag === null
          ? null
          : h(DragGhost, {
              sessionId: drag.id,
              index: Math.max(0, state.panes.indexOf(drag.id)),
              title: draggingRow?.displayTitle ?? draggingRow?.title ?? drag.id,
              ref: ghostRef,
            }),
      )
    }

    /**
     * Incremental sidebar session-row action: add/remove one session from the
     * pane set without navigating (the row click keeps navigating, and the
     * follow-watcher turns that into a pane).
     */
    function SessionRowAction(props) {
      const { sessionId, displayTitle, useMultiChat, togglePane, t } = props
      // Primitive selectors: a row button only re-renders when ITS index or
      // active flag changes, not on every store commit.
      const index = useMultiChat((value) => value.panes.indexOf(sessionId))
      const active = useMultiChat((value) => value.activeId === sessionId)
      const open = index >= 0
      const label = t(open ? 'row.remove' : 'row.add', { title: displayTitle ?? sessionId })
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-mc-rowbtn',
          'data-open': open ? '' : undefined,
          'data-active': active ? '' : undefined,
          title: label,
          'aria-label': label,
          'aria-pressed': open,
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            togglePane(sessionId)
          },
        },
        h(PanesGlyph, null),
        open ? h('span', { className: 'dsh-mc-rowidx' }, String(index + 1)) : null,
      )
    }

    // #endregion

    // #region controller

    /**
     * Wire one activation: follow the current session, keep pane sessions
     * retained, and mount/unmount the slot contributions as the pane count
     * crosses the single-pane boundary.
     *
     * @param options - `ctx`, `slots`, optional `sessions`, `localeFace`,
     * `storage`, `maxPanes`, `persist`.
     * @returns the controller face used by `apply` and the test suites.
     */
    function createController(options) {
      const ctx = options?.ctx
      const slots = options?.slots
      const sessions = options?.sessions
      const t = createTranslator(options?.localeFace)
      const store = new MultiChatStore({
        storage: options?.storage,
        maxPanes: options?.maxPanes,
        persist: options?.persist,
      })
      const references = new Map()
      /**
       * Ids whose `retain()` call is still on the stack. `retain` publishes the
       * retention snapshot SYNCHRONOUSLY, which re-enters `onListChange` →
       * `syncNow` before the reference could be stored — without this marker the
       * same id is retained again from inside its own retain call, and the
       * mutual recursion overflows the stack (observed in a real browser).
       */
      const pendingRetains = new Set()
      const disposers = []
      let slotDisposer
      let listReady = false
      let disposed = false
      let syncing = false
      let resyncRequested = false

      try {
        store.hydrate()
      } catch (error) {
        console.warn('[dsh-multi-chat] could not restore the pane set:', error)
      }

      // ---- current-session follow -------------------------------------------

      /** @returns the session the shell currently shows. */
      function mainSessionId() {
        return mainSessionIdOf(sessions)
      }

      /** React to a sessions-list change: follow the current session. */
      function onListChange() {
        if (disposed || sessions === undefined) return
        try {
          if (sessions.list?.getSnapshot?.()?.phase === 'ready') listReady = true
          const id = mainSessionId()
          if (id !== undefined) store.observeActive(id)
        } catch (error) {
          console.warn('[dsh-multi-chat] session list handling failed:', error)
        }
        syncNow()
      }

      // ---- retention --------------------------------------------------------

      /** Release one session reference, tolerating an already-dead reference. */
      function releaseReference(reference) {
        try {
          reference?.release?.()
        } catch {
          /* the controller already retired it */
        }
      }

      /** Drop a pane whose session the client cannot retain (unknown/deleted). */
      function dropUnknownPane(id, error) {
        console.warn(`[dsh-multi-chat] dropping unavailable pane "${id}":`, error?.message ?? error)
        store.drop(id, { code: 'unknown', sessionId: id })
      }

      /** Keep exactly one live reference per pane. */
      function syncReferences() {
        if (sessions === undefined || disposed) return
        const wanted = new Set(store.getSnapshot().panes)
        for (const [id, reference] of [...references]) {
          if (wanted.has(id)) continue
          references.delete(id)
          // `release()` also publishes synchronously → the guard in syncNow()
          // turns that into another pass instead of a deeper stack.
          releaseReference(reference)
        }
        for (const id of wanted) {
          if (references.has(id) || pendingRetains.has(id) || !listReady) continue
          if (typeof sessions.retain !== 'function') return
          pendingRetains.add(id)
          try {
            references.set(id, sessions.retain(id, { source: RETENTION_SOURCE }))
          } catch (error) {
            dropUnknownPane(id, error)
          } finally {
            pendingRetains.delete(id)
          }
        }
      }

      /**
       * Run the retention + registration sync exactly once per stack, marking a
       * follow-up pass when the session controller published from inside our own
       * call. This is the guard that keeps `retain`/`release` re-entrancy from
       * recursing without bound.
       */
      function syncNow() {
        if (disposed) return
        if (syncing) {
          resyncRequested = true
          return
        }
        syncing = true
        try {
          let passes = 0
          do {
            resyncRequested = false
            syncReferences()
            syncRegistration()
            passes += 1
          } while (resyncRequested && passes < MAX_SYNC_PASSES)
        } catch (error) {
          console.error('[dsh-multi-chat] sync failed:', error)
        } finally {
          syncing = false
        }
        if (resyncRequested) {
          resyncRequested = false
          scheduleMicrotask(syncNow)
        }
      }

      /**
       * Resolve a pane's live session reference for `SessionProvider`.
       * @param id - session identity.
       * @returns the reference while it is current, else undefined (never throws).
       */
      function getReference(id) {
        const reference = references.get(id)
        if (reference === undefined) return undefined
        try {
          const binding = reference.binding
          if (binding === undefined) return undefined
          const live = sessions?.binding?.(id)
          if (live !== undefined && live !== reference.binding) return undefined
          return reference
        } catch {
          return undefined
        }
      }

      // ---- navigation -------------------------------------------------------

      /** @returns whether the shell exposes programmatic session navigation. */
      function canNavigate() {
        const api = readService(ctx, 'uiWorkspace')
        return api !== undefined && typeof api.openSession === 'function'
      }

      /**
       * Make one pane the shell's current session (moves the official sidebar
       * highlight too).
       * @param id - session identity.
       * @returns whether navigation was issued.
       */
      function focusPane(id) {
        const api = readService(ctx, 'uiWorkspace')
        if (api === undefined || typeof api.openSession !== 'function') {
          store.activate(id)
          return false
        }
        try {
          api.openSession(id)
          return true
        } catch (error) {
          console.warn(`[dsh-multi-chat] could not focus session "${id}":`, error)
          store.activate(id)
          return false
        }
      }

      /**
       * Close one pane. The active pane can only close by handing the shell to
       * another pane first (and suppressing the follow-watcher meanwhile).
       * @param id - session identity.
       * @returns a store/guard outcome, see {@link MultiChatStore.close}.
       */
      function closePane(id) {
        const state = store.getSnapshot()
        if (!state.panes.includes(id)) return 'missing'
        if (state.panes.length <= 1) return 'last'
        if (id === state.activeId) {
          // Refuse before touching the highlight: an activated-but-refused close
          // would leave the header and the grid disagreeing about "current".
          if (!canNavigate()) return 'active-locked'
          const next = [...state.panes].reverse().find((pane) => pane !== id)
          if (next === undefined) return 'last'
          if (!focusPane(next)) return 'active-locked'
          store.suppress(id)
        }
        return store.close(id)
      }

      /** Toggle one pane from the sidebar row button. */
      function togglePane(id) {
        const state = store.getSnapshot()
        if (state.panes.includes(id)) return closePane(id)
        const outcome = store.open(id)
        if (outcome === 'opened') syncReferences()
        return outcome
      }

      /**
       * @param id - session identity.
       * @returns whether the pane's close control may act right now.
       */
      function canClosePane(id) {
        const state = store.getSnapshot()
        if (!state.panes.includes(id) || state.panes.length <= 1) return false
        if (id !== state.activeId) return true
        return canNavigate()
      }

      /** Keep only the current session's pane. */
      function keepOnlyActive() {
        const activeId = store.getSnapshot().activeId
        if (activeId === undefined) return 'missing'
        return store.keepOnly(activeId)
      }

      // ---- slot contributions ----------------------------------------------

      /** Inject face shared by both registrations (stable identity for caching). */
      const injectFace = {
        hooks: { multiChat: store },
        t,
        getReference,
        focusPane,
        closePane,
        canClosePane,
        togglePane,
        swapPanes: (leftId, rightId) => store.swap(leftId, rightId),
        movePaneToEnd: (id) => store.moveToEnd(id),
        keepOnlyActive,
      }

      /** Register the two contributions for as long as they are wanted. */
      function mountSlots() {
        const mounted = []
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          throw new Error('slots service is unavailable')
        }
        // Conversation-area replacement: the keyed `conversation` cell of `main`
        // (root scope, so switching sessions never remounts the grid). The
        // declared `multichat.pane` child (session scope) is what makes the
        // renderer hand us the SessionProvider seat; the pane bodies render below
        // it.
        mounted.push(
          slots.inject(SLOT_MAIN, () =>
            slots.register(
              {
                name: SLOT_MAIN,
                key: MAIN_PANEL_KEY,
                priority: MAIN_CONVERSATION_PRIORITY,
                children: { [SLOT_PANE]: { kind: 'single', scope: 'session' } },
                inject: () => injectFace,
              },
              MultiChatRoot,
            ),
          ),
        )
        // Sidebar session-row action (incremental list cell, fresh id).
        mounted.push(
          slots.inject(SLOT_ROW_ACTION, () =>
            slots.register(
              {
                name: SLOT_ROW_ACTION,
                id: ROW_ACTION_ID,
                order: ROW_ACTION_ORDER,
                inject: () => injectFace,
              },
              SessionRowAction,
            ),
          ),
        )
        return () => {
          for (const dispose of mounted.reverse()) {
            try {
              dispose()
            } catch (error) {
              console.warn('[dsh-multi-chat] slot disposal failed:', error)
            }
          }
        }
      }

      /** Mount while 2+ panes are open, unmount back to the official view. */
      function syncRegistration() {
        if (disposed) return
        const wanted = sessions !== undefined && store.getSnapshot().panes.length > 1
        if (wanted === (slotDisposer !== undefined)) return
        if (!wanted) {
          const dispose = slotDisposer
          slotDisposer = undefined
          try {
            dispose()
          } catch (error) {
            console.warn('[dsh-multi-chat] slot disposal failed:', error)
          }
          return
        }
        try {
          slotDisposer = mountSlots()
        } catch (error) {
          slotDisposer = undefined
          console.error('[dsh-multi-chat] slot registration failed:', error)
        }
      }

      // ---- lifecycle --------------------------------------------------------

      const offStore = store.subscribe(() => {
        try {
          syncNow()
        } catch (error) {
          console.error('[dsh-multi-chat] store sync failed:', error)
        }
      })

      let offList
      try {
        offList = sessions?.list?.subscribe?.(onListChange)
      } catch (error) {
        console.warn('[dsh-multi-chat] session list subscription failed:', error)
      }

      // Initial pass: the list may already be ready, and a restored pane set
      // needs its references and (for 2+ panes) its slot registration.
      onListChange()
      syncReferences()
      syncRegistration()

      if (slots !== undefined) {
        disposers.push(() => {
          if (slotDisposer !== undefined) {
            const dispose = slotDisposer
            slotDisposer = undefined
            dispose()
          }
        })
      }

      return {
        store,
        syncRegistration,
        syncReferences,
        syncNow,
        closePane,
        focusPane,
        togglePane,
        keepOnlyActive,
        getReference,
        canClosePane,
        swapPanes: (leftId, rightId) => store.swap(leftId, rightId),
        movePaneToEnd: (id) => store.moveToEnd(id),
        injectFace,
        /** Tear everything down; safe to call twice. */
        dispose() {
          if (disposed) return
          disposed = true
          try {
            offList?.()
          } catch {
            /* ignore */
          }
          try {
            offStore()
          } catch {
            /* ignore */
          }
          for (const dispose of disposers.splice(0).reverse()) {
            try {
              dispose()
            } catch {
              /* ignore */
            }
          }
          for (const [, reference] of references) releaseReference(reference)
          references.clear()
          pendingRetains.clear()
        },
        /** Test/introspection surface. */
        debug: {
          references,
          isListReady: () => listReady,
          isRegistered: () => slotDisposer !== undefined,
        },
      }
    }

    // #endregion

    // #region plugin

    /**
     * Browser-half activation. Never throws: a throwing client plugin fails the
     * whole web boot, and this feature is purely visual.
     *
     * @param ctx - client cordis context.
     * @param config - loader config (the boot path passes none; accepted for
     * forward compatibility and only used to seed the pane ceiling).
     */
    function apply(ctx, config) {
      try {
        const slots = readService(ctx, 'slots')
        if (slots === undefined || typeof slots.inject !== 'function') {
          console.warn('[dsh-multi-chat] slots service unavailable — browser half stays inactive')
          return
        }
        const sessions = readService(ctx, 'sessions')
        if (sessions === undefined) {
          console.warn('[dsh-multi-chat] sessions service unavailable — staying on the single-session view')
        }
        const removeStyles = injectStyles()
        const controller = createController({
          ctx,
          slots,
          sessions,
          localeFace: readService(ctx, 'locale'),
          storage: safeStorage(),
          maxPanes: config?.maxPanes,
        })
        if (typeof ctx?.effect === 'function') {
          ctx.effect(
            () => () => {
              controller.dispose()
              removeStyles()
            },
            'dsh-multi-chat: browser half',
          )
        } else {
          console.warn('[dsh-multi-chat] ctx.effect unavailable — contributions cannot be disposed')
        }
      } catch (error) {
        console.error('[dsh-multi-chat] browser half failed to activate:', error)
      }
    }

    exports.name = PLUGIN_NAME
    /**
     * Required client services. Static array (cordis rejects a function form).
     * `slots` and `sessions` are both required for the feature; `uiWorkspace`
     * and `locale` are optional and read with `ctx.get` at use time.
     */
    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    /** Test/introspection surface (mirrors the official bundles exporting their internals). */
    exports.__internals = {
      MultiChatStore,
      parsePersisted,
      normalizeMaxPanes,
      dedupeIds,
      mainSessionIdOf,
      paneIdAtPoint,
      keyboardSwapTarget,
      gridColumnCount,
      resolveLanguage,
      createTranslator,
      createController,
      injectStyles,
      MESSAGES,
      CSS,
      STYLE_TAG_ID,
      components: {
        MultiChatRoot,
        MultiChatBar,
        MultiChatPane,
        MultiChatPaneHeader,
        DragGhost,
        SessionRowAction,
        PaneBoundary,
      },
      constants: {
        PLUGIN_NAME,
        STORAGE_KEY,
        STORAGE_VERSION,
        RETENTION_SOURCE,
        SLOT_MAIN,
        MAIN_PANEL_KEY,
        SLOT_PANE,
        SLOT_ROW_ACTION,
        FACTORY_CONVERSATION_CONTENT,
        CONVERSATION_VARIANT,
        ROW_ACTION_ID,
        MAIN_CONVERSATION_PRIORITY,
        ROW_ACTION_ORDER,
        DEFAULT_MAX_PANES,
        MIN_MAX_PANES,
        MAX_MAX_PANES,
        GRID_MAX_COLUMNS,
        GRID_MIN_ROW_PX,
        DRAG_THRESHOLD_PX,
        TOUCH_LONG_PRESS_MS,
      },
    }

    return module.exports
  },
})
