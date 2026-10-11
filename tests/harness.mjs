/**
 * Test harness: load the real browser half of dsh-multi-chat the way
 * `@deepseek-ai/dsh-client-modules` does (a lazy CommonJS factory registered
 * through `window.__ModuleLoader__.load`), against real React and fake Cordis
 * client services. Nothing here re-implements plugin logic.
 *
 * @module tests/harness
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const BUNDLE_URL = new URL('../lib/client.js', import.meta.url)

/** Platform seed modules the web shell exposes to client bundles. */
const SEED_MODULES = {
  react: () => require_('react'),
  'react/jsx-runtime': () => require_('react/jsx-runtime'),
  'react-dom': () => require_('react-dom'),
}

/**
 * Evaluate `lib/client.js` the way the browser module table does — as a script
 * in the current realm whose only ambient input is `window` — and materialize
 * its factory with the platform seed modules.
 *
 * `globalThis` is passed as a parameter shadowing the real global so per-test
 * overrides (document, localStorage, navigator) stay local.
 *
 * @param options - `globals` overrides layered onto the shadowed global scope.
 * @returns the registered id, the module exports and the requested specifiers.
 */
export function loadClientBundle(options = {}) {
  const source = readFileSync(BUNDLE_URL, 'utf8')
  let registration
  const windowScope = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }
  const globalScope = Object.assign(Object.create(globalThis), options.globals ?? {})
  const evaluate = new Function('window', 'globalThis', source)
  evaluate(windowScope, globalScope)
  if (registration === undefined) throw new Error('bundle did not call window.__ModuleLoader__.load')
  const requested = []
  const exports_ = registration.factory((specifier) => {
    requested.push(specifier)
    const seed = SEED_MODULES[specifier]
    if (seed === undefined) throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
    return seed()
  })
  return { id: registration.id, exports: exports_, requested, globalScope }
}

/** An in-memory localStorage stand-in. */
export function createMemoryStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => {
      map.delete(key)
    },
    /** @returns every stored entry, for assertions. */
    entries: () => Object.fromEntries(map),
  }
}

/**
 * A minimal `window` for tests that must control the viewport width and fire
 * resize events (the plugin gates the grid by window width, because the DSH
 * floating session window is only ~490px wide).
 *
 * @param width - initial viewport width in CSS pixels.
 * @returns a fake event target with `setWidth` to simulate a resize.
 */
export function createFakeWindow(width) {
  const listeners = new Set()
  return {
    innerWidth: width,
    addEventListener(type, listener) {
      if (type === 'resize' && typeof listener === 'function') listeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'resize') listeners.delete(listener)
    },
    /** Change the width and notify the listeners the way a real resize does. */
    setWidth(next) {
      this.innerWidth = next
      for (const listener of [...listeners]) listener({ type: 'resize' })
    },
    /** @returns how many resize listeners are still attached. */
    get resizeListeners() {
      return listeners.size
    },
  }
}

/**
 * A faithful-enough stand-in for `ctx.slots`: declaration lifetimes drive
 * `inject` callbacks, registrations are recorded and disposable.
 */
export function createFakeSlots() {
  const declared = new Set()
  const injections = new Map()
  const registrations = []

  const activate = (entry) => {
    if (entry.active) return
    entry.active = true
    try {
      entry.dispose = entry.callback()
    } catch (error) {
      entry.active = false
      throw error
    }
  }
  const deactivate = (entry) => {
    if (!entry.active) return
    entry.active = false
    try {
      entry.dispose?.()
    } finally {
      entry.dispose = undefined
    }
  }

  return {
    /** Every registration, in order, with `options`/`component`/`disposed`. */
    registrations,
    /**
     * Mark one slot key as declared (models the owning package registering it).
     * @param key - slot key.
     */
    declare(key) {
      declared.add(key)
      for (const entry of injections.get(key) ?? []) activate(entry)
    },
    /**
     * Collapse one slot key's declaration (owner unmount).
     * @param key - slot key.
     */
    collapse(key) {
      declared.delete(key)
      for (const entry of injections.get(key) ?? []) deactivate(entry)
    },
    /** The `inject(key, callback)` contract used by the plugin. */
    inject(key, callback) {
      const entry = { key, callback, active: false, dispose: undefined }
      if (!injections.has(key)) injections.set(key, [])
      injections.get(key).push(entry)
      if (declared.has(key)) activate(entry)
      return () => {
        deactivate(entry)
        const list = injections.get(key) ?? []
        const index = list.indexOf(entry)
        if (index >= 0) list.splice(index, 1)
      }
    },
    /** The `register(options, component)` contract used by the plugin. */
    register(options, component) {
      const record = { options, component, disposed: false }
      registrations.push(record)
      return () => {
        record.disposed = true
      }
    },
    /** @returns live registrations for one slot key. */
    live(key) {
      return registrations.filter((record) => !record.disposed && record.options.name === key)
    },
  }
}

