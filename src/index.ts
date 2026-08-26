/**
 * Host half of the workbench plugin.
 *
 * Registers one loopback-only generic RPC channel (`/dsh-plugin-files`) with
 * list/read/write endpoints over `ctx.fs` (the sandboxed filesystem service),
 * plus New File / New Folder / Rename / Delete / Copy for the explorer's
 * context menu and a `reveal` endpoint that shows an item in the OS file manager. Reads pass through untouched in every sandbox mode; the context-menu
 * mutations and the editor write are explicit user actions over the
 * loopback-only channel, run unfenced like the /api write tools — the sandbox
 * service has no mkdir/rename/rm primitives, so those use node:fs/promises
 * after the same `ctx.fs.resolve` → `processPath` resolution as every read.
 *
 * Image preview: files with a known image extension are never read over the
 * RPC channel. Instead a same-origin web route (`ctx.webServer`) serves their
 * raw bytes straight into the preview pane's `<img>` tag — the same pattern
 * dsh-plugin-image-tools uses for inline chat images. The route resolves and
 * stats the path through `ctx.fs` (so sandbox containment and file-ness apply
 * exactly as for RPC reads) and only ever serves image extensions.
 *
 * Disk watching: the client keeps the host's watch set in sync with the open
 * tabs via the `watch` endpoint. The host watches each file's PARENT DIRECTORY
 * with `fs.watch` (survives atomic editor renames on Windows, unlike watching
 * the file itself), coalesces events per path, and pushes `change` frames over
 * a same-origin SSE route (`/dsh-plugin-files/events`) that the preview pane
 * consumes. Writes this plugin performs itself are suppressed for a short
 * window so a save never bounces back as a "changed on disk" event.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, watch as watchFs } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { mkdir, rename as renameFs, rm, cp, writeFile as writeFileNode } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-plugin-workbench'
export const inject = ['fs', 'connection', 'webServer', 'systemPrompt', 'agents']

/** Loopback-only logical RPC channel. */
export const CHANNEL = '/dsh-plugin-files'

/** Files larger than this are never read for preview (client shows size + hint). */
export const MAX_PREVIEW_BYTES = 512 * 1024

/** Same-origin route serving raw bytes for image files (see module doc). */
export const RAW_PREFIX = '/dsh-plugin-files/raw'

/** Same-origin SSE route streaming disk-change events to the preview pane. */
export const EVENTS_PREFIX = '/dsh-plugin-files/events'

/** Images larger than this are never served to the preview (browser shows a hint). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Coalesce bursty editor writes into a single change notification. */
const WATCH_DEBOUNCE_MS = 300

/** Ignore fs.watch events caused by this plugin's own saves (see module doc). */
const SELF_WRITE_WINDOW_MS = 1500

/** SSE keep-alive interval (proxies may otherwise drop idle connections). */
const SSE_HEARTBEAT_MS = 15000

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** MIME type for a path's extension when it names a previewable image; undefined otherwise. */
export function imageMimeOf(path: string): string | undefined {
  const idx = path.lastIndexOf('.')
  if (idx < 0 || idx === path.length - 1) return undefined
  return IMAGE_MIME[path.slice(idx + 1).toLowerCase()]
}

/** True when the path names a previewable image file. */
export function isImagePath(path: string): boolean {
  return imageMimeOf(path) !== undefined
}

export type FsKind = 'dir' | 'file' | 'other'

export interface FsListEntry {
  name: string
  path: string
  kind: FsKind
  size?: number
}

export interface FsListResult {
  root: string
  entries: FsListEntry[]
}

export interface FsReadResult {
  path: string
  content: string
  size: number
  binary: boolean
  truncated: boolean
}

export interface FsWriteResult {
  path: string
  size: number
}

/** Result of a context-menu mutation (create/rename/delete). */
export interface FsMutationResult {
  path: string
  /**
   * Copy-only: `true` when the destination already existed and the copy was
   * skipped (overwrite was false). Reported in the SUCCESS value — the generic
   * RPC channel validates error bodies against the core's closed error-code
   * union, so a custom error code like 'exists' would fail client-side parsing.
   */
  exists?: boolean
}

export type FilesRpcOk = { ok: true; value: FsListResult | FsReadResult | FsWriteResult | FsMutationResult }
export type FilesRpcErr = { ok: false; error: { code: string; message: string; details: Record<string, never> } }
export type FilesRpcResult = FilesRpcOk | FilesRpcErr

/**
 * Raw `ctx.fs.listDir` row shape (loose — the real service is authoritative at
 * runtime; these types only document the contract and keep the pure helpers
 * testable without importing the whole runtime d.ts chain).
 */
