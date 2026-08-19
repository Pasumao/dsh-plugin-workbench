/**
 * Module-local store shared by the explorer tree (FileExplorer) and the split
 * preview (FilePreview). Tabs, active file, and collapsed state are kept
 * PER WORKSPACE (keyed by the session cwd): switching workspaces swaps to that
 * workspace's own set, and coming back restores it. Both components live in
 * the same client bundle, so this store is a single instance across the two
 * slot registrations.
 */
import { useSyncExternalStore } from 'react'

export type FeTheme = 'light' | 'dark'

// ---------------------------------------------------------------------------
// Undo history (Copy / Move / Rename / New / Delete)
//
// One stack PER WORKSPACE, mirroring the tabs: undoing in workspace B never
// touches workspace A's file operations. Delete is reversible by design —
// deleting RENAMES the item into a hidden `.dsh-trash` folder next to it, and
// undo renames it back (no bytes are ever copied). When a stack overflows the
// oldest entry is evicted; the caller permanently purges evicted delete
// entries' trash items so the trash folder stays bounded.
// ---------------------------------------------------------------------------

/** How many operations each workspace remembers (older ones are dropped). */
export const UNDO_LIMIT = 30

export type UndoEntry =
  /** copy/paste (duplicate) — undo removes the copy. */
  | { kind: 'copy'; label: string; from: string; to: string; parent: string }
  /** cut-paste or drag-move — undo renames the item back. */
  | { kind: 'move'; label: string; from: string; to: string; parent: string }
  /** rename — undo renames back. */
  | { kind: 'rename'; label: string; from: string; to: string; parent: string }
  /** new file / new folder — undo trashes it. */
  | { kind: 'create'; label: string; path: string; parent: string }
  /** delete (moved into .dsh-trash) — undo renames it back. */
  | { kind: 'delete'; label: string; path: string; trash: string; parent: string }

interface PerWorkspace {
  tabs: string[]
  active: string | undefined
  collapsed: boolean
  undo: UndoEntry[]
}

export interface TabsStateView {
  tabs: string[]
  active: string | undefined
  collapsed: boolean
  /** Display-only soft wrap for the editor (never touches the file content). */
  wrap: boolean
  theme: FeTheme
  cwd: string | undefined
  /** Undoable file operations, most recent last. */
  undo: UndoEntry[]
}

const EMPTY_TABS: string[] = []
const EMPTY_UNDO: UndoEntry[] = []
const EMPTY_WORKSPACE: PerWorkspace = { tabs: EMPTY_TABS, active: undefined, collapsed: false, undo: EMPTY_UNDO }

const WRAP_KEY = 'dsh-plugin-workbench:wrap'

/** Read the persisted wrap preference; defaults to soft wrap ON. */
function storedWrap(): boolean {
  try {
    if (typeof window === 'undefined') return true
    const stored = window.localStorage.getItem(WRAP_KEY)
    return stored === null ? true : stored === '1'
  } catch {
    return true
  }
}

interface StoreState {
  currentCwd: string | undefined
  workspaces: Record<string, PerWorkspace>
  theme: FeTheme
  wrap: boolean
}

const initialWrap = storedWrap()
let state: StoreState = { currentCwd: undefined, workspaces: {}, theme: 'dark', wrap: initialWrap }
let view: TabsStateView = { tabs: EMPTY_TABS, active: undefined, collapsed: false, wrap: initialWrap, theme: 'dark', cwd: undefined, undo: EMPTY_UNDO }
const listeners = new Set<() => void>()

function workspaceOf(cwd: string | undefined): PerWorkspace {
  return cwd !== undefined ? state.workspaces[cwd] ?? EMPTY_WORKSPACE : EMPTY_WORKSPACE
}

export function getTabsState(): TabsStateView {
  return view
}

export function subscribeTabs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTabsState(): TabsStateView {
  return useSyncExternalStore(subscribeTabs, getTabsState)
}

