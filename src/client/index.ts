/**
 * Client half of the files-explorer plugin.
 *
 * Registers the file tree into the `explorer` slot and the split preview into
 * the `explorer.preview` slot (both declared by the patched ui-layout), plus a
 * `files` locale namespace. The inject factories return plain callbacks:
 * filesystem reads go through the generic connection RPC channel into the host
 * half, and `openPath` reuses the existing workspaces capability.
 */
import type { Context } from '@deepseek-ai/cordis'
import { FileExplorer } from './FileExplorer'
import { FilePreview } from './FilePreview'
import { NS, zh, en } from './locales'

const CHANNEL = '/dsh-plugin-files'

/** Required client services (sequencing only — data reads use global hooks). */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'connection']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'files-explorer: dictionaries')

  const listDir = (path: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'list', { path }, signal))
  const readFile = (path: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'read', { path }, signal))
  const writeFile = (path: string, content: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'write', { path, content }, signal))
  const watchFiles = (paths: string[]) => unwrap(ctx.connection.rpc.call(CHANNEL, 'watch', { paths }))
  const createFile = (path: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'createFile', { path }, signal))
  const createDir = (path: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'createDir', { path }, signal))
  const renameFile = (path: string, to: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'rename', { path, to }, signal))
  const removePath = (path: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'delete', { path }, signal))
  const copyPath = (from: string, to: string, overwrite: boolean, signal?: AbortSignal) =>
    unwrap(ctx.connection.rpc.call(CHANNEL, 'copy', { from, to, overwrite }, signal))
  const revealInExplorer = (path: string, kind: 'file' | 'dir', signal?: AbortSignal) =>
    unwrap(ctx.connection.rpc.call(CHANNEL, 'reveal', { path, kind }, signal))
  const openPath = (path: string) => ctx.workspaces.openPath(path)

  ctx.slots.inject('explorer', () => ctx.slots.register({
    name: 'explorer',
    locale: NS,
    inject: () => ({ listDir, openPath, revealInExplorer, createFile, createDir, renameFile, removePath, copyPath }),
  }, FileExplorer))

  ctx.slots.inject('explorer.preview', () => ctx.slots.register({
    name: 'explorer.preview',
    locale: NS,
    inject: () => ({ readFile, writeFile, watchFiles }),
  }, FilePreview))
}

interface RpcFailure {
  ok: false
  error: { code: string; message: string }
}

/** Error carrying the host's machine-readable `code` (always a core union code; copy collisions are reported in the value instead). */
export interface RpcError extends Error {
  code?: string
}

async function unwrap<T>(result: Promise<{ ok: true; value: T } | RpcFailure>): Promise<T> {
  const resolved = await result
  if (!resolved.ok) {
    const error = new Error(resolved.error.message) as RpcError
    error.code = resolved.error.code
    throw error
  }
  return resolved.value
}
