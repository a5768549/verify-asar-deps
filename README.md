# verify-asar-deps

Fail an Electron build when a package inside `app.asar` cannot resolve one of its dependencies, instead of shipping an app that crashes at launch with `ERR_MODULE_NOT_FOUND`.

```text
$ npx verify-asar-deps release/win-unpacked/resources
release/win-unpacked/resources: 2 unresolved:
  node_modules/@scope/lib -> @scope/util
  node_modules/@scope/lib -> left-pad
$ echo $?
1
```

## Why

electron-builder decides what goes into `app.asar/node_modules` from the package manager's dependency listing. With pnpm workspaces, a workspace package that is already expanded under another project can be listed only as a deduplicated reference without children. The package itself is copied, but its transitive dependencies are not. Everything works in development and in `electron .`; the packaged app dies on start.

Import checks over your source, and `npm ls` over the workspace, both look at the tree before packaging. This tool reads the **finished archive** and applies Node's own `node_modules` lookup to every package in it:

- every `package.json` directly under a `node_modules` directory (scoped packages included) is a package;
- each `dependencies` entry and each non-optional `peerDependencies` entry must be found in that package's own `node_modules` or in an ancestor `node_modules`, the same walk Node does, never in a sibling;
- `optionalDependencies` and peers marked `peerDependenciesMeta.<name>.optional` are skipped;
- files packed into `app.asar.unpacked` are read from there.

It has no runtime dependencies; the asar header is parsed directly, so it does not depend on electron-builder internals.

## When it fits

It is meant for apps that **load `node_modules` at runtime**: the main process or a utility process does `require()` or `import` of packages from the archive. That is the case where a missing package is a launch crash.

If your app is bundled (Vite, webpack, esbuild) and `node_modules` in the archive is mostly leftover, many listed dependencies are never loaded. The tool will report them anyway, because it cannot know what your bundle imports. Either run it only on the packages that are actually loaded at runtime, or use `ignoreDependencies` / `ignorePeers` for the known-unused ones. As a data point, one bundled Electron app on my machine reported 289 entries, almost all of them dependencies that the bundle never loads.

## Install

```sh
npm install --save-dev verify-asar-deps
```

Node.js 18 or later.

## electron-builder `afterPack` hook

```js
// electron-builder.config.mjs
import { afterPack } from 'verify-asar-deps'

export default {
  // ...
  afterPack: afterPack({
    // A peer that the packaged entry point never imports:
    ignorePeers: { '@my/gateway': ['@my/client-ui'] },
  }),
}
```

If you already have an `afterPack`, call the check from it:

```js
import { verifyAsarDependencies } from 'verify-asar-deps'

export default {
  afterPack: async (context) => {
    // ...your own steps
    await verifyAsarDependencies(context.packager.getResourcesDir(context.appOutDir))
  },
}
```

## CLI

```text
verify-asar-deps <app.asar | resources dir> [--ignore-peer pkg=peer]... [--ignore pkg=dep]... [--json]
```

Exit code `0` when everything resolves, `1` when something does not, `2` on usage or read errors.

## API

| Export | What it does |
|---|---|
| `findUnresolvedDependencies(path, options?)` | Returns `{ packagePath, packageName, dependency, kind }[]`. `path` is `app.asar` or the directory containing it. |
| `verifyAsarDependencies(path, options?)` | Throws `UnresolvedDependenciesError` (with `.unresolved`) when the list is not empty. |
| `afterPack(options?)` | An electron-builder `afterPack` hook that runs the check. |
| `readAsarArchive(path)` | The parsed header tree plus `readFile(segments)`, if you want to inspect an archive yourself. |
| `formatUnresolved(entry)` | `node_modules/pkg -> dep`, with ` (peer)` for peers. |

Options: `ignorePeers` and `ignoreDependencies`, each a map from package name to the names to skip for that package.

## Development

```sh
npm install
npm test   # builds real archives with @electron/asar
npm run typecheck
npm run build
```

## License

[MIT](LICENSE)
