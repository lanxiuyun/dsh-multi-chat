/**
 * dsh-multi-chat — host (Node) half.
 *
 * This package is a *browser-half* plugin: the whole feature (sidebar toggle,
 * the side-by-side session grid, drag reordering, highlighting) lives in
 * `lib/client.js`, which the web shell loads through the `dsh.client` manifest
 * declaration in `package.json` and serves at
 * `/plugins/dsh-multi-chat/client.js`.
 *
 * The host half exists so the package becomes a loader entry in the profile
 * roster (that roster is what `@deepseek-ai/dsh-client-modules` scans for
 * `dsh.client` declarations). It intentionally registers no host behavior:
 * there is no host-side state, tool, route or service to own.
 *
 * Why no `Config` here: the browser boot path creates client entries with
 * `loader.create({ name: id })` only (see `@deepseek-ai/dsh-client-modules`,
 * browser half), so a cordis `config` on this row can never reach the UI.
 * Every user-tunable knob therefore lives in the browser half — the grid
 * toolbar plus `localStorage` — instead of being a config field that silently
 * does nothing. See `docs/design.md` §2.2 (N5).
 *
 * Contract: `name` + `apply(ctx)`; `inject` is an explicit empty array because
 * the host half touches no service. Loading this module must never throw —
 * a throwing plugin apply fails the whole host boot.
 *
 * @module dsh-multi-chat
 */

/** Plugin name; must match the package name used by the profile row. */
export const name = 'dsh-multi-chat'

/** Required host services: none. */
export const inject = []

/**
 * Host half activation: inert by design, but defensive — a broken host half
 * would fail the profile boot for a purely visual feature.
 *
 * @param ctx - host cordis context (unused beyond the optional debug log).
 */
export function apply(ctx) {
  try {
    // `ctx.logger` is optional here: keep the log best-effort so a context
    // shape change can never break activation.
    ctx?.logger?.('dsh-multi-chat')?.debug?.(
      'host half active — the browser half owns the multi-session grid',
    )
  } catch {
    // Never throw from a host apply.
  }
}