export interface RawDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: unknown
  size?: number
}

/** Map an fs entry type onto the wire `kind` union. */
export function kindOf(type: string): FsKind {
  if (type === 'directory') return 'dir'
  if (type === 'file') return 'file'
  return 'other'
}

/** Project a raw fs dir entry onto the wire-safe row shape. */
export function mapDirEntry(entry: RawDirEntry, processPath: (target: unknown) => string): FsListEntry {
  const kind = kindOf(entry.type)
  return {
    name: entry.name,
    path: processPath(entry.target),
    kind,
    ...(kind === 'file' && entry.size !== undefined ? { size: entry.size } : {}),
  }
}

/** Directories first, then case-insensitive name sort (numeric-aware). */
export function sortEntries(entries: FsListEntry[]): FsListEntry[] {
  return [...entries].sort((a, b) => {
    const ad = a.kind === 'dir' ? 0 : 1
    const bd = b.kind === 'dir' ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })
}

const FS_ERROR_MESSAGES: Record<string, string> = {
  FS_NOT_FOUND: 'path does not exist',
  FS_NOT_DIRECTORY: 'not a directory',
  FS_NOT_REGULAR_FILE: 'not a regular file',
  FS_NOT_TEXT: 'binary file',
  FS_TOO_LARGE: 'file too large',
  FS_PERMISSION_DENIED: 'permission denied',
  FS_SANDBOX_DENIED: 'sandbox denied',
  FS_ABORTED: 'aborted',
  FS_IO_ERROR: 'io error',
  // node:fs error codes surfaced by the context-menu mutations below.
  EEXIST: 'file or folder already exists',
  ENOENT: 'path does not exist',
  ENOTEMPTY: 'folder is not empty',
  EPERM: 'permission denied',
  EACCES: 'permission denied',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  EBUSY: 'file is in use',
}

/** Human-readable message for a thrown value, honoring the fs error code taxonomy. */
export function mapError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && FS_ERROR_MESSAGES[code] !== undefined) return FS_ERROR_MESSAGES[code]
    return error.message
  }
  return String(error)
}

function isFsErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === code
}

/**
 * EPERM / EBUSY from a move or remove almost always means the path — or, on
 * Windows, a file INSIDE a directory being moved/deleted — is open elsewhere
 * (an editor, Explorer, a terminal sitting inside it, an antivirus scan).
 * EACCES is left alone: that usually means read-only/ACL, not a lock.
 */
function isInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'EPERM' || code === 'EBUSY'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry a mutation a bounded number of times while it fails with a transient
 * Windows lock (indexer/antivirus handles usually clear within milliseconds).
 * Genuine "permission denied" / "in use" errors surface after the retries.
 */
async function withLockRetry(op: () => Promise<void>, attempts = 3, gapMs = 150): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await op()
      return
    } catch (error) {
      if (!isInUseError(error) || attempt >= attempts) throw error
      await sleep(gapMs * attempt)
    }
  }
}

/** Actionable replacement for a bare "permission denied" when a folder is locked. */
function lockMessage(path: string): string {
  return `"${basename(path)}" is in use by another program — close any editor/Explorer view of it (or a terminal inside it) and retry`
}

