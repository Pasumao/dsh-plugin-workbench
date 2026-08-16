#!/usr/bin/env node
/**
 * verify-alignment.mjs — keep the plugin's three identities in sync.
 *
 * The dsh web boot fails with
 *   failed to import loader entry ... (X): client-modules: bundle ... loaded
 *   without registering "X" via __ModuleLoader__.load
 * whenever the loader-entry name (the name the plugin is INSTALLED under in the
 * dsh profile, or the `name:` in the profile's cordis.patch.yml insert) differs
 * from the id the built client bundle registers — and the bundle always
 * registers the package.json `name` (baked in at build time).
 *
 * This script checks all three against package.json's `name`:
 *   1. built bundle registration id (lib/client.js head)
 *   2. profile package.json dependency key pointing at this repo
 *   3. profile cordis.patch.yml insert `name:` / dsh.profile.bundles entries
 * and exits non-zero (failing the build via the `postbuild` hook) when they
 * drift, so a rebuild can never silently break the next dsh boot again.
 *
 * Usage:
 *   node scripts/verify-alignment.mjs            # check (exit 1 on mismatch)
 *   node scripts/verify-alignment.mjs --fix      # repair profile files, re-check
 *   node scripts/verify-alignment.mjs --profile <name>   # default: web
 *   DSH_VERIFY_SKIP=1 node ...                  # bypass (CI / other machines)
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const REPO_ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
/** Read a text file, stripping a UTF-8 BOM if present (JSON.parse / regexes reject it). */
function readUtf8(path) {
  const raw = readFileSync(path, 'utf8')
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

const MANIFEST = JSON.parse(readUtf8(join(REPO_ROOT, 'package.json')))
const REAL_NAME = MANIFEST.name
/** The scoped alias this plugin was historically installed under (null when the name is already scoped). */
const ALIAS = REAL_NAME.startsWith('@') ? null : `@dsh-external/${REAL_NAME}`
const ALIAS_RE = ALIAS ? new RegExp(`name:\\s*['"]?${escapeRegExp(ALIAS)}['"]?`) : null

const args = process.argv.slice(2)
const profileName = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'web'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profileName)
const manifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')

if (process.env.DSH_VERIFY_SKIP === '1') {
  console.log('[verify-alignment] skipped (DSH_VERIFY_SKIP=1).')
  process.exit(0)
}

const clientRel = (() => {
  const c = MANIFEST.exports?.['./client']
  if (typeof c === 'string') return c
  if (c && typeof c.default === 'string') return c.default
  return 'lib/client.js'
})()

/** One check pass; returns the list of mismatches (empty = aligned). */
function check() {
  const failures = []
  const clientPath = join(REPO_ROOT, clientRel)
  if (existsSync(clientPath)) {
    const head = readUtf8(clientPath).slice(0, 400)
    const m = /id:\s*"([^"]+)"/.exec(head)
    if (!m) {
      failures.push(`lib/client.js does not open with a __ModuleLoader__.load({ id: ... }) registration — is the bundle built?`)
    } else if (m[1] !== REAL_NAME) {
      failures.push(`bundle registers "${m[1]}" but package.json name is "${REAL_NAME}" — rebuild produced a mismatched id (tsdown derives it from the package name).`)
    } else {
      console.log(`[verify] bundle registration id OK: ${m[1]}`)
    }
  } else {
    failures.push(`client bundle not found at ${clientPath} — run pnpm run build first.`)
  }

  if (!existsSync(manifestPath)) {
    console.log(`[verify] profile "${profileName}" not found at ${profileDir} — skipping profile checks (fine outside this machine).`)
    return failures
  }

  const profile = JSON.parse(readUtf8(manifestPath))
  const deps = profile.dependencies ?? {}
  const here = Object.entries(deps)
    .map(([key, spec]) => {
      const target = String(spec).replace(/^(?:link|file|workspace):/i, '').replace(/^\.\//, '')
      const abs = resolve(profileDir, target)
      try {
        return { key, resolved: existsSync(abs) ? realpathSync(abs) : null }
      } catch {
        return { key, resolved: null }
      }
    })
    .filter((d) => d.resolved === REPO_ROOT)
    .map((d) => d.key)

  if (here.length === 0) {
    console.log(`[verify] ${REAL_NAME} is not installed in profile "${profileName}" — skipping install-name checks.`)
  } else if (here.includes(REAL_NAME)) {
    console.log(`[verify] profile install name OK: ${REAL_NAME}`)
  } else {
    failures.push(`profile dependency is keyed "${here[0]}" but must be "${REAL_NAME}": the loader entry name follows the install key, while the bundle registers the package name.`)
  }

  const bundles = profile.dsh?.profile?.bundles ?? []
  if (ALIAS && bundles.includes(ALIAS)) {
    failures.push(`dsh.profile.bundles lists "${ALIAS}" but must be "${REAL_NAME}".`)
  }

  if (existsSync(patchPath)) {
    if (ALIAS_RE && ALIAS_RE.test(readUtf8(patchPath))) {
      failures.push(`cordis.patch.yml references "${ALIAS}" in an insert name — the name: must be "${REAL_NAME}" (matches the installed package and the bundle registration).`)
    } else {
      console.log('[verify] profile patch name OK (no mismatched insert name).')
    }
  }
  return failures
}

/** Apply the three profile repairs (only when the drift is unambiguous). Returns descriptions of what changed. */
function fix() {
  const fixed = []
  if (!existsSync(manifestPath)) return fixed
  const profile = JSON.parse(readUtf8(manifestPath))
  const deps = profile.dependencies ?? {}

  if (ALIAS && deps[ALIAS] !== undefined && deps[REAL_NAME] === undefined) {
    profile.dependencies[REAL_NAME] = deps[ALIAS]
    delete profile.dependencies[ALIAS]
    fixed.push(`package.json dependency key ${ALIAS} → ${REAL_NAME}`)
  }

  const bundles = profile.dsh?.profile?.bundles ?? []
  if (ALIAS && bundles.includes(ALIAS)) {
    profile.dsh.profile.bundles = bundles.map((b) => (b === ALIAS ? REAL_NAME : b))
    fixed.push(`dsh.profile.bundles entry ${ALIAS} → ${REAL_NAME}`)
  }

  if (fixed.length > 0) writeFileSync(manifestPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')

  if (ALIAS && existsSync(patchPath)) {
    let text = readUtf8(patchPath)
    const before = text
    text = text.replace(ALIAS_RE, (full) => full.replace(ALIAS, REAL_NAME))
    if (text !== before) {
      writeFileSync(patchPath, text, 'utf8')
      fixed.push(`cordis.patch.yml insert name ${ALIAS} → ${REAL_NAME}`)
    }
  }
  return fixed
}

let failures = check()
if (failures.length > 0 && args.includes('--fix')) {
  const fixed = fix()
  if (fixed.length > 0) console.log(`[verify] fixed: ${fixed.join('; ')}`)
  failures = check()
  if (failures.length === 0) {
    console.log(`[verify] now re-link in the profile and restart dsh web:`)
    console.log(`  cd "${profileDir}" && pnpm install`)
  }
}

if (failures.length > 0) {
  console.error(`[verify-alignment] FAILED — ${failures.length} mismatch(es):`)
  for (const f of failures) console.error(`  - ${f}`)
  console.error('[verify-alignment] fix with: node scripts/verify-alignment.mjs --fix   (then pnpm install + restart dsh web)')
  process.exit(1)
}

console.log(`[verify-alignment] PASS — bundle id, install name, and patch name all agree on "${REAL_NAME}".`)
process.exit(0)

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
