/**
 * File tree column, registered into the `explorer` slot declared by the
 * (patched) ui-layout AppFrame. File selection is pushed into the shared
 * selection store so the `explorer.preview` slot can render the split view.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import styles from './files.module.css'
import { FileIcon } from './fileIcons'
import type { FilesKey } from './locales'
import { expandPreview, openFile, setCwd, toggleTheme, useTabsState } from './store'

export interface FsListEntry {
  name: string
  path: string
  kind: 'dir' | 'file' | 'other'
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

interface SessionSummary {
  id: string
  cwd?: string
}

interface SessionListState {
  current?: string
  byId: Record<string, SessionSummary>
}

export interface FileExplorerProps {
  width: number
  useSessions: <T>(selector: (s: SessionListState) => T) => T
  t: (key: FilesKey, params?: Record<string, unknown>) => string
  listDir: (path: string, signal?: AbortSignal) => Promise<FsListResult>
  openPath: (path: string) => Promise<void>
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** How often the visible tree is re-listed to pick up disk changes. */
const REFRESH_MS = 2000

/** How many previously-expanded folders to re-list at once on workspace switch. */
const DIR_LOAD_BATCH = 4

/** Pause between batches when restoring expanded folders. */
const DIR_LOAD_GAP_MS = 50

const EMPTY_EXPANDED = new Set<string>()

/** True when two directory listings are identical (name/kind/size). */
function sameEntries(a: FsListEntry[], b: FsListEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].name !== b[i].name || a[i].kind !== b[i].kind || a[i].size !== b[i].size) return false
  }
  return true
}

interface TreeRowProps {
  entry: FsListEntry
  depth: number
  isActive: boolean
  isExpanded: boolean
  onToggleDir: (path: string) => void
  onRefreshDir: (path: string) => void
  onSelect: (entry: FsListEntry) => void
  onDoubleClick: (entry: FsListEntry) => void
  onOpenExternal: (path: string) => Promise<void>
  t: (key: FilesKey, params?: Record<string, unknown>) => string
}

/**
 * One tree row, memoized so opening/activating a file (which changes the
 * active-path highlight) re-renders only the affected row — with a workspace
 * full of files, re-rendering the whole tree on every click is what made
 * opening files feel laggy.
 */