function fail(message: string): FilesRpcErr {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function pathOf(payload: unknown): string | undefined {
  if (typeof payload === 'object' && payload !== null) {
    const path = (payload as { path?: unknown }).path
    if (typeof path === 'string' && path.trim().length > 0) return path
  }
  return undefined
}

/**
 * The explorer-column patch markers that scripts/patch-layout.mjs injects into
 * the compiled dsh-client-ui-layout client bundle. A dsh upgrade (or a
 * `pnpm install` that refreshes the ui-layout package) silently reverts that
 * bundle, which makes the workbench column vanish even though this plugin is
 * fine — this is the exact failure this auto-heal guards against.
 */
const LAYOUT_PATCH_MARKERS = [
  '"explorerCol": "',
  'setExplorer: (d, px) => {',
  'renderSlot("explorer"',
  'conversationSeat',
] as const

/** Resolve the installed dsh-client-ui-layout client bundle (profile node_modules junction). */
function layoutClientPath(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js')
}

/**
 * True when the ui-layout bundle already carries the explorer-column patch.
 * A missing bundle (non-standard install) is treated as "nothing to patch" so
 * the check never blocks a boot; an unreadable file likewise bails out to the
 * caller rather than throwing.
 */
function layoutIsPatched(): boolean {
  try {
    const target = layoutClientPath()
    if (!existsSync(target)) return true
    const text = readFileSync(target, 'utf8')
    return LAYOUT_PATCH_MARKERS.every((marker) => text.includes(marker))
  } catch {
    return true
  }
}

/** Module-level guard so a HMR/re-apply burst never spawns the patch twice concurrently. */
let layoutPatchScheduled = false

/**
 * Re-apply the ui-layout explorer-column patch when it is missing.
 *
 * The workbench column renders into a fourth `explorer` slot that is added to
 * the compiled dsh-client-ui-layout bundle by scripts/patch-layout.mjs. A dsh
 * upgrade silently reverts that bundle, so this re-runs the same
 * version-checked script: anchors that no longer match abort the script
 * WITHOUT writing, so an incompatible dsh version never corrupts the bundle —
 * it only logs a warning and the plugin still boots. Idempotent and
 * non-blocking (spawned fire-and-forget), so it never delays a boot.
 */
function ensureLayoutPatch(): void {
  if (layoutPatchScheduled) return
  layoutPatchScheduled = true
  try {
    if (layoutIsPatched()) return
    const script = join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'patch-layout.mjs')
    const child = spawn(process.execPath, [script], { stdio: 'inherit', windowsHide: true })
    child.on('error', (err) => {
      console.warn('[dsh-plugin-workbench] re-applying ui-layout explorer patch failed:', err.message)
      layoutPatchScheduled = false
    })
    child.on('close', (code) => {
      if (code === 0) {
        console.log('[dsh-plugin-workbench] re-applied the missing dsh-client-ui-layout explorer patch (likely reverted by a dsh upgrade).')
      } else {
        console.warn(`[dsh-plugin-workbench] ui-layout patch exited ${code}; the dsh version may have changed — run scripts/patch-layout.mjs manually.`)
        layoutPatchScheduled = false
      }
    })
  } catch (err) {
    console.warn('[dsh-plugin-workbench] ui-layout patch check failed:', err)
    layoutPatchScheduled = false
  }
}

/**
 * Stable system-prompt section teaching the model the workbench `@.\` mention
 * grammar. The core already contributes a generic "paths prefixed with @ are
 * files referenced by the user" section (dsh-file-reference-local, order 99);
 * this one documents the actual syntax the GUI inserts (the `.\` workspace
 * marker, quoted form for paths with spaces) so the model resolves mentions
 * against the session workspace root instead of treating `@.\…` as noise.
 * Static text only — the string is identical on every assembly (KV-cache safe).
 */
const FILE_MENTION_PROMPT =
  'Workspace file mentions written by the file panel use the form `@.<relative-path>` (a `.\` or `./` prefix marks a path relative to the current session workspace root; both `\\` and `/` separators are accepted, and paths with spaces use the quoted form `@"<relative-path>"`, for example `@"\\.\\my plan.md"`). Treat any such mention as a file the user wants you to read or edit: resolve the path against the workspace root and act on it with the file tools (read, glob, grep, edit, write); never claim to have inspected a file you did not actually open.'

/**
 * File-mention grammar taught to the model (see the FILE_MENTION_PROMPT doc).
 * One section per agent fiber: existing agents at apply time plus every agent
 * created later (agent/created). The core already contributes a generic "paths
 * prefixed with @ are files" section (dsh-file-reference-local, order 99);
 * order 100 puts this more specific grammar right after it.
 */
function installMentionPrompt(ctx: Context): void {
  const teach = (agent: { ctx: Context }): void => {
    agent.ctx.systemPrompt.section({
      name: 'dsh-plugin-workbench:file-mention',
      order: 100,
      text: FILE_MENTION_PROMPT,
    })
  }
  for (const agent of ctx.agents.list()) teach(agent)
  ctx.on('agent/created', (payload: unknown) => {
    const { agent } = payload as { agent: { ctx: Context } }
    teach(agent)
  })
}

/**
 * One filesystem-backed RPC endpoint pair. Reads never mutate; `signal`
 * cancels the underlying fs call (or aborts between steps).
 */
