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

interface PerWorkspace {
  tabs: string[]
  active: string | undefined
  collapsed: boolean
}

export interface TabsStateView {
  tabs: string[]
  active: string | undefined
  collapsed: boolean
  /** Display-only soft wrap for the editor (never touches the file content). */
  wrap: boolean
  theme: FeTheme
  cwd: string | undefined
}

const EMPTY_TABS: string[] = []
const EMPTY_WORKSPACE: PerWorkspace = { tabs: EMPTY_TABS, active: undefined, collapsed: false }

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
let view: TabsStateView = { tabs: EMPTY_TABS, active: undefined, collapsed: false, wrap: initialWrap, theme: 'dark', cwd: undefined }
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
  }
  if (
    nextView.tabs === view.tabs
    && nextView.active === view.active
    && nextView.collapsed === view.collapsed
    && nextView.wrap === view.wrap
    && nextView.theme === view.theme
    && nextView.cwd === view.cwd
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
