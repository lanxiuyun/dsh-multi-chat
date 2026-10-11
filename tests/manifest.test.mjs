/**
 * Package/manifest contract tests (acceptance A9): the plugin must be a valid
 * DSH bundle with a web client half, valid patch row, bilingual metadata and a
 * self-describing client bundle.
 *
 * @module tests/manifest
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

const root = new URL('../', import.meta.url)
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const readText = (path) => readFileSync(new URL(path, root), 'utf8')

const pkg = readJson('package.json')

test('package identity and module shape', () => {
  assert.equal(pkg.name, 'dsh-multi-chat')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.ok(pkg.engines?.node, 'engines.node must be declared')
})

test('exports the host half, the client bundle, the icon and locales', () => {
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.ok(pkg.exports['./package.json'], 'package.json export is required by the plugin inventory')
  for (const target of ['./lib/index.js', './lib/client.js', './icon.svg']) {
    assert.doesNotThrow(() => readText(target.slice(2)), `missing ${target}`)
  }
})

test('declares a bundle patch and a web client half', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  // A function-form inject was a real published-plugin bug class: cordis needs a
  // static array, and a wrong shape silently disables the whole bundle.
  assert.ok(Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject must be a static array')
  assert.ok(pkg.dsh.client.inject.every((entry) => typeof entry === 'string'))
  // The browser half requires nothing but platform seed modules, so it declares
  // no module-graph edges.
  assert.deepEqual(pkg.dsh.client.inject, [])
})

test('ships the files the manifest promises', () => {
  const files = pkg.files ?? []
  for (const expected of ['lib/**/*.js', 'locale/*.json', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(files.includes(expected), `files must include ${expected}`)
  }
})

test('cordis.patch.yml inserts exactly one row for this package', () => {
  const parsed = parseYaml(readText('cordis.patch.yml'))
  assert.ok(Array.isArray(parsed), 'patch must be a list')
  const rows = parsed.flatMap((layer) => layer?.insert ?? [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, pkg.name)
  assert.equal(rows[0].name, pkg.name)
})

test('locale metadata is bilingual and complete', () => {
  for (const locale of ['en', 'zh']) {
    const meta = readJson(`locale/${locale}.json`).meta
    assert.equal(typeof meta?.title, 'string', `${locale} meta.title`)
    assert.ok(meta.title.length > 0)
    assert.equal(typeof meta?.description, 'string', `${locale} meta.description`)
    assert.ok(meta.description.length > 20, `${locale} meta.description should be meaningful`)
  }
})

test('the client bundle uses the official module-loader wrapper', () => {
  const source = readText('lib/client.js')
  const body = source.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/u, '')
  const firstLine = body.split('\n').find((line) => line.trim().length > 0)
  assert.equal(firstLine.trim(), 'window.__ModuleLoader__.load({')
  assert.match(source, /id: 'dsh-multi-chat'/)
  assert.match(source, /factory: \(require\) => \{/)
  assert.match(source, /return module\.exports/)
  assert.ok(source.trimEnd().endsWith('})'), 'bundle must close the loader call')
  // UI red line: only platform seed modules may be required.
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual(requires, ['react'])
})

test('the composer fix stays in place: the body is embedded and no width hack returns', () => {
  const source = readText('lib/client.js')
  assert.match(source, /const CONVERSATION_VARIANT = 'embedded'/)
  assert.match(source, /variant: CONVERSATION_VARIANT/)
  // The pane body must not re-introduce the container-query width override: the
  // embedded conversation body computes its own content width.
  const paneBody = source.match(/\.dsh-mc-pane-body\{[^}]*\}/)?.[0] ?? ''
  assert.ok(paneBody.length > 0, 'the pane body rule exists')
  assert.doesNotMatch(paneBody, /container-type/)
  assert.doesNotMatch(source, /cqw/)
  assert.doesNotMatch(source, /--dsh-chat-user-width/)
  // `container-type` is allowed (and needed) on the grid root, where our own
  // container queries pick 3 → 2 → 1 columns.
  assert.match(source, /\.dsh-mc-root\{[^}]*container-type:inline-size/)
})

test('README and design docs are bilingual, as required for a plugin package', () => {
  for (const file of ['README.md', 'README.zh.md', 'LICENSE']) {
    assert.ok(readText(file).length > 0, `${file} must exist`)
  }
  assert.ok(readText('docs/design.md').length > 0)
  assert.ok(readText('docs/design.en.md').length > 0)
})