export function apply(ctx: Context): void {
  // Re-apply the ui-layout explorer-column patch when a dsh upgrade reverted it.
  ensureLayoutPatch()
  // Teach every agent the workbench `@.\` mention grammar (per-agent fiber).
  installMentionPrompt(ctx)
  // Per-apply watch state: created here (not module-level) so disable/reload
  // cycles never leak watchers or SSE clients across applies.
  const watchState: WatchState = {
    dirs: new Map(),
    files: new Map(),
    selfWrites: new Map(),
    clients: new Set(),
  }

  const handler = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> => {
    if (endpoint === 'list') return listDir(ctx, payload, signal)
    if (endpoint === 'read') return readFile(ctx, payload, signal)
    if (endpoint === 'write') return writeFile(ctx, watchState, payload, signal)
    if (endpoint === 'watch') return setWatch(ctx, watchState, payload, signal)
    if (endpoint === 'createFile') return createFile(ctx, payload, signal)
    if (endpoint === 'createDir') return createDir(ctx, payload, signal)
    if (endpoint === 'rename') return renameEntry(ctx, payload, signal)
    if (endpoint === 'delete') return deleteEntry(ctx, payload, signal)
    if (endpoint === 'copy') return copyEntry(ctx, payload, signal)
    if (endpoint === 'reveal') return revealInExplorer(ctx, payload, signal)
    return fail(`unknown endpoint: ${endpoint}`)
  }
  // Effect-wrapped so HMR/disable cycles dispose the channel (the connection
  // service registers the HTTP carrier for the channel the same way); a plain
  // call here would leak the route on reload and collide on re-apply.
  ctx.effect(() => ctx.connection.rpc.handle(CHANNEL, handler, { authority: 'loopback' }), 'dsh-plugin-workbench: files rpc channel')

  // Raw image bytes for the preview pane. The client builds the URL as
  // `${RAW_PREFIX}/${encodeURIComponent(path)}`; the suffix is decoded back to
  // the absolute path, then resolved/statted through the sandboxed fs service
  // before any byte is read (containment parity with the RPC read endpoint).
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: RAW_PREFIX,
    handler: (req, res) => {
      void serveRaw(ctx, req, res)
    },
  }), 'dsh-plugin-workbench: raw image route')

  // Disk-change stream: the SSE route + heartbeat + watcher lifecycle live in
  // one effect so disposal closes every client and every fs.watch handle.
  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_PREFIX,
      handler: (req, res) => sseHandler(watchState, req, res),
    })
    const heartbeat = setInterval(() => {
      for (const res of watchState.clients) {
        try {
          res.write(': ping\n\n')
        } catch {
          // Dropped client — removed by its own 'close' event.
        }
      }
    }, SSE_HEARTBEAT_MS)
    return () => {
      clearInterval(heartbeat)
      disposeRoute()
      disposeWatch(watchState)
    }
  }, 'dsh-plugin-workbench: disk change stream (SSE)')
}

// ---------------------------------------------------------------------------
// Disk watching (open-tab change detection)
//
// The client sends the full set of open tab paths; the host diffs it against
// the current watcher set. Each watched file lives under an `fs.watch` on its
// PARENT DIRECTORY (file-level handles die when editors atomic-rename, and
// directory watching also sees deletes), events are filtered by basename,
// coalesced per path, and pushed over the SSE route. `watch` is a pure
// reconciliation — call it as often as you like.
// ---------------------------------------------------------------------------

/** Per-apply watch registry (see the WatchState fields inline). */
interface WatchState {
  /** Parent dir → its fs.watch handle and the watched basenames living in it. */
  dirs: Map<string, { watcher: FSWatcher; basenames: Map<string, Set<string>> }>
  /** OS path → client-facing path + pending coalescing timer. */
  files: Map<string, { path: string; timer: ReturnType<typeof setTimeout> | undefined }>
  /** OS path → timestamp of the plugin's own last write (self-change suppression). */
  selfWrites: Map<string, number>
  /** Connected SSE responses. */
  clients: Set<ServerResponse>
}

/** Serve one SSE client connection (kept open until the browser disconnects). */
function sseHandler(state: WatchState, req: IncomingMessage, res: ServerResponse): void {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  state.clients.add(res)
  req.on('close', () => {
    state.clients.delete(res)
  })
}

/** Push one `change` frame to every connected SSE client. */
function emitChange(state: WatchState, path: string): void {
  const frame = `event: change\ndata: ${JSON.stringify({ path })}\n\n`
  for (const res of state.clients) {
    try {
      res.write(frame)
    } catch {
      // Client gone — dropped from the set by its 'close' event.
    }
  }
}

/**
 * Coalesce one filesystem event for an osPath into a single change
 * notification (editors emit several events per save; the debounce collapses
 * them). Events caused by this plugin's own saves are suppressed.
 */
function scheduleEmit(state: WatchState, osPath: string): void {
  const entry = state.files.get(osPath)
  if (entry === undefined) return
  const selfTs = state.selfWrites.get(osPath)
  if (selfTs !== undefined && Date.now() - selfTs < SELF_WRITE_WINDOW_MS) return
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    const still = state.files.get(osPath)
    if (still === undefined) return
    emitChange(state, still.path)
  }, WATCH_DEBOUNCE_MS)
}