function commit(next: StoreState): void {
  state = next
  const ws = workspaceOf(state.currentCwd)
  const nextView: TabsStateView = {
    tabs: ws.tabs,
    active: ws.active,
    collapsed: ws.collapsed,
    wrap: state.wrap,
    theme: state.theme,
    cwd: state.currentCwd,
    undo: ws.undo,
  }
  if (
    nextView.tabs === view.tabs
    && nextView.active === view.active
    && nextView.collapsed === view.collapsed
    && nextView.wrap === view.wrap
    && nextView.theme === view.theme
    && nextView.cwd === view.cwd
    && nextView.undo === view.undo
  ) return
  view = nextView
  for (const listener of [...listeners]) listener()
}

/** Update the current workspace's record; no-op without a current workspace. */
function updateCurrent(updater: (ws: PerWorkspace) => PerWorkspace): void {
  const cwd = state.currentCwd
  if (cwd === undefined) return
  const prev = state.workspaces[cwd] ?? EMPTY_WORKSPACE
  const next = updater(prev)
  if (next === prev) return
  commit({ ...state, workspaces: { ...state.workspaces, [cwd]: next } })
}

/** Point the store at a workspace (called when the session's cwd changes). */
export function setCwd(cwd: string | undefined): void {
  if (state.currentCwd === cwd) return
  commit({ ...state, currentCwd: cwd })
}

/** Open a file in the current workspace's tabs (or activate it); pops the pane out. */
export function openFile(path: string): void {
  updateCurrent((ws) => {
    if (ws.tabs.includes(path)) {
      if (ws.active === path && !ws.collapsed) return ws
      return { ...ws, active: path, collapsed: false }
    }
    return { ...ws, tabs: [...ws.tabs, path], active: path, collapsed: false }
  })
}

/** Close one tab; if it was active, activate its neighbor. */
export function closeFile(path: string): void {
  updateCurrent((ws) => {
    const index = ws.tabs.indexOf(path)
    if (index < 0) return ws
    const tabs = ws.tabs.filter((t) => t !== path)
    let active = ws.active
    if (active === path) active = tabs[Math.min(index, tabs.length - 1)]
    return { ...ws, tabs, active }
  })
}

/** Switch the active tab without re-reading. */
export function activateFile(path: string): void {
  updateCurrent((ws) => (ws.active === path || !ws.tabs.includes(path) ? ws : { ...ws, active: path }))
}

/** Point any open tab at a new path after a rename (the disk path changed). */
export function retargetFile(oldPath: string, newPath: string): void {
  updateCurrent((ws) => {
    if (!ws.tabs.includes(oldPath)) return ws
    const tabs = ws.tabs.map((t) => (t === oldPath ? newPath : t))
    return { ...ws, tabs, active: ws.active === oldPath ? newPath : ws.active }
  })
}

/** Close every open tab at or under a path (used after deleting it). */
export function closeFilesUnder(path: string): void {
  updateCurrent((ws) => {
    const sep = path.includes('\\') ? '\\' : '/'
    const prefix = path.endsWith('\\') || path.endsWith('/') ? path : path + sep
    const kept = ws.tabs.filter((t) => t !== path && !t.startsWith(prefix))
    if (kept.length === ws.tabs.length) return ws
    let active = ws.active
    if (active !== undefined && (active === path || active.startsWith(prefix))) {
      const index = ws.tabs.indexOf(active)
      active = kept[Math.min(index, kept.length - 1)]
    }
    return { ...ws, tabs: kept, active }
  })
}

/** Move a tab before another tab (drag-to-reorder). */
export function moveTab(dragged: string, target: string): void {
  updateCurrent((ws) => {
    if (dragged === target) return ws
    const from = ws.tabs.indexOf(dragged)
    const to = ws.tabs.indexOf(target)
    if (from < 0 || to < 0) return ws
    const tabs = [...ws.tabs]
    tabs.splice(from, 1)
    tabs.splice(to, 0, dragged)
    return { ...ws, tabs }
  })
}

/** Tuck the preview pane away, keeping all open tabs and their content. */
export function collapsePreview(): void {
  updateCurrent((ws) => (ws.collapsed ? ws : { ...ws, collapsed: true }))
}

/** Pop the preview pane back out, restoring the tabs as they were. */
export function expandPreview(): void {
  updateCurrent((ws) => (ws.collapsed ? { ...ws, collapsed: false } : ws))
}

