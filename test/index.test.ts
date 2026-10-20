import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createPackageWithOptions } from '@electron/asar'
import { afterPack, findUnresolvedDependencies, verifyAsarDependencies } from '../src/index.ts'

const roots: string[] = []
after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Archives package manifests into a real `app.asar` and returns the resources directory. */
async function archive(manifests: Record<string, object>, unpack?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verify-asar-deps-'))
  roots.push(root)
  const source = join(root, 'app')
  await mkdir(source)
  await writeFile(join(source, 'package.json'), '{"name":"app"}')
  for (const [path, manifest] of Object.entries(manifests)) {
    const file = join(source, ...path.split('/'), 'package.json')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(manifest))
  }
  const resources = join(root, 'resources')
  await mkdir(resources)
  await createPackageWithOptions(source, join(resources, 'app.asar'), unpack === undefined ? {} : { unpack })
  return resources
}

const lib = { name: '@scope/lib', dependencies: { '@scope/util': '1', 'left-pad': '1' } }
const paths = (entries: Array<{ packagePath: string; dependency: string }>) => entries.map((e) => `${e.packagePath} -> ${e.dependency}`)

it('names the transitive dependencies a deduplicated workspace link left out of app.asar', async () => {
  const resources = await archive({ 'node_modules/@scope/lib': lib })
  assert.deepEqual(paths(await findUnresolvedDependencies(resources)), [
    'node_modules/@scope/lib -> @scope/util',
    'node_modules/@scope/lib -> left-pad',
  ])
  await assert.rejects(verifyAsarDependencies(resources), /node_modules\/@scope\/lib -> @scope\/util/)
})

it('resolves dependencies through every ancestor node_modules directory', async () => {
  const resources = await archive({
    'node_modules/@scope/lib': lib,
    'node_modules/@scope/util': { name: '@scope/util' },
    'node_modules/left-pad': { name: 'left-pad' },
    'packages/host/node_modules/host': { name: 'host', dependencies: { nested: '1', hoisted: '1' } },
    'packages/host/node_modules/host/node_modules/nested': { name: 'nested' },
    'packages/host/node_modules/hoisted': { name: 'hoisted' },
  })
  await verifyAsarDependencies(resources)
})

it('does not resolve a dependency from a sibling package directory', async () => {
  const resources = await archive({
    'node_modules/host': { name: 'host', dependencies: { nested: '1' } },
    'node_modules/other/node_modules/nested': { name: 'nested' },
  })
  assert.deepEqual(paths(await findUnresolvedDependencies(resources)), ['node_modules/host -> nested'])
})

it('requires non-optional peers except those the caller ignores for that package', async () => {
  const resources = await archive({
    'node_modules/gateway': {
      name: 'gateway',
      peerDependencies: { required: '1', optional: '1', ignored: '1' },
      peerDependenciesMeta: { optional: { optional: true } },
    },
    'node_modules/other': { name: 'other', peerDependencies: { ignored: '1' } },
  })
  const unresolved = await findUnresolvedDependencies(resources, { ignorePeers: { gateway: ['ignored'] } })
  assert.deepEqual(unresolved.map((e) => [e.packagePath, e.dependency, e.kind]), [
    ['node_modules/gateway', 'required', 'peer'],
    ['node_modules/other', 'ignored', 'peer'],
  ])
})

it('skips optionalDependencies and explicitly ignored dependencies', async () => {
  const resources = await archive({
    'node_modules/native': {
      name: 'native',
      dependencies: { 'fsevents': '1', 'needed': '1', 'dropped-on-purpose': '1' },
      optionalDependencies: { 'fsevents': '1' },
    },
  })
  const unresolved = await findUnresolvedDependencies(resources, { ignoreDependencies: { native: ['dropped-on-purpose'] } })
  assert.deepEqual(paths(unresolved), ['node_modules/native -> needed'])
})

it('reads manifests from app.asar.unpacked and accepts a direct .asar path', async () => {
  const resources = await archive({
    'node_modules/native': { name: 'native', dependencies: { bindings: '1' } },
    'node_modules/bindings': { name: 'bindings' },
  }, '**/node_modules/native/**')
  await verifyAsarDependencies(join(resources, 'app.asar'))
  const broken = await archive({ 'node_modules/native': { name: 'native', dependencies: { bindings: '1' } } }, '**/node_modules/native/**')
  assert.deepEqual(paths(await findUnresolvedDependencies(broken)), ['node_modules/native -> bindings'])
})

it('runs as an electron-builder afterPack hook', async () => {
  const resources = await archive({ 'node_modules/@scope/lib': lib })
  const context = { appOutDir: 'out', electronPlatformName: 'win32', packager: { getResourcesDir: () => resources } }
  await assert.rejects(afterPack()(context), /2 archived package dependencies do not resolve/)
  await afterPack({ ignoreDependencies: { '@scope/lib': ['@scope/util', 'left-pad'] } })(context)
})

it('exits 1 from the CLI and prints each unresolved dependency', async () => {
  const resources = await archive({ 'node_modules/@scope/lib': lib })
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  const run = promisify(execFile)
  await assert.rejects(run(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, resources]), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /node_modules\/@scope\/lib -> left-pad/)
    return true
  })
  const ok = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, resources, '--ignore', '@scope/lib=@scope/util', '--ignore', '@scope/lib=left-pad', '--json'])
  assert.deepEqual(JSON.parse(ok.stdout).unresolved, [])
})