/** Start (or extend) the parent-dir watcher covering osPath. */
function watchDir(state: WatchState, dir: string, osPath: string): boolean {
  let bucket = state.dirs.get(dir)
  if (bucket === undefined) {
    let watcher: FSWatcher
    try {
      watcher = watchFs(dir, { persistent: false }, (_eventType, filename) => {
        const name = typeof filename === 'string' ? filename : undefined
        if (name === undefined) {
          // Platform omitted the filename: re-emit for every watched file here.
          for (const os of state.files.keys()) {
            if (dirname(os) === dir) scheduleEmit(state, os)
          }
          return
        }
        const bucketNow = state.dirs.get(dir)
        const targets = bucketNow?.basenames.get(name)
        if (targets === undefined) return
        for (const os of targets) scheduleEmit(state, os)
      })
    } catch {
      return false
    }
    bucket = { watcher, basenames: new Map() }
    state.dirs.set(dir, bucket)
  }
  const name = basename(osPath)
  let targets = bucket.basenames.get(name)
  if (targets === undefined) {
    targets = new Set()
    bucket.basenames.set(name, targets)
  }
  targets.add(osPath)
  return true
}

/** Stop watching one osPath (and its parent dir when nothing else uses it). */
function unwatch(state: WatchState, osPath: string): void {
  const entry = state.files.get(osPath)
  if (entry === undefined) return
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  state.files.delete(osPath)
  state.selfWrites.delete(osPath)
  const dir = dirname(osPath)
  const bucket = state.dirs.get(dir)
  if (bucket === undefined) return
  const name = basename(osPath)
  const targets = bucket.basenames.get(name)
  if (targets !== undefined) {
    targets.delete(osPath)
    if (targets.size === 0) bucket.basenames.delete(name)
  }
  if (bucket.basenames.size === 0) {
    bucket.watcher.close()
    state.dirs.delete(dir)
  }
}

/** Close every watcher, pending timer and SSE client (effect disposal). */
function disposeWatch(state: WatchState): void {
  for (const bucket of state.dirs.values()) bucket.watcher.close()
  state.dirs.clear()
  for (const entry of state.files.values()) {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
  }
  state.files.clear()
  state.selfWrites.clear()
  for (const res of state.clients) {
    try {
      res.end()
    } catch {
      // Already closed.
    }
  }
  state.clients.clear()
}

/** Reconcile the watcher set with the client's open tab paths (idempotent). */
async function setWatch(ctx: Context, state: WatchState, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  const raw = typeof payload === 'object' && payload !== null ? (payload as { paths?: unknown }).paths : undefined
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string')) {
    return fail('watch: payload.paths must be an array of strings')
  }
  // Resolve each requested path to its OS path. Unresolvable paths (deleted,
  // sandboxed) are skipped; the next sync round retries them.
  const wanted = new Map<string, string>()
  for (const p of raw as string[]) {
    if (signal.aborted) break
    try {
      const target = await ctx.fs.resolve(p, { signal })
      const osPath = ctx.fs.processPath(target)
      // Key by OS path, keep the client's display path for the emit.
      wanted.set(osPath, p)
    } catch {
      // Not resolvable this round — drop it.
    }
  }
  // Remove watchers no longer wanted.
  for (const osPath of [...state.files.keys()]) {
    if (!wanted.has(osPath)) unwatch(state, osPath)
  }
  // Start missing watchers.
  for (const [osPath, displayPath] of wanted) {
    if (state.files.has(osPath)) continue
    if (!watchDir(state, dirname(osPath), osPath)) continue
    state.files.set(osPath, { path: displayPath, timer: undefined })
  }
  return { ok: true, value: { path: '' } }
}

async function serveRaw(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const text = (code: number, body: string): void => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(body)
  }
  try {
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      text(405, 'method not allowed')
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const rest = url.pathname.slice(RAW_PREFIX.length).replace(/^\/+/, '')
    if (rest.length === 0) {
      text(404, 'not found')
      return
    }
    const path = decodeURIComponent(rest)
    const mime = imageMimeOf(path)
    if (mime === undefined) {
      text(404, 'not an image')
      return
    }
    const target = await ctx.fs.resolve(path)
    const info = await ctx.fs.stat(target)
    if (info === undefined || info.type !== 'file') {
      text(404, 'not found')
      return
    }
    if ((info.size ?? 0) > MAX_IMAGE_BYTES) {
      text(413, 'image too large')
      return
    }
    const bytes = await ctx.fs.readBytes(target, undefined, MAX_IMAGE_BYTES)
    res.writeHead(200, {
      'content-type': mime,
      'content-length': bytes.byteLength,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    })
    res.end(Buffer.from(bytes))
  } catch (error) {
    if (!res.headersSent) text(500, 'internal error')
    else res.destroy()
  }
}

