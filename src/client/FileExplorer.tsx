/**
 * File tree column, registered into the `explorer` slot declared by the
 * (patched) ui-layout AppFrame. File selection is pushed into the shared
 * selection store so the `explorer.preview` slot can render the split view.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import styles from './files.module.css'
import { FileIcon } from './fileIcons'
import type { FilesKey } from './locales'
import { cancelCut, clearClipboard, closeFilesUnder, copyToClipboard, expandPreview, openFile, popUndo, pushUndo, retargetFile, setCwd, toggleTheme, useClipboard, useTabsState } from './store'
import type { ClipboardItem, ClipboardMode, UndoEntry } from './store'
import { DRAG_TYPE, insertIntoComposer, relPathOf } from './composer'

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
  /** Copy-only: `true` when the destination existed and the copy was skipped (client may ask about overwrite). */
  exists?: boolean
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
  revealInExplorer: (path: string, kind: 'file' | 'dir', signal?: AbortSignal) => Promise<FsMutationResult>
  createFile: (path: string, signal?: AbortSignal) => Promise<FsMutationResult>
  createDir: (path: string, signal?: AbortSignal) => Promise<FsMutationResult>
  renameFile: (path: string, to: string, signal?: AbortSignal) => Promise<FsMutationResult>
  removePath: (path: string, signal?: AbortSignal) => Promise<FsMutationResult>
  copyPath: (from: string, to: string, overwrite: boolean, signal?: AbortSignal) => Promise<FsMutationResult>
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

/** "a.txt" → "a - Copy.txt", "folder" → "folder - Copy" (OS explorer duplicate naming). */
function copyName(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx <= 0) return `${name} - Copy`
  return `${name.slice(0, idx)} - Copy${name.slice(idx)}`
}

/**
 * Hidden folder next to a deleted item that holds it until undo restores it
 * (delete = rename into here, undo = rename back — no bytes are copied).
 */
const TRASH_NAME = '.dsh-trash'