/** Toggle the file-browser light/dark theme (applies to every workspace). */
export function toggleTheme(): void {
  commit({ ...state, theme: state.theme === 'dark' ? 'light' : 'dark' })
}

/** Toggle display-only soft wrap for the editor (global, persisted). */
export function toggleWrap(): void {
  const wrap = !state.wrap
  try {
    window.localStorage.setItem(WRAP_KEY, wrap ? '1' : '0')
  } catch {
    // storage unavailable — the preference just won't persist across reloads
  }
  commit({ ...state, wrap })
}

// ---------------------------------------------------------------------------
// File clipboard (Copy / Cut + Paste)
//
// Lives OUTSIDE the per-workspace records on purpose: copying in workspace A
// and pasting into workspace B is the whole point, so the clipboard survives
// workspace switches. Cut keeps the sources alive until a paste moves them
// (or Escape downgrades the cut back to a copy), mirroring the OS explorer.
// ---------------------------------------------------------------------------

export type ClipboardMode = 'copy' | 'cut'

export interface ClipboardItem {
  path: string
  name: string
  kind: 'file' | 'dir' | 'other'
}

export interface ClipboardView {
  items: ClipboardItem[]
  mode: ClipboardMode
}

const EMPTY_CLIPBOARD: ClipboardView = { items: [], mode: 'copy' }

let clipboard: ClipboardView = EMPTY_CLIPBOARD
const clipboardListeners = new Set<() => void>()

export function getClipboard(): ClipboardView {
  return clipboard
}

export function subscribeClipboard(listener: () => void): () => void {
  clipboardListeners.add(listener)
  return () => {
    clipboardListeners.delete(listener)
  }
}

/** Clipboard contents shared across every workspace (Explorer semantics). */
export function useClipboard(): ClipboardView {
  return useSyncExternalStore(subscribeClipboard, getClipboard)
}

function commitClipboard(next: ClipboardView): void {
  if (next === clipboard) return
  clipboard = next
  for (const listener of [...clipboardListeners]) listener()
}

/** Put entries on the clipboard, replacing whatever was there. */
export function copyToClipboard(items: ClipboardItem[], mode: ClipboardMode): void {
  if (items.length === 0) return
  commitClipboard({ items, mode })
}

/** Drop the clipboard contents (after a cut-paste, or via the clear button). */
export function clearClipboard(): void {
  if (clipboard === EMPTY_CLIPBOARD) return
  commitClipboard(EMPTY_CLIPBOARD)
}

/** Escape in the source workspace: cancel an armed cut without dropping the items. */
export function cancelCut(): void {
  if (clipboard.mode === 'cut') commitClipboard({ ...clipboard, mode: 'copy' })
}

// ---------------------------------------------------------------------------
// Undo stack (see the types at the top of this file)
// ---------------------------------------------------------------------------

/**
 * Append an operation to the current workspace's undo stack, capped at
 * UNDO_LIMIT entries. Returns the evicted oldest entry (the caller purges its
 * trash item when it was a delete), or undefined when nothing was evicted.
 */
export function pushUndo(entry: UndoEntry): UndoEntry | undefined {
  const cwd = state.currentCwd
  if (cwd === undefined) return undefined
  const prev = state.workspaces[cwd] ?? EMPTY_WORKSPACE
  const undo = [...prev.undo, entry]
  let evicted: UndoEntry | undefined
  if (undo.length > UNDO_LIMIT) evicted = undo.shift()
  commit({ ...state, workspaces: { ...state.workspaces, [cwd]: { ...prev, undo } } })
  return evicted
}

/** Remove and return the current workspace's most recent operation (or undefined). */
export function popUndo(): UndoEntry | undefined {
  const cwd = state.currentCwd
  if (cwd === undefined) return undefined
  const prev = state.workspaces[cwd] ?? EMPTY_WORKSPACE
  if (prev.undo.length === 0) return undefined
  const undo = [...prev.undo]
  const entry = undo.pop()
  commit({ ...state, workspaces: { ...state.workspaces, [cwd]: { ...prev, undo } } })
  return entry
}