async function listDir(ctx: Context, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  const path = pathOf(payload)
  if (path === undefined) return fail('list: payload.path must be a non-empty string')
  try {
    const target = await ctx.fs.resolve(path, { signal })
    const info = await ctx.fs.stat(target, signal)
    if (info === undefined) return fail(`path not found: ${path}`)
    if (info.type !== 'directory') return fail(`not a directory: ${path}`)
    const raw = await ctx.fs.listDir(target, signal)
    const entries = sortEntries(raw.map((entry) => mapDirEntry(entry, (t) => ctx.fs.processPath(t))))
    return { ok: true, value: { root: ctx.fs.processPath(target), entries } }
  } catch (error) {
    return fail(mapError(error))
  }
}

async function readFile(ctx: Context, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  const path = pathOf(payload)
  if (path === undefined) return fail('read: payload.path must be a non-empty string')
  try {
    const target = await ctx.fs.resolve(path, { signal })
    const info = await ctx.fs.stat(target, signal)
    if (info === undefined) return fail(`path not found: ${path}`)
    if (info.type !== 'file') return fail(`not a regular file: ${path}`)
    const resolvedPath = ctx.fs.processPath(target)
    const size = info.size ?? 0
    if (size > MAX_PREVIEW_BYTES) {
      return { ok: true, value: { path: resolvedPath, content: '', size, binary: false, truncated: true } }
    }
    try {
      const content = await ctx.fs.readText(target, signal)
      return { ok: true, value: { path: resolvedPath, content, size, binary: false, truncated: false } }
    } catch (error) {
      if (isFsErrorCode(error, 'FS_NOT_TEXT')) {
        return { ok: true, value: { path: resolvedPath, content: '', size, binary: true, truncated: false } }
      }
      throw error
    }
  } catch (error) {
    return fail(mapError(error))
  }
}

async function writeFile(ctx: Context, state: WatchState, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  const path = pathOf(payload)
  const content = typeof payload === 'object' && payload !== null ? (payload as { content?: unknown }).content : undefined
  if (path === undefined) return fail('write: payload.path must be a non-empty string')
  if (typeof content !== 'string') return fail('write: payload.content must be a string')
  try {
    const target = await ctx.fs.resolve(path, { signal })
    // Editing is an explicit user action over the loopback-only channel; run
    // it unfenced (mirrors the /api write tools under danger-full-access).
    await ctx.fs.writeText(target, content, undefined, signal, {
      mode: 'danger-full-access',
      workspaceRoot: ctx.fs.processPath(target),
    })
    // This save will trip the fs.watch on the file's parent dir; suppress it
    // so an own save never bounces back as a "changed on disk" event.
    const osPath = ctx.fs.processPath(target)
    state.selfWrites.set(osPath, Date.now())
    // Prune stale markers occasionally.
    if (state.selfWrites.size > 64) {
      const cutoff = Date.now() - SELF_WRITE_WINDOW_MS * 4
      for (const [os, ts] of state.selfWrites) {
        if (ts < cutoff) state.selfWrites.delete(os)
      }
    }
    return { ok: true, value: { path: osPath, size: content.length } }
  } catch (error) {
    return fail(mapError(error))
  }
}

// ---------------------------------------------------------------------------
// Context-menu mutations (New File / New Folder / Rename / Delete)
//
// The sandboxed `ctx.fs` service exposes no mkdir/rename/rm primitives, so
// these run node:fs/promises directly. Every path is first run through
// `ctx.fs.resolve` (which realpaths the nearest existing ancestor, so new
// targets resolve too) and the operation executes at `processPath(target)` —
// the same resolution the read/write endpoints use. Like `write`, these are
// explicit user actions over the loopback-only channel; nothing here is ever
// reached by a remote caller.
// ---------------------------------------------------------------------------

async function createFile(ctx: Context, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  const path = pathOf(payload)
  if (path === undefined) return fail('createFile: payload.path must be a non-empty string')
  try {
    const target = await ctx.fs.resolve(path, { signal })
    const osPath = ctx.fs.processPath(target)
    // 'wx' fails when the file already exists (VS Code New File semantics).
    await writeFileNode(osPath, '', { flag: 'wx' })
    return { ok: true, value: { path: osPath } }
  } catch (error) {
    return fail(mapError(error))
  }
}

async function createDir(ctx: Context, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  const path = pathOf(payload)
  if (path === undefined) return fail('createDir: payload.path must be a non-empty string')
  try {
    const target = await ctx.fs.resolve(path, { signal })
    const osPath = ctx.fs.processPath(target)
    // Non-recursive: the parent must already exist; EEXIST when the folder does.
    await mkdir(osPath)
    return { ok: true, value: { path: osPath } }
  } catch (error) {
    return fail(mapError(error))
  }
}