/** Number of separators in a path — used to delete children before parents. */
function sepCount(path: string): number {
  let n = 0
  for (let i = 0; i < path.length; i += 1) {
    if (path[i] === '/' || path[i] === '\\') n += 1
  }
  return n
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
  isSelected: boolean
  isCut: boolean
  isExpanded: boolean
  isDropTarget: boolean
  onToggleDir: (path: string) => void
  onRefreshDir: (path: string) => void
  onSelect: (entry: FsListEntry, e: ReactMouseEvent) => void
  onDoubleClick: (entry: FsListEntry) => void
  onOpenExternal: (path: string) => Promise<void>
  onContextMenu: (e: ReactMouseEvent, entry: FsListEntry) => void
  onDragStart: (e: ReactDragEvent, entry: FsListEntry) => void
  onDragEnd: () => void
  onDragOverRow: (e: ReactDragEvent, entry: FsListEntry) => void
  onDragLeaveRow: () => void
  onDropRow: (e: ReactDragEvent, entry: FsListEntry) => void
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
  isSelected,
  isCut,
  isExpanded,
  isDropTarget,
  onToggleDir,
  onRefreshDir,
  onSelect,
  onDoubleClick,
  onOpenExternal,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDragLeaveRow,
  onDropRow,
  t,
}: TreeRowProps) {
  const isDir = entry.kind === 'dir'
  return (
    <div
      className={`${styles.row} ${isSelected || isActive ? styles.rowSelected : ''}${isCut ? ` ${styles.rowCut}` : ''}${isDropTarget ? ` ${styles.rowDropTarget}` : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      draggable
      onClick={(e) => onSelect(entry, e)}
      onDoubleClick={() => onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      onDragStart={(e) => onDragStart(e, entry)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOverRow(e, entry)}
      onDragLeave={onDragLeaveRow}
      onDrop={(e) => onDropRow(e, entry)}
      role="treeitem"
      aria-selected={isSelected || isActive}
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
  revealInExplorer,
  createFile,
  createDir,
  renameFile,
  removePath,
  copyPath,
}: FileExplorerProps) {
  const sessionList = useSessions((s) => s)
  const currentId = sessionList.current
  const cwd = currentId !== undefined ? sessionList.byId[currentId]?.cwd : undefined
  const { active: activePath, theme, undo: undoEntries } = useTabsState()

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

  // Explorer-like selection (path → kind). A plain click replaces it,
  // Ctrl/Cmd+click toggles membership; copy/cut/paste act on it.
  const [selected, setSelected] = useState<Record<string, FsListEntry['kind']>>({})
  const clipboard = useClipboard()
  const treeAreaRef = useRef<HTMLDivElement>(null)

  // ---- drag & drop (move into a folder) ----
  const dragPathsRef = useRef<string[] | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // ---- context menu (rows, blank tree space, header and clipboard bar —
  //      the whole column carries a menu; right-clicking a row keeps its own) ----
  interface MenuState {
    kind: 'file' | 'dir' | 'blank'
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

  // Explorer semantics: clicking (or right-clicking) ANYWHERE outside the
  // tree — the chat, the header, other columns — clears the selection. Clicks
  // on the tree rows and inside the open menu keep it (the menu's batch
  // actions operate on the selection).
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return
      const tree = treeAreaRef.current
      if (tree !== null && tree.contains(target)) return
      const m = menuRef.current
      if (m !== null && m.contains(target)) return
      setSelected({})
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

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
    setSelected({})
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
    // Explorer behavior: right-clicking an unselected item selects it; a
    // right-click on an already-selected item keeps the multi-selection.
    setSelected((prev) => (prev[entry.path] !== undefined ? prev : { [entry.path]: entry.kind }))
    setMenu({ kind: entry.kind === 'dir' ? 'dir' : 'file', path: entry.path, x: e.clientX, y: e.clientY })
  }, [])

  /** Right-click anywhere else in the column (header, clipboard bar, blank tree space): folder menu for the cwd. */
  const onColumnContextMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    // Right-clicking the open menu itself keeps it (no browser menu either).
    const el = menuRef.current
    if (el !== null && e.target instanceof Node && el.contains(e.target)) return
    if (cwd === undefined) return
    setMenu({ kind: 'blank', path: cwd, x: e.clientX, y: e.clientY })
  }, [cwd])

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

  /**
   * Record one undoable operation for the current workspace. When the stack
   * overflows, the oldest entry comes back evicted — if it was a delete, its
   * trash item can never be restored from here again, so purge it (best
   * effort; it may already be gone).
   */
  const recordUndo = useCallback((entry: UndoEntry) => {
    const evicted = pushUndo(entry)
    if (evicted !== undefined && evicted.kind === 'delete') {
      void removePath(evicted.trash).catch(() => {
        // already gone — nothing to purge
      })
    }
  }, [removePath])

  /**
   * Reversible delete: rename the item into a hidden `.dsh-trash` folder next
   * to it (instant — no bytes copied). Undo renames it back. The trash folder
   * is created on demand and hidden from the tree.
   */
  const trashPath = useCallback(async (path: string): Promise<{ trash: string; parent: string }> => {
    const parent = parentOf(path)
    const trashDir = joinPath(parent, TRASH_NAME)
    // Best-effort: the folder already exists after the first delete.
    try {
      await createDir(trashDir)
    } catch {
      // exists — fine
    }
    // Practically collision-free unique name; rename refuses if it ever collides.
    const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const trash = joinPath(trashDir, `${unique}-${basenameOf(path)}`)
    await renameFile(path, trash)
    return { trash, parent }
  }, [createDir, renameFile])

  /**
   * Apply clipboard/drag items into a target directory. `cut` moves (copy +
   * remove source), `copy` duplicates. Every successful item records an undo
   * entry — copy → remove the copy, move → rename it back. Overwriting copies
   * are NOT recorded (the pre-existing content is gone for good). Moving an
   * item into the folder it already lives in is a no-op; copying into the same
   * folder duplicates it with a " - Copy" suffix, like the OS explorer.
   */
  const applyItems = useCallback(async (items: ClipboardItem[], targetDir: string, mode: ClipboardMode) => {
    const failures: string[] = []
    const refreshed = new Set<string>()
    for (const item of items) {
      let dest = joinPath(targetDir, item.name)
      const sameDest = dest.toLowerCase() === item.path.toLowerCase()
      if (mode === 'cut' && sameDest) continue
      if (sameDest) dest = joinPath(targetDir, copyName(item.name))
      let overwritten = false
      try {
        const copied = await copyPath(item.path, dest, false)
        if (copied.exists === true) {
          // Collision: ask before overwriting, like the OS file manager.
          if (!window.confirm(t('confirm.overwrite', { name: item.name }))) continue
          overwritten = true
          await copyPath(item.path, dest, true)
        }
        if (mode === 'cut') {
          await removePath(item.path)
          // Keep any open tab pointed at the moved file.
          retargetFile(item.path, dest)
          refreshed.add(parentOf(item.path))
          recordUndo({ kind: 'move', label: t('undo.move', { name: item.name }), from: item.path, to: dest, parent: targetDir })
        } else if (!overwritten) {
          recordUndo({ kind: 'copy', label: t('undo.copy', { name: item.name }), from: item.path, to: dest, parent: targetDir })
        }
        refreshed.add(targetDir)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    for (const p of refreshed) refreshDir(p)
    return failures
  }, [copyPath, recordUndo, refreshDir, removePath, retargetFile, t])

  /** Undo the current workspace's most recent operation (Ctrl+Z / header button). */
  const performUndo = useCallback(async () => {
    const entry = popUndo()
    if (entry === undefined) return
    const refreshed = new Set<string>()
    try {
      switch (entry.kind) {
        case 'copy':
          await removePath(entry.to)
          closeFilesUnder(entry.to)
          refreshed.add(entry.parent)
          break
        case 'move':
          // Rename back: the destination currently holds the moved item.
          await renameFile(entry.to, entry.from)
          retargetFile(entry.to, entry.from)
          refreshed.add(entry.parent)
          refreshed.add(parentOf(entry.from))
          break
        case 'rename':
          await renameFile(entry.to, entry.from)
          retargetFile(entry.to, entry.from)
          refreshed.add(entry.parent)
          break
        case 'create':
          await trashPath(entry.path)
          closeFilesUnder(entry.path)
          refreshed.add(entry.parent)
          break
        case 'delete':
          await renameFile(entry.trash, entry.path)
          refreshed.add(entry.parent)
          break
      }
    } catch (error) {
      // Put the entry back so the user can retry after fixing the cause, and
      // surface the reason inline — EXCEPT a delete whose trash item no longer
      // exists (purged by an overflow, or the .dsh-trash folder removed on
      // disk): nothing left to restore, so drop it instead of a stuck retry.
      const message = error instanceof Error ? error.message : String(error)
      const gone = message.includes('does not exist') || message.includes('not found')
      if (!(entry.kind === 'delete' && gone)) recordUndo(entry)
      if (entry.parent === root) setRootError(message)
      else setDirErrors((prev) => ({ ...prev, [entry.parent]: message }))
      return
    }
    for (const p of refreshed) refreshDir(p)
  }, [closeFilesUnder, popUndo, recordUndo, refreshDir, removePath, renameFile, retargetFile, root, trashPath])

  /** Delete every selected item (moves each into .dsh-trash; all undoable). */
  const deleteSelection = useCallback(async () => {
    const entries = Object.entries(selected).map(([path, kind]) => ({ path, kind }))
    if (entries.length === 0) return
    // Children first so deleting a folder alongside its contents doesn't hit
    // already-gone paths; anything under an already-trashed folder is skipped.
    entries.sort((a, b) => sepCount(b.path) - sepCount(a.path))
    const confirmMessage = entries.length === 1
      ? (entries[0].kind === 'dir'
          ? t('confirm.deleteDir', { name: basenameOf(entries[0].path) })
          : t('confirm.deleteFile', { name: basenameOf(entries[0].path) }))
      : t('confirm.deleteSelected', {
          count: entries.length,
          names: entries.slice(0, 3).map((e) => basenameOf(e.path)).join('、'),
        })
    if (!window.confirm(confirmMessage)) return
    const failures: string[] = []
    const refreshed = new Set<string>()
    const trashedPrefixes: string[] = []
    for (const { path, kind } of entries) {
      const sep = path.includes('\\') ? '\\' : '/'
      const prefix = path.endsWith('\\') || path.endsWith('/') ? path : path + sep
      if (trashedPrefixes.some((d) => path.toLowerCase().startsWith(d.toLowerCase()))) continue
      try {
        const { trash, parent } = await trashPath(path)
        if (kind === 'dir') trashedPrefixes.push(prefix)
        closeFilesUnder(path)
        recordUndo({ kind: 'delete', label: t('undo.delete', { name: basenameOf(path) }), path, trash, parent })
        refreshed.add(parent)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    for (const p of refreshed) refreshDir(p)
    setSelected({})
    if (failures.length > 0) setRootError(failures.join('; '))
  }, [closeFilesUnder, recordUndo, refreshDir, root, selected, t, trashPath])

  const onNewFile = useCallback((dirPath: string) => {
    const name = window.prompt(`${t('prompt.newFileName')}:`, '')
    if (name === null) return
    const trimmed = name.trim()
    if (trimmed === '') return
    const path = joinPath(dirPath, trimmed)
    void applyMutation(async () => {
      await createFile(path)
      recordUndo({ kind: 'create', label: t('undo.create', { name: trimmed }), path, parent: dirPath })
    }, dirPath)
  }, [applyMutation, createFile, recordUndo, t])

  const onNewFolder = useCallback((dirPath: string) => {
    const name = window.prompt(`${t('prompt.newFolderName')}:`, '')
    if (name === null) return
    const trimmed = name.trim()
    if (trimmed === '') return
    const path = joinPath(dirPath, trimmed)
    void applyMutation(async () => {
      await createDir(path)
      recordUndo({ kind: 'create', label: t('undo.create', { name: trimmed }), path, parent: dirPath })
    }, dirPath)
  }, [applyMutation, createDir, recordUndo, t])

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
      recordUndo({ kind: 'rename', label: t('undo.rename', { name: current }), from: path, to, parent })
    }, parent)
  }, [applyMutation, recordUndo, renameFile, retargetFile, t])

  const onDelete = useCallback((path: string, kind: 'file' | 'dir') => {
    const name = basenameOf(path)
    const message = kind === 'dir' ? t('confirm.deleteDir', { name }) : t('confirm.deleteFile', { name })
    if (!window.confirm(message)) return
    void (async () => {
      try {
        const { trash, parent } = await trashPath(path)
        // Drop tabs for the deleted file (or everything under a deleted folder).
        closeFilesUnder(path)
        recordUndo({ kind: 'delete', label: t('undo.delete', { name }), path, trash, parent })
        refreshDir(parent)
      } catch (error) {
        setRootError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [closeFilesUnder, recordUndo, refreshDir, t, trashPath])

  const onCopyPath = useCallback((path: string) => {
    void navigator.clipboard.writeText(path).catch(() => {
      // clipboard unavailable (permissions) — nothing else to do
    })
  }, [])

  /** Reveal in the OS file manager; failures surface as an alert, never silently. */
  const onReveal = useCallback((path: string, kind: 'file' | 'dir') => {
    void revealInExplorer(path, kind).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`${t('error.reveal')}：${message}`)
    })
  }, [revealInExplorer, t])

  const selectedItems = useCallback((): ClipboardItem[] => (
    Object.entries(selected).map(([path, kind]) => ({ path, name: basenameOf(path), kind }))
  ), [selected])

  const onCopySelection = useCallback((mode: ClipboardMode) => {
    const items = selectedItems()
    if (items.length === 0) return
    copyToClipboard(items, mode)
  }, [selectedItems])

  /** Paste the clipboard into the current folder (or the one selected dir). */
  const onPaste = useCallback(async () => {
    const { items, mode } = clipboard
    if (items.length === 0 || cwd === undefined) return
    const selEntries = Object.entries(selected)
    const target = selEntries.length === 1 && selEntries[0][1] === 'dir' ? selEntries[0][0] : cwd
    const failures = await applyItems(items, target, mode)
    // Explorer semantics: a cut clears the clipboard once the move lands; a
    // plain copy stays armed so the user can paste into more folders.
    if (mode === 'cut') clearClipboard()
    setSelected({})
    if (failures.length > 0) {
      const message = failures.join('; ')
      if (target === root) setRootError(message)
      else setDirErrors((prev) => ({ ...prev, [target]: message }))
    }
  }, [applyItems, clipboard, clearClipboard, cwd, root, selected])

  // ---- drag & drop (drag selected items onto a folder to move them) ----

  const onRowDragStart = useCallback((e: ReactDragEvent, entry: FsListEntry) => {
    // Dragging one member of a multi-selection moves the whole selection,
    // exactly like the OS explorer.
    const paths = selected[entry.path] !== undefined ? Object.keys(selected) : [entry.path]
    dragPathsRef.current = paths
    try {
      // text/plain: natural browser fallback (a native textarea drop inserts
      // the paths); the custom type carries the machine-readable list for the
      // workbench's own chat-drop integration (composer.ts).
      e.dataTransfer.setData('text/plain', paths.join('\n'))
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths))
    } catch {
      // dataTransfer may be unavailable — the ref still carries the paths
    }
    // copyMove: dropping on a folder row moves (tree), dropping on the chat
    // copies the path text in.
    e.dataTransfer.effectAllowed = 'copyMove'
  }, [selected])

  const onRowDragEnd = useCallback(() => {
    dragPathsRef.current = null
    setDropTarget(null)
  }, [])

  const onRowDragOver = useCallback((e: ReactDragEvent, entry: FsListEntry) => {
    if (dragPathsRef.current === null) return
    e.stopPropagation()
    if (entry.kind !== 'dir') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(entry.path)
  }, [])

  const onRowDragLeave = useCallback(() => setDropTarget(null), [])

  /** Move the dragged paths into `targetDir` (a folder row or the tree area). */
  const onDropMove = useCallback((e: ReactDragEvent, targetDir: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const paths = dragPathsRef.current
    dragPathsRef.current = null
    if (paths === null || paths.length === 0) return
    // Dropping a folder onto itself or into its own subtree is a no-op.
    const items: ClipboardItem[] = paths.filter((path) => {
      if (path.toLowerCase() === targetDir.toLowerCase()) return false
      const sep = path.includes('\\') ? '\\' : '/'
      const prefix = path.endsWith('\\') || path.endsWith('/') ? path : path + sep
      return !targetDir.toLowerCase().startsWith(prefix.toLowerCase())
    }).map((path) => ({
      path,
      name: basenameOf(path),
      kind: selected[path] ?? 'file',
    }))
    if (items.length === 0) return
    setSelected({})
    void applyItems(items, targetDir, 'cut').then((failures) => {
      if (failures.length > 0) {
        const message = failures.join('; ')
        if (targetDir === root) setRootError(message)
        else setDirErrors((prev) => ({ ...prev, [targetDir]: message }))
      }
    })
  }, [applyItems, root, selected])

  const onRowDrop = useCallback((e: ReactDragEvent, entry: FsListEntry) => {
    e.stopPropagation()
    if (dragPathsRef.current === null || entry.kind !== 'dir') return
    e.preventDefault()
    onDropMove(e, entry.path)
  }, [onDropMove])

  const onRowClick = useCallback((entry: FsListEntry, e: ReactMouseEvent) => {
    e.stopPropagation()
    // Rows push keyboard focus onto the tree so Ctrl+C / Ctrl+V / Esc land
    // here right after a click, instead of going to whatever had focus.
    treeAreaRef.current?.focus({ preventScroll: true })
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+click toggles membership without opening / expanding.
      setSelected((prev) => {
        const next = { ...prev }
        if (next[entry.path] !== undefined) delete next[entry.path]
        else next[entry.path] = entry.kind
        return next
      })
      return
    }
    setSelected({ [entry.path]: entry.kind })
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

  /** Explorer-style "Select All": every visible (non-trash) entry at any depth. */
  const selectAllEntries = useCallback(() => {
    const all: Record<string, FsListEntry['kind']> = {}
    const collect = (entries: FsListEntry[]) => {
      for (const entry of entries) {
        if (entry.name === TRASH_NAME) continue
        all[entry.path] = entry.kind
        if (entry.kind === 'dir' && expanded.has(entry.path) && children[entry.path] !== undefined) {
          collect(children[entry.path] as FsListEntry[])
        }
      }
    }
    const rootEntries = root !== undefined ? children[root] : undefined
    if (rootEntries !== undefined) collect(rootEntries)
    setSelected(all)
  }, [children, expanded, root])

  /** Insert `@<relative-workspace-path>` into the composer (Claude Code-style mention). */
  const onMention = useCallback((path: string) => {
    const mention = relPathOf(path, cwd)
    if (mention.length === 0) return
    insertIntoComposer(`@${mention} `)
  }, [cwd])

  // Explorer-style keyboard: Ctrl/Cmd+C/X copy-cut, Ctrl/Cmd+V paste,
  // Ctrl/Cmd+A select-all, Escape clears the selection (and cancels a cut).
  const onTreeKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    // Never hijack Ctrl/Cmd+C/X while the user is copying an actual text
    // selection (e.g. an inline error message rendered inside the tree): the
    // browser must get the key so the selected text is copied instead of the
    // selected files. Also let editable elements (if any ever live in the
    // tree) keep their native copy/cut behavior.
    if (mod && (key === 'c' || key === 'x')) {
      const target = e.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const selection = window.getSelection()
      if (selection !== null && !selection.isCollapsed && selection.toString().length > 0) return
    }
    if (mod && key === 'c') {
      const items = selectedItems()
      if (items.length === 0) return
      e.preventDefault()
      copyToClipboard(items, 'copy')
      return
    }
    if (mod && key === 'x') {
      const items = selectedItems()
      if (items.length === 0) return
      e.preventDefault()
      copyToClipboard(items, 'cut')
      return
    }
    if (mod && key === 'v') {
      if (clipboard.items.length === 0) return
      e.preventDefault()
      void onPaste()
      return
    }
    if (mod && key === 'a') {
      e.preventDefault()
      selectAllEntries()
      return
    }
    if (mod && key === 'z' && !e.shiftKey) {
      if (undoEntries.length === 0) return
      e.preventDefault()
      void performUndo()
      return
    }
    if (e.key === 'Delete') {
      if (Object.keys(selected).length === 0) return
      e.preventDefault()
      void deleteSelection()
      return
    }
    if (e.key === 'Escape') {
      setSelected({})
      cancelCut()
    }
  }, [cancelCut, clipboard.items.length, deleteSelection, onPaste, performUndo, selectAllEntries, selectedItems, undoEntries.length])

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

  // Cut items ghost in the tree until the paste moves them away.
  const cutPaths = new Set(clipboard.mode === 'cut' ? clipboard.items.map((item) => item.path) : [])

  /** Listings as the user sees them (the internal trash folder is hidden). */
  const visibleEntries = (entries: FsListEntry[]) => entries.filter((entry) => entry.name !== TRASH_NAME)

  const renderEntries = (entries: FsListEntry[], depth: number) => visibleEntries(entries).map((entry) => {
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
          isSelected={selected[entry.path] !== undefined}
          isCut={cutPaths.has(entry.path)}
          isExpanded={isExpanded}
          isDropTarget={dropTarget === entry.path}
          onToggleDir={toggleDir}
          onRefreshDir={refreshDir}
          onSelect={onRowClick}
          onDoubleClick={onRowDoubleClick}
          onOpenExternal={openPath}
          onContextMenu={openContextMenu}
          onDragStart={onRowDragStart}
          onDragEnd={onRowDragEnd}
          onDragOverRow={onRowDragOver}
          onDragLeaveRow={onRowDragLeave}
          onDropRow={onRowDrop}
          t={t}
        />
        {isDir && isExpanded && (
          <div>
            {isLoading && <div className={styles.rowHint} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>{t('preview.loading')}</div>}
            {error !== undefined && !isLoading && <div className={styles.rowError} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>{error}</div>}
            {childEntries !== undefined && visibleEntries(childEntries).length === 0 && !isLoading && (
              <div className={styles.rowHint} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>{t('preview.emptyDir')}</div>
            )}
            {childEntries !== undefined && renderEntries(childEntries, depth + 1)}
          </div>
        )}
      </div>
    )
  })

  interface MenuItem {
    label: string
    danger?: boolean
    disabled?: boolean
    onClick: () => void
  }

  const menuItems = (m: MenuState): Array<MenuItem | 'divider'> => {
    // Right-clicking one member of a multi-selection operates on the whole
    // selection (Explorer behavior): show a batch delete instead of the
    // single-item one.
    const selectionCount = Object.keys(selected).length
    const deleteItem: MenuItem = selectionCount > 1
      ? { label: t('menu.deleteSelected', { count: selectionCount }), danger: true, onClick: () => void deleteSelection() }
      // 'blank' never renders deleteItem (the blank branch returns earlier);
      // the fallback only satisfies the union type.
      : { label: t('menu.delete'), danger: true, onClick: () => onDelete(m.path, m.kind === 'blank' ? 'dir' : m.kind) }
    if (m.kind === 'file') {
      return [
        { label: t('menu.atFile'), onClick: () => onMention(m.path) },
        { label: t('menu.open'), onClick: () => openFile(m.path) },
        'divider',
        { label: t('menu.copy'), onClick: () => onCopySelection('copy') },
        { label: t('menu.cut'), onClick: () => onCopySelection('cut') },
        'divider',
        { label: t('menu.copyPath'), onClick: () => onCopyPath(m.path) },
        { label: t('menu.revealInExplorer'), onClick: () => onReveal(m.path, 'file') },
        { label: t('menu.openSystem'), onClick: () => void openPath(m.path) },
        'divider',
        { label: t('menu.rename'), onClick: () => onRename(m.path) },
        deleteItem,
      ]
    }
    if (m.kind === 'dir') {
      return [
        { label: t('menu.newFile'), onClick: () => onNewFile(m.path) },
        { label: t('menu.newFolder'), onClick: () => onNewFolder(m.path) },
        'divider',
        { label: t('menu.copy'), onClick: () => onCopySelection('copy') },
        { label: t('menu.cut'), onClick: () => onCopySelection('cut') },
        { label: t('menu.paste'), disabled: clipboard.items.length === 0, onClick: () => void onPaste() },
        'divider',
        { label: t('menu.copyPath'), onClick: () => onCopyPath(m.path) },
        { label: t('menu.revealInExplorer'), onClick: () => onReveal(m.path, 'dir') },
        { label: t('menu.openSystem'), onClick: () => void openPath(m.path) },
        { label: t('menu.refresh'), onClick: () => refreshDir(m.path) },
        'divider',
        { label: t('menu.rename'), onClick: () => onRename(m.path) },
        deleteItem,
      ]
    }
    // Blank space / header / clipboard bar: operations against the current
    // workspace folder (right-clicking blank space acts on the cwd, VS Code
    // file-explorer style).
    if (m.kind === 'blank') {
      const dirPath = m.path
      return [
        { label: t('menu.newFile'), onClick: () => onNewFile(dirPath) },
        { label: t('menu.newFolder'), onClick: () => onNewFolder(dirPath) },
        { label: t('menu.paste'), disabled: clipboard.items.length === 0, onClick: () => void onPaste() },
        'divider',
        { label: t('menu.selectAll'), onClick: selectAllEntries },
        { label: t('menu.undo'), disabled: undoEntries.length === 0, onClick: () => void performUndo() },
        'divider',
        { label: t('menu.copyPath'), onClick: () => onCopyPath(dirPath) },
        { label: t('menu.revealInExplorer'), onClick: () => onReveal(dirPath, 'dir') },
        { label: t('menu.openSystem'), onClick: () => void openPath(dirPath) },
        { label: t('menu.refresh'), onClick: () => refreshDir(dirPath) },
      ]
    }
    return [
      { label: t('menu.paste'), disabled: clipboard.items.length === 0, onClick: () => void onPaste() },
    ]
  }

  return (
    <div
      className={styles.column}
      style={{ width: width > 0 ? width : undefined }}
      data-pane="explorer"
      data-fe-theme={theme}
      onContextMenu={onColumnContextMenu}
    >
      <div className={styles.header}>
        <span className={styles.headerTitle} title={root ?? cwd}>{basenameOf(root ?? cwd)}</span>
        <span className={styles.headerActions}>
          <button
            type="button"
            className={styles.action}
            title={undoEntries.length > 0 ? `${t('action.undo')}：${undoEntries[undoEntries.length - 1].label}` : t('action.undo')}
            disabled={undoEntries.length === 0}
            onClick={() => void performUndo()}
          >
            ↩
          </button>
          <button type="button" className={styles.action} title={t('action.theme')} onClick={toggleTheme}>
            {theme === 'dark' ? '☀' : '🌙'}
          </button>
          <button type="button" className={styles.action} title={t('action.open')} onClick={() => void openPath(cwd)}>↗</button>
          <button type="button" className={styles.action} title={t('tab.expand')} onClick={expandPreview}>{'>'}</button>
        </span>
      </div>
      {clipboard.items.length > 0 && (
        <div className={styles.clipboardBar} role="status">
          <span className={styles.clipboardText}>
            {clipboard.mode === 'cut'
              ? t('clipboard.cut', { count: clipboard.items.length })
              : t('clipboard.copied', { count: clipboard.items.length })}
            <span className={styles.clipboardHint}>{t('clipboard.pasteHint')}</span>
          </span>
          <button
            type="button"
            className={styles.action}
            title={t('clipboard.clear')}
            onClick={() => {
              clearClipboard()
              if (clipboard.mode === 'cut') setSelected({})
            }}
          >
            ✕
          </button>
        </div>
      )}
      <div
        ref={treeAreaRef}
        tabIndex={0}
        className={styles.treeArea}
        onKeyDown={onTreeKeyDown}
        onClick={(e) => {
          // Clicking blank space (or a hint/error line — anything that is not
          // a tree row) deselects, Explorer behavior.
          const target = e.target as HTMLElement
          if (target.closest('[role="treeitem"]') === null) setSelected({})
        }}
        onDragOver={(e) => {
          // Blank tree area also accepts a drop: move into the current folder.
          if (dragPathsRef.current === null) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(e) => {
          if (dragPathsRef.current !== null) onDropMove(e, cwd)
        }}
      >
        {rootLoading && <div className={styles.rowHint}>{t('preview.loading')}</div>}
        {rootError !== undefined && <div className={styles.rowError}>{rootError}</div>}
        {!rootLoading && rootError === undefined && root !== undefined && children[root] !== undefined && visibleEntries(children[root]).length === 0 && (
          <div className={styles.rowHint}>{t('preview.emptyDir')}</div>
        )}
        {root !== undefined && children[root] !== undefined && renderEntries(children[root], 0)}
      </div>
      {menu !== undefined && (
        <div
          ref={menuRef}
          className={styles.contextMenu}
          role="menu"
          onContextMenu={(e) => {
            // Right-clicking the open menu keeps it (and never shows the
            // browser menu).
            e.preventDefault()
            e.stopPropagation()
          }}
          style={menuPos !== undefined ? { left: menuPos.x, top: menuPos.y } : { left: menu.x, top: menu.y, visibility: 'hidden' }}
        >
          {menuItems(menu).map((item, index) =>
            item === 'divider' ? (
              <div key={index} className={styles.contextMenuDivider} />
            ) : (
              <div
                key={index}
                role="menuitem"
                className={`${styles.contextMenuItem}${item.danger ? ` ${styles.contextMenuItemDanger}` : ''}${item.disabled ? ` ${styles.contextMenuItemDisabled}` : ''}`}
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
