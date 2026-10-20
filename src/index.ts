/**
 * Reject an assembled Electron application whose archived packages cannot
 * resolve their runtime dependencies.
 *
 * electron-builder collects `app.asar/node_modules` from the package manager's
 * dependency listing. With pnpm workspaces that listing can report a workspace
 * package already expanded under another project only as a deduplicated
 * reference without children, so the transitive dependencies of such a package
 * are omitted while the package itself is copied. The packaged app then fails
 * at launch with `ERR_MODULE_NOT_FOUND`. This check reads the final archive and
 * applies Node's `node_modules` lookup to every archived package manifest.
 */

import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One entry of the asar header tree. */
export type AsarNode = {
  files?: Record<string, AsarNode>
  size?: number
  offset?: string
  unpacked?: boolean
  link?: string
}

/** A parsed asar archive: its header tree plus a reader for file contents. */
export type AsarArchive = {
  readonly path: string
  readonly header: AsarNode
  /** Reads a file by its archive-relative path segments, following links. */
  readFile(segments: readonly string[]): Promise<Buffer>
}

/**
 * Reads the header of an asar archive.
 *
 * The format is a Chromium pickle holding the header size, followed by a
 * pickle holding the JSON header string; file data follows the header.
 *
 * @param archivePath - path to `app.asar`.
 */
export async function readAsarArchive(archivePath: string): Promise<AsarArchive> {
  const handle = await open(archivePath, 'r')
  let headerSize: number
  let header: AsarNode
  try {
    const sizePickle = Buffer.alloc(8)
    if ((await handle.read(sizePickle, 0, 8, 0)).bytesRead !== 8) throw new Error(`${archivePath}: not an asar archive`)
    headerSize = sizePickle.readUInt32LE(4)
    const headerPickle = Buffer.alloc(headerSize)
    if ((await handle.read(headerPickle, 0, headerSize, 8)).bytesRead !== headerSize) {
      throw new Error(`${archivePath}: truncated asar header`)
    }
    const length = headerPickle.readUInt32LE(4)
    header = JSON.parse(headerPickle.toString('utf8', 8, 8 + length)) as AsarNode
  } finally {
    await handle.close()
  }

  const nodeAt = (segments: readonly string[], hops = 0): AsarNode | undefined => {
    let node: AsarNode | undefined = header
    for (const segment of segments) {
      node = node?.files?.[segment]
      if (node === undefined) return undefined
    }
    if (node?.link !== undefined) {
      if (hops > 40) throw new Error(`${archivePath}: link loop at ${segments.join('/')}`)
      return nodeAt(node.link.split(/[\\/]/), hops + 1)
    }
    return node
  }

  return {
    path: archivePath,
    header,
    async readFile(segments) {
      const node = nodeAt(segments)
      if (node === undefined || node.files !== undefined) throw new Error(`${archivePath}: no file ${segments.join('/')}`)
      if (node.unpacked) return readFile(join(`${archivePath}.unpacked`, ...segments))
      const size = node.size ?? 0
      const buffer = Buffer.alloc(size)
      if (size === 0) return buffer
      const handle = await open(archivePath, 'r')
      try {
        await handle.read(buffer, 0, size, 8 + headerSize + Number(node.offset))
      } finally {
        await handle.close()
      }
      return buffer
    },
  }
}

function hasNode(header: AsarNode, segments: readonly string[]): boolean {
  let node: AsarNode | undefined = header
  for (const segment of segments) {
    node = node?.files?.[segment]
    if (node === undefined) return false
  }
  return true
}

/** Archive-relative package directories of every manifest directly under a `node_modules` directory. */
function archivedPackages(node: AsarNode, path: string[], packages: string[][]): string[][] {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    if (child.files !== undefined) {
      archivedPackages(child, [...path, name], packages)
      continue
    }
    // `path` is the package directory; its parent is `node_modules`, or a scope under `node_modules`.
    const parent = path.at(-2)
    const scoped = parent?.startsWith('@') === true && path.at(-3) === 'node_modules'
    if (name === 'package.json' && (parent === 'node_modules' || scoped)) packages.push(path)
  }
  return packages
}

/** Whether Node's `node_modules` lookup from a package directory finds a dependency inside the archive. */
function resolves(header: AsarNode, packagePath: readonly string[], dependency: string): boolean {
  for (let end = packagePath.length; end >= 0; end--) {
    if (end > 0 && packagePath[end - 1] === 'node_modules') continue
    const candidate = [...packagePath.slice(0, end), 'node_modules', ...dependency.split('/'), 'package.json']
    if (hasNode(header, candidate)) return true
  }
  return false
}