async function renameEntry(ctx: Context, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  const path = pathOf(payload)
  const to = typeof payload === 'object' && payload !== null ? (payload as { to?: unknown }).to : undefined
  if (path === undefined) return fail('rename: payload.path must be a non-empty string')
  if (typeof to !== 'string' || to.trim().length === 0) return fail('rename: payload.to must be a non-empty string')
  try {
    const target = await ctx.fs.resolve(path, { signal })
    const osPath = ctx.fs.processPath(target)
    const toTarget = await ctx.fs.resolve(to, { signal })
    const toOsPath = ctx.fs.processPath(toTarget)
    // fs.rename overwrites silently on POSIX; refuse when the destination exists.
    const existing = await ctx.fs.stat(toTarget, signal)
    if (existing !== undefined) return fail('rename: destination already exists')
    // Windows refuses to move a directory while it (or a file inside it) is
    // open elsewhere; transient locks clear quickly, so retry briefly before
    // reporting the actionable "in use" message.
    await withLockRetry(() => renameFs(osPath, toOsPath))
    return { ok: true, value: { path: toOsPath } }
  } catch (error) {
    if (isInUseError(error)) return fail(lockMessage(path))
    return fail(mapError(error))
  }
}

async function deleteEntry(ctx: Context, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  const path = pathOf(payload)
  if (path === undefined) return fail('delete: payload.path must be a non-empty string')
  try {
    const target = await ctx.fs.resolve(path, { signal })
    const osPath = ctx.fs.processPath(target)
    const info = await ctx.fs.stat(target, signal)
    if (info === undefined) return fail(`path not found: ${path}`)
    // Folders are removed recursively (the client confirms before calling).
    // Like rename, a folder with an open inner file fails on Windows; retry
    // transient locks, then report the actionable "in use" message.
    await withLockRetry(() => rm(osPath, { recursive: info.type === 'directory', force: true }))
    return { ok: true, value: { path: osPath } }
  } catch (error) {
    if (isInUseError(error)) return fail(lockMessage(path))
    return fail(mapError(error))
  }
}

// ---------------------------------------------------------------------------
// Copy (the explorer's Copy / Cut + Paste)
//
// `fs.cp` handles files and (recursively) folders; `errorOnExist` turns a
// colliding destination into an `ERR_FS_CP_EEXIST` throw, which is reported as
// a SUCCESS with `exists: true` so the client can ask the user whether to
// overwrite, exactly like the OS file manager. The same `ctx.fs.resolve` →
// `processPath` resolution as every other endpoint applies, so sandbox
// containment and error mapping stay uniform. (Reported in the value, never as
// an error body: generic-channel errors must use the core's closed error-code
// union, and a custom code there would fail the client-side response parse.)
// ---------------------------------------------------------------------------

async function copyEntry(ctx: Context, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  // Note: the client sends `from`, not `path` (which is what pathOf reads).
  const from = typeof payload === 'object' && payload !== null ? (payload as { from?: unknown }).from : undefined
  const to = typeof payload === 'object' && payload !== null ? (payload as { to?: unknown }).to : undefined
  const overwrite = typeof payload === 'object' && payload !== null && (payload as { overwrite?: unknown }).overwrite === true
  if (typeof from !== 'string' || from.trim().length === 0) return fail('copy: payload.from must be a non-empty string')
  if (typeof to !== 'string' || to.trim().length === 0) return fail('copy: payload.to must be a non-empty string')
  let toOs = ''
  try {
    const fromTarget = await ctx.fs.resolve(from, { signal })
    const fromOs = ctx.fs.processPath(fromTarget)
    const info = await ctx.fs.stat(fromTarget, signal)
    if (info === undefined) return fail(`path not found: ${from}`)
    const toTarget = await ctx.fs.resolve(to, { signal })
    toOs = ctx.fs.processPath(toTarget)
    // Refuse trivial self-copies and copying a folder into itself or one of
    // its own descendants (comparisons case-insensitive — Windows).
    const samePath = fromOs.toLowerCase() === toOs.toLowerCase()
    if (samePath) return fail('copy: source and destination are the same path')
    if (info.type === 'directory') {
      const sep = fromOs.includes('\\') ? '\\' : '/'
      const prefix = fromOs.endsWith('\\') || fromOs.endsWith('/') ? fromOs : fromOs + sep
      if (toOs.toLowerCase().startsWith(prefix.toLowerCase())) return fail('copy: cannot copy a folder into itself')
    }
    await cp(fromOs, toOs, { recursive: true, force: overwrite, errorOnExist: !overwrite })
    return { ok: true, value: { path: toOs } }
  } catch (error) {
    if (isFsErrorCode(error, 'ERR_FS_CP_EEXIST')) {
      // Destination already exists and overwrite was not requested: report the
      // collision as a successful no-op so the client can ask about overwrite.
      return { ok: true, value: { path: toOs, exists: true } }
    }
    // Copying a folder with an open inner file fails like move/delete do.
    if (isInUseError(error)) return fail(lockMessage(from))
    return fail(mapError(error))
  }
}