/**
 * A stand-in for `ctx.sessions` (client session controller) with the parts the
 * plugin uses: a list snapshot source, `binding`, `retain` (which throws for
 * unknown sessions AND publishes the retention snapshot synchronously, exactly
 * like the real controller) and `release`.
 *
 * The synchronous publish matters: it re-enters the plugin's list subscription
 * from inside its own `retain` call, which is the recursion the controller must
 * survive (a real browser hit a stack overflow when it did not).
 *
 * @param rows - initial `byId` rows.
 */
export function createFakeSessions(rows = {}) {
  const listeners = new Set()
  const bindings = new Map()
  const retainCalls = []
  const releaseCalls = []
  let snapshot = { ids: Object.keys(rows), byId: { ...rows }, phase: 'ready' }

  const publish = (next) => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const withRetention = (id, source, delta) => {
    const row = snapshot.byId[id]
    if (row === undefined) return
    const retainedBy = { ...(row.retainedBy ?? {}) }
    const next = (retainedBy[source] ?? 0) + delta
    if (next > 0) retainedBy[source] = next
    else delete retainedBy[source]
    publish({
      ids: snapshot.ids,
      byId: { ...snapshot.byId, [id]: { ...row, retainedBy } },
      phase: snapshot.phase,
    })
  }

  return {
    retainCalls,
    releaseCalls,
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    binding(id) {
      return bindings.get(id)
    },
    retain(id, options) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.byId, id)) {
        throw new Error(`sessions.retain: unknown session ${id}`)
      }
      const source = options?.source ?? 'anonymous'
      if (!bindings.has(id)) bindings.set(id, { sessionId: id })
      retainCalls.push({ id, source })
      withRetention(id, source, 1)
      let released = false
      return {
        sessionId: id,
        get binding() {
          if (released) throw new Error(`Session reference "${id}" is released`)
          return bindings.get(id)
        },
        release() {
          if (released) return
          released = true
          releaseCalls.push(id)
          withRetention(id, source, -1)
        },
      }
    },
    /** Publish a new list snapshot. */
    publish(next) {
      publish(next)
    },
    /** Replace rows and publish. */
    setRows(next) {
      publish({ ids: Object.keys(next), byId: { ...next }, phase: 'ready' })
    },
    /** Mark one session as the shell's current session and publish. */
    setMain(id) {
      const byId = {}
      for (const [key, row] of Object.entries(snapshot.byId)) {
        const retainedBy = { ...(row.retainedBy ?? {}) }
        if (key === id) retainedBy.mainView = 1
        else delete retainedBy.mainView
        byId[key] = { ...row, retainedBy }
      }
      publish({ ids: Object.keys(byId), byId, phase: 'ready' })
    },
  }
}

/**
 * Build a row object for {@link createFakeSessions}.
 * @param id - session id.
 * @param extra - extra row fields.
 */
export function sessionRow(id, extra = {}) {
  return { id, displayTitle: `Session ${id}`, blank: false, retainedBy: {}, ...extra }
}

/**
 * A minimal client cordis context.
 * @param services - service name → value.
 * @param options - `onEffect` hook.
 */
export function createFakeCtx(services = {}, options = {}) {
  const effects = []
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(callback, label) {
      const disposer = callback()
      if (typeof disposer === 'function') effects.push(disposer)
      options.onEffect?.(label, disposer)
      return disposer
    },
    ...services,
  }
  return {
    ctx,
    effects,
    /** Run every registered effect disposer (plugin unload). */
    dispose() {
      for (const disposer of effects.splice(0).reverse()) disposer?.()
    },
  }
}
