#!/usr/bin/env node
/**
 * verify-asar-deps <app.asar | resources dir> [--ignore-peer pkg=peer]... [--ignore pkg=dep]... [--json]
 */
import { findUnresolvedDependencies, formatUnresolved, type VerifyOptions } from './index.ts'

const USAGE = 'usage: verify-asar-deps <app.asar | resources dir> [--ignore-peer pkg=peer]... [--ignore pkg=dep]... [--json]'

function addPair(target: Record<string, string[]>, value: string | undefined, flag: string): void {
  const at = value?.lastIndexOf('=') ?? -1
  if (value === undefined || at <= 0 || at === value.length - 1) throw new Error(`${flag} expects pkg=name, got ${String(value)}`)
  const key = value.slice(0, at)
  ;(target[key] ??= []).push(value.slice(at + 1))
}

async function main(argv: string[]): Promise<number> {
  const ignorePeers: Record<string, string[]> = {}
  const ignoreDependencies: Record<string, string[]> = {}
  let json = false
  let target: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--json') json = true
    else if (arg === '--ignore-peer') addPair(ignorePeers, argv[++i], arg)
    else if (arg === '--ignore') addPair(ignoreDependencies, argv[++i], arg)
    else if (arg === '-h' || arg === '--help') { console.log(USAGE); return 0 }
    else if (arg.startsWith('-') || target !== undefined) throw new Error(`unexpected argument ${arg}\n${USAGE}`)
    else target = arg
  }
  if (target === undefined) throw new Error(USAGE)
  const options: VerifyOptions = { ignorePeers, ignoreDependencies }
  const unresolved = await findUnresolvedDependencies(target, options)
  if (json) {
    console.log(JSON.stringify({ archive: target, unresolved }, null, 2))
  } else if (unresolved.length === 0) {
    console.log(`${target}: every archived package resolves its dependencies`)
  } else {
    console.error(`${target}: ${unresolved.length} unresolved:`)
    for (const entry of unresolved) console.error(`  ${formatUnresolved(entry)}`)
  }
  return unresolved.length === 0 ? 0 : 1
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 2
})
