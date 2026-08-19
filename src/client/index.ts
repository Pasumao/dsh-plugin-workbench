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
  const createFile = (path: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'createFile', { path }, signal))
  const createDir = (path: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'createDir', { path }, signal))
  const renameFile = (path: string, to: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'rename', { path, to }, signal))
  const removePath = (path: string, signal?: AbortSignal) => unwrap(ctx.connection.rpc.call(CHANNEL, 'delete', { path }, signal))
  const openPath = (path: string) => ctx.workspaces.openPath(path)

  ctx.slots.inject('explorer', () => ctx.slots.register({
    name: 'explorer',
    locale: NS,
    inject: () => ({ listDir, openPath, createFile, createDir, renameFile, removePath }),
  }, FileExplorer))

  ctx.slots.inject('explorer.preview', () => ctx.slots.register({
    name: 'explorer.preview',
    locale: NS,
    inject: () => ({ readFile, writeFile }),
  }, FilePreview))
}

async function unwrap<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T> {
  const resolved = await result
  if (!resolved.ok) throw new Error(resolved.error.message)
  return resolved.value
}