type Manifest = {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** One unresolved dependency of an archived package. */
export type UnresolvedDependency = {
  /** Archive-relative package directory, joined with `/`. */
  readonly packagePath: string
  /** The manifest `name` of that package. */
  readonly packageName: string | undefined
  /** The dependency that Node's lookup cannot find. */
  readonly dependency: string
  readonly kind: 'dependency' | 'peer'
}

export type VerifyOptions = {
  /**
   * Package name to required peers that are known to be unused at runtime,
   * for example because the packaged entry point never imports the module
   * that needs them. Optional peers (`peerDependenciesMeta.*.optional`) are
   * always skipped.
   */
  ignorePeers?: Readonly<Record<string, readonly string[]>>
  /** Package name to dependencies to skip entirely. */
  ignoreDependencies?: Readonly<Record<string, readonly string[]>>
}

/**
 * Finds every archived package dependency the packaged application cannot resolve.
 *
 * `dependencies` and non-optional `peerDependencies` are checked;
 * `optionalDependencies` are not, since packages must already tolerate their absence.
 *
 * @param archivePath - path to `app.asar`, or to a resources directory containing it.
 * @returns unresolved dependencies, in archive order.
 */
export async function findUnresolvedDependencies(archivePath: string, options: VerifyOptions = {}): Promise<UnresolvedDependency[]> {
  const asar = archivePath.endsWith('.asar') ? archivePath : join(archivePath, 'app.asar')
  const archive = await readAsarArchive(asar)
  const unresolved: UnresolvedDependency[] = []
  for (const packagePath of archivedPackages(archive.header, [], [])) {
    const manifest = JSON.parse((await archive.readFile([...packagePath, 'package.json'])).toString('utf8')) as Manifest
    const name = manifest.name
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}))
    const skipped = new Set(name === undefined ? [] : options.ignoreDependencies?.[name] ?? [])
    const skippedPeers = new Set(name === undefined ? [] : options.ignorePeers?.[name] ?? [])
    const optionalPeers = new Set(Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta?.optional === true).map(([peer]) => peer))
    const checks = new Map<string, 'dependency' | 'peer'>()
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!optional.has(dependency)) checks.set(dependency, 'dependency')
    }
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!optionalPeers.has(peer) && !skippedPeers.has(peer) && !checks.has(peer)) checks.set(peer, 'peer')
    }
    for (const [dependency, kind] of checks) {
      if (skipped.has(dependency)) continue
      if (!resolves(archive.header, packagePath, dependency)) {
        unresolved.push({ packagePath: packagePath.join('/'), packageName: name, dependency, kind })
      }
    }
  }
  return unresolved
}

/** Thrown by {@link verifyAsarDependencies} when something cannot be resolved. */
export class UnresolvedDependenciesError extends Error {
  readonly unresolved: readonly UnresolvedDependency[]
  constructor(archivePath: string, unresolved: readonly UnresolvedDependency[]) {
    super(`${archivePath}: ${unresolved.length} archived package dependenc${unresolved.length === 1 ? 'y does' : 'ies do'} not resolve:\n`
      + unresolved.map(formatUnresolved).join('\n'))
    this.name = 'UnresolvedDependenciesError'
    this.unresolved = unresolved
  }
}

/** Formats one unresolved dependency as `node_modules/pkg -> dep` (with `(peer)` for peers). */
export function formatUnresolved(entry: UnresolvedDependency): string {
  return `${entry.packagePath} -> ${entry.dependency}${entry.kind === 'peer' ? ' (peer)' : ''}`
}

/**
 * Throws when an archived package cannot resolve a dependency or required peer.
 *
 * @param archivePath - path to `app.asar`, or to a resources directory containing it.
 */
export async function verifyAsarDependencies(archivePath: string, options: VerifyOptions = {}): Promise<void> {
  const unresolved = await findUnresolvedDependencies(archivePath, options)
  if (unresolved.length > 0) throw new UnresolvedDependenciesError(archivePath, unresolved)
}

/** The parts of electron-builder's `AfterPackContext` this hook reads. */
type AfterPackContext = {
  appOutDir: string
  electronPlatformName: string
  packager: { getResourcesDir(appOutDir: string): string }
}

/**
 * Builds an electron-builder `afterPack` hook that fails the build on unresolved dependencies.
 *
 * ```js
 * // electron-builder.config.mjs
 * import { afterPack } from 'verify-asar-deps'
 * export default { afterPack: afterPack() }
 * ```
 */
export function afterPack(options: VerifyOptions = {}): (context: AfterPackContext) => Promise<void> {
  return async (context) => {
    await verifyAsarDependencies(context.packager.getResourcesDir(context.appOutDir), options)
  }
}
