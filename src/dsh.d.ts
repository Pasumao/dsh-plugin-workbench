/**
 * Local minimal type declarations for the members of the dsh runtime this
 * plugin touches. tsdown does NOT type-check, so these are DX-only aids: the
 * running service is the authority. Augmenting `@deepseek-ai/cordis`'s Context
 * keeps the host/client sources free of the runtime's whole `.ts`-suffixed
 * d.ts chain.
 */

declare module '@deepseek-ai/cordis' {
  interface RpcOkShape {
    ok: true
    value: unknown
  }
  interface RpcErrShape {
    ok: false
    error: {
      code: string
      message: string
      details: Record<string, unknown>
    }
  }
  type RpcShape = RpcOkShape | RpcErrShape
  type RpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcShape>

  interface Context {
    connection: {
      rpc: {
        /** Browser-side unary call over a registered logical channel. */
        call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcShape>
        /** Host-side channel registration; returns an async disposer. */
        handle(channel: string, handler: RpcHandler, options: { authority: 'loopback' | 'trusted-host' }): () => Promise<void>
      }
    }
    slots: {
      register(options: {
        name?: string
        locale?: string
        children?: Record<string, unknown>
        store?: unknown
        inject?: (...args: unknown[]) => Record<string, unknown>
        [key: string]: unknown
      }, component: unknown): () => void
      inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
    }
    locale: {
      register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    }
    workspaces: {
      openPath(path: string): Promise<void>
    }
    fs: {
      resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ targetKey: unknown; displayPath: string }>
      stat(target: unknown, signal?: AbortSignal): Promise<{ version: unknown; type: 'file' | 'directory' | 'other'; size?: number } | undefined>
      listDir(target: unknown, signal?: AbortSignal): Promise<Array<{ name: string; type: 'file' | 'directory' | 'other'; target: unknown; version?: unknown; size?: number }>>
      readText(target: unknown, signal?: AbortSignal): Promise<string>
      processPath(target: unknown): string
    }
  }
}