const TreeRow = memo(function TreeRow({
  entry,
  depth,
  isActive,
  isExpanded,
  onToggleDir,
  onRefreshDir,
  onSelect,
  onDoubleClick,
  onOpenExternal,
  t,
}: TreeRowProps) {
  const isDir = entry.kind === 'dir'
  return (
    <div
      className={`${styles.row} ${isActive ? styles.rowSelected : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onDoubleClick(entry)}
      role="treeitem"
      aria-selected={isActive}
      aria-expanded={isDir ? isExpanded : undefined}
      title={entry.name}
    >
      <span
        className={styles.chevron}
        onClick={(e) => {
          e.stopPropagation()
          if (isDir) onToggleDir(entry.path)
        }}
      >
        {isDir ? (isExpanded ? '▾' : '▸') : ''}
      </span>
      <span className={styles.icon}>
        {isDir ? (isExpanded ? '📂' : '📁') : entry.kind === 'file' ? <FileIcon name={entry.name} /> : '·'}
      </span>
      <span className={styles.name}>{entry.name}</span>
      {entry.kind === 'file' && entry.size !== undefined && (
        <span className={styles.size}>{formatSize(entry.size)}</span>
      )}
      <span className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          title={t('action.open')}
          onClick={(e) => {
            e.stopPropagation()
            void onOpenExternal(entry.path)
          }}
        >
          ↗
        </button>
        {isDir && (
          <button
            type="button"
            className={styles.action}
            title={t('action.refresh')}
            onClick={(e) => {
              e.stopPropagation()
              onRefreshDir(entry.path)
            }}
          >
            ⟳
          </button>
        )}
      </span>
    </div>
  )
})

export function FileExplorer({ width, useSessions, t, listDir, openPath }: FileExplorerProps) {
  const sessionList = useSessions((s) => s)
  const currentId = sessionList.current
  const cwd = currentId !== undefined ? sessionList.byId[currentId]?.cwd : undefined
  const { active: activePath, theme } = useTabsState()

  const rootAbortRef = useRef<AbortController | null>(null)

  // Expanded directories are kept per workspace so each cwd restores its own.
  const cwdKey = cwd ?? ''
  const [expandedByCwd, setExpandedByCwd] = useState<Record<string, Set<string>>>({})
  const expanded = expandedByCwd[cwdKey] ?? EMPTY_EXPANDED

  const [root, setRoot] = useState<string | undefined>(undefined)
  const [rootLoading, setRootLoading] = useState(false)
  const [rootError, setRootError] = useState<string | undefined>(undefined)
  const [children, setChildren] = useState<Record<string, FsListEntry[]>>({})
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({})

  // Latest tree snapshot for the polling tick (avoids stale closures).
  const treeRef = useRef({ root, children, expanded, rootLoading })
  treeRef.current = { root, children, expanded, rootLoading }
  // Stable view of the loaded listings so toggleDir doesn't depend on the
  // children state (keeps memoized rows from re-rendering on listing updates).
  const childrenRef = useRef(children)
  childrenRef.current = children

  // Expose the explorer width so the maid-atelier fixed chrome (top/bottom
  // trim) can shift past this column instead of covering it.
  useEffect(() => {
    document.body.style.setProperty('--dsh-explorer-width', `${width}px`)
    return () => {
      document.body.style.removeProperty('--dsh-explorer-width')
    }
  }, [width])

  // Reset the whole tree whenever the current session's cwd changes. The tabs
  // and expanded directories live per-workspace in the store / expandedByCwd,
  // so switching back restores them.
  useEffect(() => {
    rootAbortRef.current?.abort()
    setRoot(undefined)
    setRootError(undefined)
    setChildren({})
    setLoadingDirs(new Set())
    setDirErrors({})
    setCwd(cwd)

    if (cwd === undefined) {
      setRootLoading(false)
      return
    }

    setRootLoading(true)
    const controller = new AbortController()
    rootAbortRef.current = controller
    listDir(cwd, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return
        setRoot(result.root)
        setChildren({ [result.root]: result.entries })
        setRootError(undefined)
        // Restore previously-expanded folders in small batches so a workspace
        // with many expanded folders doesn't flood the tree (and the page)
        // all at once; the auto-refresh tick fills any remainder shortly after.
        const dirs = [...expanded].filter((dirPath) => dirPath !== result.root)
        for (let i = 0; i < dirs.length; i += DIR_LOAD_BATCH) {
          if (controller.signal.aborted) return
          const batch = dirs.slice(i, i + DIR_LOAD_BATCH)
          await Promise.all(batch.map((dirPath) => loadDir(dirPath)))
          if (i + DIR_LOAD_BATCH < dirs.length) {
            await new Promise((resolve) => setTimeout(resolve, DIR_LOAD_GAP_MS))
          }
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        setRootError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setRootLoading(false)
      })
    return () => controller.abort()
  }, [cwd, listDir])

  // Auto-refresh the visible tree (root + expanded directories) on a timer so
  // disk changes appear without a manual refresh.
  const refreshVisible = useCallback(async (signal: AbortSignal) => {
    const snapshot = treeRef.current
    if (cwd === undefined || snapshot.rootLoading) return

    try {
      const result = await listDir(cwd, signal)
      if (signal.aborted) return
      const existing = snapshot.children[result.root]
      if (snapshot.root !== result.root || existing === undefined || !sameEntries(existing, result.entries)) {
        setRoot(result.root)
        setChildren((prev) => ({ ...prev, [result.root]: result.entries }))
        setRootError(undefined)
      }
    } catch (error) {
      if (signal.aborted) return
      setRootError(error instanceof Error ? error.message : String(error))
    }

    for (const dirPath of snapshot.expanded) {
      if (signal.aborted) return
      try {
        const result = await listDir(dirPath, signal)
        if (signal.aborted) return
        const existing = snapshot.children[dirPath]
        if (existing === undefined || !sameEntries(existing, result.entries)) {
          setChildren((prev) => ({ ...prev, [dirPath]: result.entries }))
          setDirErrors((prev) => {
            if (!(dirPath in prev)) return prev
            const next = { ...prev }
            delete next[dirPath]
            return next
          })
        }
      } catch (error) {
        if (signal.aborted) return
        setDirErrors((prev) => ({ ...prev, [dirPath]: error instanceof Error ? error.message : String(error) }))
      }
    }
  }, [cwd, listDir])

  useEffect(() => {
    if (cwd === undefined) return undefined
    const controller = new AbortController()
    let inFlight = false
    const timer = setInterval(() => {
      if (inFlight) return
      inFlight = true
      void refreshVisible(controller.signal).finally(() => {
        inFlight = false
      })
    }, REFRESH_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [cwd, refreshVisible])

  const loadDir = useCallback(async (dirPath: string) => {
    setLoadingDirs((prev) => new Set(prev).add(dirPath))
    const controller = new AbortController()
    try {
      const result = await listDir(dirPath, controller.signal)
      setChildren((prev) => ({ ...prev, [dirPath]: result.entries }))
      setDirErrors((prev) => {
        if (!(dirPath in prev)) return prev
        const next = { ...prev }
        delete next[dirPath]
        return next
      })
    } catch (error) {
      setDirErrors((prev) => ({ ...prev, [dirPath]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(dirPath)
        return next
      })
    }
  }, [listDir])

  const toggleDir = useCallback((dirPath: string) => {
    setExpandedByCwd((prev) => {
      const base = prev[cwdKey] ?? EMPTY_EXPANDED
      const next = new Set(base)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return { ...prev, [cwdKey]: next }
    })
    if (!childrenRef.current[dirPath]) void loadDir(dirPath)
  }, [cwdKey, loadDir])

  const refreshDir = useCallback((dirPath: string) => {
    setChildren((prev) => {
      const next = { ...prev }
      delete next[dirPath]
      return next
    })
    void loadDir(dirPath)
  }, [loadDir])

  const onRowClick = useCallback((entry: FsListEntry) => {
    if (entry.kind === 'dir') {
      toggleDir(entry.path)
      return
    }
    openFile(entry.path)
  }, [toggleDir])

  const onRowDoubleClick = useCallback((entry: FsListEntry) => {
    if (entry.kind !== 'file') return
    void openPath(entry.path)
  }, [openPath])

  // ---- placeholder: no session / no cwd ----
  if (cwd === undefined) {
    return (
      <div className={styles.column} style={{ width: width > 0 ? width : undefined }} data-pane="explorer" data-fe-theme={theme}>
        <div className={styles.placeholder}>
          {currentId === undefined ? t('placeholder.noSession') : t('placeholder.noCwd')}
        </div>
      </div>
    )
  }

  const renderEntries = (entries: FsListEntry[], depth: number) => entries.map((entry) => {
    const isDir = entry.kind === 'dir'
    const isExpanded = isDir && expanded.has(entry.path)
    const isLoading = isDir && loadingDirs.has(entry.path)
    const childEntries = isDir && isExpanded ? children[entry.path] : undefined
    const error = isDir ? dirErrors[entry.path] : undefined

    return (
      <div key={entry.path}>
        <TreeRow
          entry={entry}
          depth={depth}
          isActive={entry.kind === 'file' && activePath === entry.path}
          isExpanded={isExpanded}
          onToggleDir={toggleDir}
          onRefreshDir={refreshDir}
          onSelect={onRowClick}
          onDoubleClick={onRowDoubleClick}
          onOpenExternal={openPath}
          t={t}
        />
        {isDir && isExpanded && (
          <div>
            {isLoading && <div className={styles.rowHint} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>{t('preview.loading')}</div>}
            {error !== undefined && !isLoading && <div className={styles.rowError} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>{error}</div>}
            {childEntries !== undefined && childEntries.length === 0 && !isLoading && (
              <div className={styles.rowHint} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>{t('preview.emptyDir')}</div>
            )}
            {childEntries !== undefined && renderEntries(childEntries, depth + 1)}
          </div>
        )}
      </div>
    )
  })

  return (
    <div className={styles.column} style={{ width: width > 0 ? width : undefined }} data-pane="explorer" data-fe-theme={theme}>
      <div className={styles.header}>
        <span className={styles.headerTitle} title={root ?? cwd}>{basenameOf(root ?? cwd)}</span>
        <span className={styles.headerActions}>
          <button type="button" className={styles.action} title={t('action.theme')} onClick={toggleTheme}>
            {theme === 'dark' ? '☀' : '🌙'}
          </button>
          <button type="button" className={styles.action} title={t('action.open')} onClick={() => void openPath(cwd)}>↗</button>
          <button type="button" className={styles.action} title={t('tab.expand')} onClick={expandPreview}>{'>'}</button>
        </span>
      </div>
      <div className={styles.treeArea}>
        {rootLoading && <div className={styles.rowHint}>{t('preview.loading')}</div>}
        {rootError !== undefined && <div className={styles.rowError}>{rootError}</div>}
        {!rootLoading && rootError === undefined && root !== undefined && children[root] !== undefined && children[root].length === 0 && (
          <div className={styles.rowHint}>{t('preview.emptyDir')}</div>
        )}
        {root !== undefined && children[root] !== undefined && renderEntries(children[root], 0)}
      </div>
    </div>
  )
}
