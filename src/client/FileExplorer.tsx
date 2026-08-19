/**
 * File tree column, registered into the `explorer` slot declared by the
 * (patched) ui-layout AppFrame. File selection is pushed into the shared
 * selection store so the `explorer.preview` slot can render the split view.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import styles from './files.module.css'
import { FileIcon } from './fileIcons'
import type { FilesKey } from './locales'
import { closeFilesUnder, expandPreview, openFile, retargetFile, setCwd, toggleTheme, useTabsState } from './store'

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

/** Result of a context-menu mutation (create/rename/delete). */
export interface FsMutationResult {
  path: string
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
  createFile: (path: string, signal?: AbortSignal) => Promise<FsMutationResult>
  createDir: (path: string, signal?: AbortSignal) => Promise<FsMutationResult>
  renameFile: (path: string, to: string, signal?: AbortSignal) => Promise<FsMutationResult>
  removePath: (path: string, signal?: AbortSignal) => Promise<FsMutationResult>
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Parent directory of a path ('' for a bare drive root — never used for such). */
function parentOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx > 0 ? path.slice(0, idx) : path
}

/** Append a child name to a directory path, honoring its separator style. */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + sep + name
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
  onContextMenu: (e: ReactMouseEvent, entry: FsListEntry) => void
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
  onContextMenu,
  t,
}: TreeRowProps) {
  const isDir = entry.kind === 'dir'
  return (
    <div
      className={`${styles.row} ${isActive ? styles.rowSelected : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
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

export function FileExplorer({
  width,
  useSessions,
  t,
  listDir,
  openPath,
  createFile,
  createDir,
  renameFile,
  removePath,
}: FileExplorerProps) {
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

  // ---- context menu ----
  interface MenuState {
    kind: 'file' | 'dir' | 'root'
    path: string
    x: number
    y: number
  }
  const [menu, setMenu] = useState<MenuState | undefined>(undefined)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)

  // Measure and clamp the menu into the viewport before the browser paints
  // (layout effects run pre-paint, so the raw position never shows).
  useLayoutEffect(() => {
    if (menu === undefined) {
      setMenuPos(undefined)
      return
    }
    const el = menuRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    setMenuPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4)),
    })
  }, [menu])

  // Close the menu on outside click / Escape / window blur.
  useEffect(() => {
    if (menu === undefined) return undefined
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(undefined)
    }
    const onMouseDown = (e: MouseEvent) => {
      const el = menuRef.current
      if (el !== null && e.target instanceof Node && el.contains(e.target)) return
      setMenu(undefined)
    }
    const onBlur = () => setMenu(undefined)
    document.addEventListener('keydown', onKeyDown)
    // mousedown (not click): closing before a menu item's click still lets the
    // click dispatch on the item, and closes when clicking anywhere else.
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [menu])

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

  // ---- context-menu actions ----

  const openContextMenu = useCallback((e: ReactMouseEvent, entry: FsListEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ kind: entry.kind === 'dir' ? 'dir' : 'file', path: entry.path, x: e.clientX, y: e.clientY })
  }, [])

  const runAction = useCallback((action: () => void) => {
    setMenu(undefined)
    action()
  }, [])

  // One mutation pipeline shared by New File / New Folder / Rename / Delete:
  // run the op, refresh the touched directory, and surface failures inline in
  // the tree (under the directory row, or at the column top for the root).
  const applyMutation = useCallback(async (op: () => Promise<unknown>, refreshPath: string) => {
    try {
      await op()
      refreshDir(refreshPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (refreshPath === root) setRootError(message)
      else setDirErrors((prev) => ({ ...prev, [refreshPath]: message }))
    }
  }, [refreshDir, root])

  const onNewFile = useCallback((dirPath: string) => {
    const name = window.prompt(`${t('prompt.newFileName')}:`, '')
    if (name === null) return
    const trimmed = name.trim()
    if (trimmed === '') return
    void applyMutation(() => createFile(joinPath(dirPath, trimmed)), dirPath)
  }, [applyMutation, createFile, t])

  const onNewFolder = useCallback((dirPath: string) => {
    const name = window.prompt(`${t('prompt.newFolderName')}:`, '')
    if (name === null) return
    const trimmed = name.trim()
    if (trimmed === '') return
    void applyMutation(() => createDir(joinPath(dirPath, trimmed)), dirPath)
  }, [applyMutation, createDir, t])

  const onRename = useCallback((path: string) => {
    const current = basenameOf(path)
    const name = window.prompt(`${t('prompt.renameTo')}:`, current)
    if (name === null) return
    const trimmed = name.trim()
    if (trimmed === '' || trimmed === current) return
    const parent = parentOf(path)
    const to = joinPath(parent, trimmed)
    void applyMutation(async () => {
      await renameFile(path, to)
      // Keep any open tab pointing at the moved file.
      retargetFile(path, to)
    }, parent)
  }, [applyMutation, renameFile, t])

  const onDelete = useCallback((path: string, kind: 'file' | 'dir') => {
    const name = basenameOf(path)
    const message = kind === 'dir' ? t('confirm.deleteDir', { name }) : t('confirm.deleteFile', { name })
    if (!window.confirm(message)) return
    void applyMutation(async () => {
      await removePath(path)
      // Drop tabs for the deleted file (or everything under a deleted folder).
      closeFilesUnder(path)
    }, parentOf(path))
  }, [applyMutation, removePath, t])

  const onCopyPath = useCallback((path: string) => {
    void navigator.clipboard.writeText(path).catch(() => {
      // clipboard unavailable (permissions) — nothing else to do
    })
  }, [])

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
          onContextMenu={openContextMenu}
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

  const menuItems = (m: MenuState): Array<{ label: string; danger?: boolean; onClick: () => void } | 'divider'> => {
    if (m.kind === 'file') {
      return [
        { label: t('menu.open'), onClick: () => openFile(m.path) },
        'divider',
        { label: t('menu.copyPath'), onClick: () => onCopyPath(m.path) },
        { label: t('menu.openSystem'), onClick: () => void openPath(m.path) },
        'divider',
        { label: t('menu.rename'), onClick: () => onRename(m.path) },
        { label: t('menu.delete'), danger: true, onClick: () => onDelete(m.path, 'file') },
      ]
    }
    if (m.kind === 'dir') {
      return [
        { label: t('menu.newFile'), onClick: () => onNewFile(m.path) },
        { label: t('menu.newFolder'), onClick: () => onNewFolder(m.path) },
        'divider',
        { label: t('menu.copyPath'), onClick: () => onCopyPath(m.path) },
        { label: t('menu.openSystem'), onClick: () => void openPath(m.path) },
        { label: t('menu.refresh'), onClick: () => refreshDir(m.path) },
        'divider',
        { label: t('menu.rename'), onClick: () => onRename(m.path) },
        { label: t('menu.delete'), danger: true, onClick: () => onDelete(m.path, 'dir') },
      ]
    }
    // Empty tree area (the workspace root).
    return [
      { label: t('menu.newFile'), onClick: () => onNewFile(m.path) },
      { label: t('menu.newFolder'), onClick: () => onNewFolder(m.path) },
      'divider',
      { label: t('menu.copyPath'), onClick: () => onCopyPath(m.path) },
      { label: t('menu.refresh'), onClick: () => refreshDir(m.path) },
    ]
  }

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
      <div
        className={styles.treeArea}
        onContextMenu={(e) => {
          e.preventDefault()
          const target = root ?? cwd
          if (target === undefined) return
          setMenu({ kind: 'root', path: target, x: e.clientX, y: e.clientY })
        }}
      >
        {rootLoading && <div className={styles.rowHint}>{t('preview.loading')}</div>}
        {rootError !== undefined && <div className={styles.rowError}>{rootError}</div>}
        {!rootLoading && rootError === undefined && root !== undefined && children[root] !== undefined && children[root].length === 0 && (
          <div className={styles.rowHint}>{t('preview.emptyDir')}</div>
        )}
        {root !== undefined && children[root] !== undefined && renderEntries(children[root], 0)}
      </div>
      {menu !== undefined && (
        <div
          ref={menuRef}
          className={styles.contextMenu}
          role="menu"
          style={menuPos !== undefined ? { left: menuPos.x, top: menuPos.y } : { left: menu.x, top: menu.y, visibility: 'hidden' }}
        >
          {menuItems(menu).map((item, index) =>
            item === 'divider' ? (
              <div key={index} className={styles.contextMenuDivider} />
            ) : (
              <div
                key={index}
                role="menuitem"
                className={`${styles.contextMenuItem}${item.danger ? ` ${styles.contextMenuItemDanger}` : ''}`}
                onClick={() => runAction(item.onClick)}
              >
                {item.label}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}
