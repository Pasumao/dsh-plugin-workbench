/**
 * Host half of the workbench plugin.
 *
 * Registers one loopback-only generic RPC channel (`/dsh-plugin-files`) with
 * two endpoints, both implemented over `ctx.fs` (the sandboxed filesystem
 * service). Reads pass through untouched in every sandbox mode, so this
 * plugin only ever lists and reads — it never mutates the workspace.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-plugin-workbench'
export const inject = ['fs', 'connection']

/** Loopback-only logical RPC channel. */
export const CHANNEL = '/dsh-plugin-files'

/** Files larger than this are never read for preview (client shows size + hint). */
export const MAX_PREVIEW_BYTES = 512 * 1024

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

export type FilesRpcOk = { ok: true; value: FsListResult | FsReadResult | FsWriteResult }
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
    return fail(`unknown endpoint: ${endpoint}`)
  }
  ctx.connection.rpc.handle(CHANNEL, handler, { authority: 'loopback' })
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
