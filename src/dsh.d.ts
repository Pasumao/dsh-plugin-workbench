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
    /** Register a lifecycle effect; the callback may return a disposer. */
    effect(callback: () => void | (() => void), name?: string): void
    /** Subscribe to an event; returns the disposer. */
    on(event: string, listener: (...args: unknown[]) => void): () => void
    /** Resolve scoped services and run a callback in that scope. */
    inject(deps: string[], callback: (scope: Context) => void): { dispose(): unknown }
    /** Agent registry (host side; used to teach each agent the mention grammar). */
    agents: {
      list(): Array<{ ctx: Context }>
    }
    systemPrompt: {
      /** Register one ordered system-prompt section; returns the disposer. */
      section(section: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void
    }
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
      readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
      writeText(target: unknown, content: string, version?: unknown, signal?: AbortSignal, options?: { mode?: string; workspaceRoot?: string }): Promise<void>
      processPath(target: unknown): string
    }
    webServer: {
      /** Register a named HTTP route (exact path or prefix). Returns the disposer. */
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
      }): () => void
    }
  }
}
