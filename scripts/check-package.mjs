#!/usr/bin/env node
/** Zero-dependency, no-network release metadata and runtime payload validation. */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert(['dsh-resend', 'dsh-desktop-context'].includes(pkg.name), 'unexpected package name')
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), 'invalid version')
assert.notEqual(pkg.private, true, 'private package cannot be published')
assert.equal(pkg.license, 'MIT')
assert.equal(pkg.engines.node, '>=24.0.0')
assert.equal(pkg.publishConfig.access, 'public')
assert(pkg.keywords.includes('dsh-plugin'))
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'runtime dependencies must be deliberately reviewed')
assert(Array.isArray(pkg.files) && !pkg.files.includes('*') && !pkg.files.includes('lib'), 'use a narrow publish allowlist')
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  assert.equal(pkg.peerDependenciesMeta[name]?.optional, true, 'host peers must not install a second runtime')
  if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, '0.2.0-rc.2', 'only the verified DSH release may be declared compatible')
}
for (const file of ['LICENSE', 'NOTICE', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'cordis.patch.yml', pkg.icon]) {
  assert(fs.statSync(path.join(root, file)).isFile(), `missing release resource: ${file}`)
}
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
assert(patch.includes(`id: ${pkg.name}`) && patch.includes(`name: ${pkg.name}`) && patch.includes('insert:'), 'bundle patch must actually mount this plugin')
assert.equal(pkg.exports['.'], './lib/index.js')
assert.equal(pkg.exports['./package.json'], './package.json')
assert.equal(pkg.exports['./locale/*'], './locale/*')
for (const language of ['en', 'zh-CN']) {
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${language}.json`), 'utf8')).meta
  assert(meta.title?.trim() && meta.description?.trim(), `missing ${language} display metadata`)
}
const icon = fs.readFileSync(path.join(root, pkg.icon), 'utf8')
assert(Buffer.byteLength(icon) < 256 * 1024)
assert(icon.includes('<svg') && !/<script|\bon\w+=|(?:href|src)=/i.test(icon), 'icon must be inert local SVG')
const runtimeFiles = fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js'))
assert(runtimeFiles.includes('index.js'))
for (const file of runtimeFiles) {
  const filename = path.join(root, 'lib', file)
  const text = fs.readFileSync(filename, 'utf8')
  assert(!/\b(?:import|export)\b[^\n]*['"](?:[A-Za-z]:|file:\/\/\/[A-Za-z]:|\/Users\/|\/home\/)/.test(text), `absolute runtime import: ${file}`)
  assert(!/https?:\/\/(?:[^\s'"`]+@)/.test(text), `credential-bearing URL in ${file}`)
  if (file === 'client.js') {
    new vm.Script(text, { filename: file })
    assert(!/^\s*(?:import|export)\s/m.test(text), 'desktop client must be a classic script')
    let face
    const sandbox = { window: { __ModuleLoader__: { load({ id, factory }) { assert.equal(id, pkg.name); face = factory(() => ({})) } } } }
    vm.runInNewContext(text, sandbox)
    assert.equal(typeof face?.apply, 'function')
    assert.deepEqual(Array.from(face.inject), [])
  } else {
    const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' })
    assert.equal(result.status, 0, `syntax error: ${file}`)
  }
}
if (pkg.name === 'dsh-resend') {
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.inject, undefined)
} else {
  assert.equal(pkg.exports['./client'], undefined)
  assert.equal(pkg.dsh.client, undefined)
  assert(fs.readFileSync(path.join(root, 'prompts', 'desktop-surface.md'), 'utf8').includes('native Electron'))
}
for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts?.[name], undefined, 'installation must not run scripts')
console.log(`PASS ${pkg.name}@${pkg.version}: metadata, bundle, locale, icon, syntax, host peers, and delivery format`)