// ---------------------------------------------------------------------------
// Reveal in the OS file manager ("在资源管理器打开")
//
// Spawns the platform's file-manager command so the item shows up in the
// system explorer — files are SELECTED inside their containing folder
// (Windows `explorer /select,`, macOS `open -R`), folders are OPENED directly
// (`explorer <dir>`, `open <dir>`). WSL paths are translated through
// `wslpath` first; desktop Linux falls back to `xdg-open` (file → its parent
// directory, folder → itself). Paths are resolved through `ctx.fs` first, so
// the sandbox containment applies exactly as for every other endpoint; the
// spawn itself is a local desktop action, the same trust level as the existing
// "open in system" gesture (`ctx.workspaces.openPath`).
// ---------------------------------------------------------------------------

/**
 * Spawn one short-lived desktop command; resolves once the process launched.
 *
 * `windowsHide` defaults to true (no console flash for console-subsystem
 * helpers). EXPLORER.EXE IS THE ONE EXCEPTION: spawning it with
 * `windowsHide: true` sets CREATE_NO_WINDOW, and the new shell folder window
 * is then created HIDDEN — the folder opens on screen but stays invisible, so
 * the user sees "nothing happened". (Verified empirically: the CabinetWClass
 * window exists with `visible=False`; dropping the flag makes it visible.)
 * explorer.exe is a GUI-subsystem app, so `windowsHide: false` never flashes
 * a console — pass false on every Windows explorer.exe spawn.
 * @param args - argv (never a shell string).
 */
function runDesktop(command: string, args: string[], windowsHide = true): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide })
    child.once('error', reject)
    child.once('spawn', () => {
      // The window stays after the harness exits; nothing to wait for.
      child.unref()
      resolve()
    })
  })
}

/** Run one command and capture its stdout; rejects on non-zero exit. */
function execCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

/** Reveal one resolved OS path in the platform's file manager. */
async function revealNative(osPath: string, isDir: boolean, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const platform = process.platform
  if (platform === 'win32') {
    // explorer returns exit code 1 when it opens a NEW window, so exit codes
    // carry no meaning; a clean spawn is success. Files are selected in their
    // folder; folders are opened directly. windowsHide MUST stay false for
    // explorer.exe (see runDesktop doc: CREATE_NO_WINDOW hides the new window).
    await runDesktop('explorer.exe', isDir ? [osPath] : ['/select,', osPath], false)
    return
  }
  if (platform === 'darwin') {
    // `open -R` reveals in Finder; plain `open` opens a folder.
    await runDesktop('open', isDir ? [osPath] : ['-R', osPath])
    return
  }
  if (platform === 'linux') {
    // WSL: translate to a Windows path and hand it to the Windows desktop.
    const env = process.env
    if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) {
      const windowsPath = (await execCapture('wslpath', ['-w', osPath])).replace(/[\r\n]+$/, '')
      if (windowsPath === '') throw new Error('wslpath returned no Windows path')
      await runDesktop('explorer.exe', isDir ? [windowsPath] : ['/select,', windowsPath], false)
      return
    }
    // Desktop Linux: the default file manager opens folders; files open in
    // their parent directory.
    await runDesktop('xdg-open', [isDir ? osPath : dirname(osPath)])
    return
  }
  throw new Error(`reveal in the file manager is unsupported on ${platform}`)
}

/** RPC endpoint: reveal one explorer path in the OS file manager. */
async function revealInExplorer(ctx: Context, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
  const path = pathOf(payload)
  const kind = typeof payload === 'object' && payload !== null ? (payload as { kind?: unknown }).kind : undefined
  if (path === undefined) return fail('reveal: payload.path must be a non-empty string')
  try {
    const target = await ctx.fs.resolve(path, { signal })
    const info = await ctx.fs.stat(target, signal)
    if (info === undefined) return fail(`path not found: ${path}`)
    const isDir = kind === 'dir' || info.type === 'directory'
    const osPath = ctx.fs.processPath(target)
    await revealNative(osPath, isDir, signal)
    return { ok: true, value: { path: osPath } }
  } catch (error) {
    if (signal.aborted) return fail('reveal: aborted')
    return fail(mapError(error))
  }
}
