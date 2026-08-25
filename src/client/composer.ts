/**
 * Composer integration for the workbench file column.
 *
 * Three gestures land text in the chat composer without touching the core:
 *
 * 1. Drag & drop — dragging one or more tree rows and dropping ANYWHERE
 *    outside the file column (the chat, the composer, the message list)
 *    inserts the dragged paths into the composer as `@.\` mentions (falling
 *    back to the absolute path when the file sits outside the workspace).
 *    Dropping INSIDE the file column still performs the tree's own move
 *    operation — the tree's drop handler runs first and stops propagation, so
 *    this document-level listener never sees those drops.
 *
 * 2. Context-menu "@引用" — inserts `@.\<relative-workspace-path>` at the
 *    composer caret (the `.\` prefix marks the path as workspace-relative; a
 *    path containing whitespace uses the quoted `@"\.\path with space"` form).
 *
 * 3. @-mention resolution — turns a mention token (with or without the `.\`
 *    prefix, quoted or plain) into an absolute path against the session cwd;
 *    used by the message linkifier and the composer overlay to open the file
 *    in the workbench preview.
 *
 * The composer is a controlled React textarea, so the value is updated
 * through the native `value` setter + a bubbling `input` event (the standard
 * trick that makes React's onChange see the change), and the caret is
 * restored on the next frame because the React re-render may reset it.
 */
import { getTabsState, openFile } from './store'

/** Custom dataTransfer type carrying the dragged workspace paths (JSON array). */
export const DRAG_TYPE = 'application/x-dsh-workbench-files'

/** One-time install guard (the client bundle re-applies on HMR). */
let dropsInstalled = false

/** Start the document-level drop listener (idempotent). */
export function installComposerDrops(): void {
  if (dropsInstalled || typeof document === 'undefined') return
  dropsInstalled = true
  // Bubble phase: the tree's own drop handlers (React, attached at the root
  // container) run first and stop the event, so drops inside the file column
  // never reach this listener.
  document.addEventListener('drop', onDocumentDrop)
}

function onDocumentDrop(e: DragEvent): void {
  const dt = e.dataTransfer
  if (dt === null || !dt.types.includes(DRAG_TYPE)) return
  const paths = readDraggedPaths(dt)
  if (paths.length === 0) return
  if (!insertIntoComposer(paths.map(dragMentionText).join('\n'))) return
  e.preventDefault()
  e.stopPropagation()
}

/**
 * One dropped path as chat text: an `@.\` mention when it lives under the
 * workspace, the absolute path otherwise (or when no cwd is known yet).
 */
function dragMentionText(path: string): string {
  const { cwd } = getTabsState()
  if (cwd === undefined) return path
  const rel = relPathOf(path, cwd)
  if (rel.length === 0 || rel === path) return path
  return composerMention(rel)
}

/** Read the JSON paths from the custom type; falls back to raw text. */
export function readDraggedPaths(dt: DataTransfer | null): string[] {
  if (dt === null) return []
  let raw = ''
  try {
    raw = dt.getData(DRAG_TYPE)
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) return parsed as string[]
  } catch {
    // Not JSON — fall through to the raw-text fallback.
  }
  return raw.trim().length > 0 ? [raw] : []
}

/** The visible composer textarea, or null when none is usable. */
function composerTextarea(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null
  const seat = document.querySelector('[data-composer-seat]')
  if (seat === null) return null
  const input = seat.querySelector('textarea')
  if (!(input instanceof HTMLTextAreaElement)) return null
  // A disabled input has no usable draft; a read-only one is either the hero
  // workspace picker or a transient submitting state — skip both.
  if (input.disabled || input.readOnly) return null
  return input
}

/**
 * Insert `text` into the composer. If the composer textarea has focus, the
 * text goes at the caret; otherwise it is appended to the draft. Returns
 * false when no usable composer is present.
 */
export function insertIntoComposer(text: string): boolean {
  const textarea = composerTextarea()
  if (textarea === null) return false
  const value = textarea.value
  const atCaret = document.activeElement === textarea
  const start = atCaret ? textarea.selectionStart : value.length
  const end = atCaret ? textarea.selectionEnd : value.length
  const next = value.slice(0, start) + text + value.slice(end)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter !== undefined) setter.call(textarea, next)
  else textarea.value = next
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  // The React re-render may reset the selection, so restore on the next frame.
  const caret = start + text.length
  requestAnimationFrame(() => {
    try {
      textarea.setSelectionRange(caret, caret)
    } catch {
      // Selection state unavailable — the text is in the draft either way.
    }
  })
  return true
}

/** Relative workspace path of `path` under `cwd` ('' when it IS the cwd). */
export function relPathOf(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return path
  const sep = cwd.includes('\\') ? '\\' : '/'
  const prefix = cwd.endsWith('\\') || cwd.endsWith('/') ? cwd : cwd + sep
  const lowerPath = path.toLowerCase()
  if (lowerPath.startsWith(prefix.toLowerCase())) return path.slice(prefix.length)
  if (lowerPath === cwd.toLowerCase()) return ''
  return path
}

/**
 * Format a workspace-relative path as an `@` mention for the composer: the
 * `.\` (or `./`) prefix marks the path as relative to the workspace root, and
 * a path containing whitespace uses the quoted `@"..."` form so it stays one
 * token in the draft (and one link in the rendered message).
 */
export function composerMention(rel: string): string {
  const sep = rel.includes('\\') ? '\\' : '/'
  const raw = `@.${sep}${rel}`
  if (/[\s"]/.test(raw)) return `@"${raw}"`
  return raw
}

/** Strip quote wrapping and a leading `.\` / `./` workspace marker. */
function normalizeMention(mention: string): string {
  let inner = mention
  if (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) inner = inner.slice(1, -1)
  if (inner.startsWith('.\\') || inner.startsWith('./')) inner = inner.slice(2)
  return inner
}

/**
 * Resolve an @-mention path (workspace-relative with or without the `.\`
 * marker, or absolute) against the current workspace cwd; returns the absolute
 * OS path, or undefined when the mention cannot be resolved (no cwd and the
 * path is not absolute).
 */
export function resolveMentionPath(mention: string): string | undefined {
  const inner = normalizeMention(mention)
  if (inner.length === 0) return undefined
  const absolute = /^[A-Za-z]:[\\/]/.test(inner) || inner.startsWith('/') || inner.startsWith('\\')
  const { cwd } = getTabsState()
  if (absolute) return inner
  if (cwd === undefined) return undefined
  const sep = cwd.includes('\\') ? '\\' : '/'
  return cwd.endsWith('\\') || cwd.endsWith('/') ? cwd + inner : cwd + sep + inner
}

/** Open an @-mention's file in the workbench preview (used by the linkifier). */
export function openMention(mention: string): void {
  const abs = resolveMentionPath(mention)
  if (abs === undefined) return
  openFile(abs)
}
