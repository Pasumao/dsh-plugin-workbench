/**
 * Host half of the workbench plugin.
 *
 * Registers one loopback-only generic RPC channel (`/dsh-plugin-files`) with
 * list/read/write endpoints over `ctx.fs` (the sandboxed filesystem service),
 * plus New File / New Folder / Rename / Delete for the explorer's context
 * menu. Reads pass through untouched in every sandbox mode; the context-menu
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
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, rename as renameFs, rm, writeFile as writeFileNode } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-plugin-workbench'
export const inject = ['fs', 'connection', 'webServer']

/** Loopback-only logical RPC channel. */
export const CHANNEL = '/dsh-plugin-files'

/** Files larger than this are never read for preview (client shows size + hint). */
export const MAX_PREVIEW_BYTES = 512 * 1024

/** Same-origin route serving raw bytes for image files (see module doc). */
export const RAW_PREFIX = '/dsh-plugin-files/raw'

/** Images larger than this are never served to the preview (browser shows a hint). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

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
}

export type FilesRpcOk = { ok: true; value: FsListResult | FsReadResult | FsWriteResult | FsMutationResult }
export type FilesRpcErr = { ok: false; error: { code: 'internal'; message: string; details: Record<string, never> } }
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
 * One filesystem-backed RPC endpoint pair. Reads never mutate; `signal`
 * cancels the underlying fs call (or aborts between steps).
 */
export function apply(ctx: Context): void {
  const handler = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> => {
    if (endpoint === 'list') return listDir(ctx, payload, signal)
    if (endpoint === 'read') return readFile(ctx, payload, signal)
    if (endpoint === 'write') return writeFile(ctx, payload, signal)
    if (endpoint === 'createFile') return createFile(ctx, payload, signal)
    if (endpoint === 'createDir') return createDir(ctx, payload, signal)
    if (endpoint === 'rename') return renameEntry(ctx, payload, signal)
    if (endpoint === 'delete') return deleteEntry(ctx, payload, signal)
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

async function writeFile(ctx: Context, payload: unknown, signal: AbortSignal): Promise<FilesRpcResult> {
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
    return { ok: true, value: { path: ctx.fs.processPath(target), size: content.length } }
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
    await renameFs(osPath, toOsPath)
    return { ok: true, value: { path: toOsPath } }
  } catch (error) {
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
    await rm(osPath, { recursive: info.type === 'directory', force: true })
    return { ok: true, value: { path: osPath } }
  } catch (error) {
    return fail(mapError(error))
  }
}
