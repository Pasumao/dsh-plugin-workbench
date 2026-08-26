/**
 * Split file preview with VS Code-style tabs and a directly-editable editor.
 * Files open in tabs; the active tab is an always-editable textarea overlaid on
 * a syntax-highlighted layer (Ctrl/Cmd+S saves). Markdown files open in a
 * RENDERED preview by default, with a button to switch to the editable source
 * view. Tabs are drag-reorderable. Open files are watched on disk: external
 * changes auto-sync clean tabs and flag dirty ones (click the badge to reload,
 * discarding unsaved edits). Opening/closing the first/last tab is animated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import styles from './files.module.css'
import { detectLanguage, highlightCode } from './highlight'
import { renderMarkdown } from './markdown'
import { FileIcon } from './fileIcons'
import type { FilesKey } from './locales'
import { activateFile, closeFile, collapsePreview, moveTab, toggleWrap, useTabsState } from './store'
import type { FsReadResult } from './FileExplorer'

interface TabData {
  status: 'loading' | 'loaded' | 'image' | 'binary' | 'too-large' | 'error'
  content?: string
  draft?: string
  dirty?: boolean
  size?: number
  message?: string
  /** Markdown tabs: 'rendered' shows the compiled preview, 'source' the editor. */
  view?: 'rendered' | 'source'
  /** The file changed on disk while this tab holds unsaved edits. */
  diskChanged?: boolean
}

export interface FsWriteResult {
  path: string
  size: number
}

export interface FilePreviewProps {
  t: (key: FilesKey, params?: Record<string, unknown>) => string
  readFile: (path: string, signal?: AbortSignal) => Promise<FsReadResult>
  writeFile: (path: string, content: string, signal?: AbortSignal) => Promise<FsWriteResult>
  /** Replace the host-side watch set (the open tab paths). Idempotent diff. */
  watchFiles: (paths: string[]) => Promise<void>
}

const PREVIEW_MIN = 240
const CHAT_MIN = 240
const PREVIEW_TOO_LARGE_LABEL = '512KB'

/** Persisted split width (px) — survives reloads so a drag is never lost. */
const PREVIEW_WIDTH_KEY = 'dsh-plugin-workbench:preview-width'

/** Read the persisted preview width; `null` means "use the default 55%". */
function storedPreviewWidth(): number | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(PREVIEW_WIDTH_KEY)
    if (raw === null) return null
    const px = Number(raw)
    return Number.isFinite(px) && px > 0 ? px : null
  } catch {
    return null
  }
}

/** Same-origin raw-bytes route registered by the host half (see src/index.ts). */
const RAW_PREFIX = '/dsh-plugin-files/raw'

/** Same-origin SSE endpoint pushed by the host half (see src/index.ts). */
const EVENTS_ENDPOINT = '/dsh-plugin-files/events'

/**
 * Above this size an .md file opens in source view: compiling a multi-hundred
 * KB document and laying out its DOM is what makes the pane lag.
 */
const MD_RENDER_MAX_BYTES = 256 * 1024

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'])

/**
 * Same-origin URL serving the file's bytes when it is a previewable image;
 * undefined otherwise. Image tabs never go through the text RPC read — the
 * host route resolves the path through the sandboxed fs service itself.
 */
function imageSrcOf(path: string): string | undefined {
  const idx = path.lastIndexOf('.')
  if (idx < 0 || idx === path.length - 1) return undefined
  const ext = path.slice(idx + 1).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext) ? `${RAW_PREFIX}/${encodeURIComponent(path)}` : undefined
}

/**
 * Above this size the overlay editor (syntax-highlight layer + transparent
 * textarea) falls back to a plain textarea: re-injecting and re-laying out
 * hundreds of KB of wrapped text on every keystroke is what makes the page
 * lag. The plain textarea keeps editing, wrapping and scrolling — it only
 * loses the colors, which files this big rarely need anyway.
 */
const HIGHLIGHT_MAX_BYTES = 64 * 1024

/**
 * Languages always rendered as a plain textarea, never the overlay: the
 * highlight layer costs a full extra layout pass (and with CJK text a
 * fragile alignment surface) for prose formats where colors add little.
 */
const PLAIN_LANGUAGES = new Set(['markdown'])

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Nearest ancestor that actually takes part in layout. The slot system wraps
 * each slot's content in a `display: contents` element: children still join
 * the OUTER flex row, but the wrapper itself reports a 0×0 bounding rect.
 * Measuring that (the old `handle.parentElement`) made `max` collapse to
 * `PREVIEW_MIN` on the first move — the pane jumped to its minimum width and
 * could never be dragged back out. Skip every `display: contents` layer.
 */
function laidOutParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node !== null) {
    if (getComputedStyle(node).display !== 'contents') return node
    node = node.parentElement
  }
  return null
}

/** Parent directory of a path ('C:/a/b.md' → 'C:/a'; '' when there is none). */
function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx > 0 ? path.slice(0, idx) : ''
}

function previewDataOf(result: FsReadResult): TabData {
  if (result.truncated) return { status: 'too-large', size: result.size }
  if (result.binary) return { status: 'binary', size: result.size }
  const data: TabData = {
    status: 'loaded',
    content: result.content,
    draft: result.content,
    dirty: false,
    size: result.size,
  }
  // Markdown opens in the rendered preview by default (source view for files
  // too large to render responsively).
  if (detectLanguage(result.path) === 'markdown' && result.size <= MD_RENDER_MAX_BYTES) {
    data.view = 'rendered'
  }
  return data
}

/**
 * Gutter text for an editor: one logical line number per source line, as a
 * single pre-formatted block (VS Code shows logical numbers even when soft
 * wrap makes a line occupy several visual rows).
 */
function lineNumbersOf(content: string): string {
  const count = content.split('\n').length
  if (count <= 1) return '1'
  const parts = new Array<string>(count)
  for (let i = 0; i < count; i += 1) parts[i] = String(i + 1)
  return parts.join('\n')
}

export function FilePreview({ t, readFile, writeFile, watchFiles }: FilePreviewProps) {
  const { tabs, active, theme, collapsed, wrap } = useTabsState()

  const [previewWidth, setPreviewWidth] = useState<number | null>(null)
  const [closing, setClosing] = useState(false)
  const [dragPath, setDragPath] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)

  const cacheRef = useRef<Map<string, TabData>>(new Map())
  const hasOpenedRef = useRef(false)
  const [, bump] = useState(0)
  const [imageFailed, setImageFailed] = useState<string | undefined>(undefined)

  const previewRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  // Live drag listeners, kept in refs so a new drag can ALWAYS clear any
  // leftovers (a lost pointerup must not leak a stale onMove into the page).
  const dragMoveRef = useRef<(ev: PointerEvent) => void>(() => undefined)
  const dragUpRef = useRef<() => void>(() => undefined)

  const refresh = useCallback(() => bump((v) => v + 1), [])

  // Mirror of the current tab list for the SSE handler (avoids stale closures).
  const tabsRef = useRef(tabs)
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  /**
   * Re-read one open file from disk (external edit sync, or the disk-changed
   * badge click). A reload always takes disk content — the auto-sync path only
   * runs on clean tabs, and the badge click is the user's explicit choice to
   * drop unsaved edits.
   */
  const reloadFromDisk = useCallback(async (path: string) => {
    const data = cacheRef.current.get(path)
    if (data === undefined || data.status !== 'loaded') return
    try {
      const result = await readFile(path)
      const next = previewDataOf(result)
      // Keep the user's chosen view; a reload never flips rendered/source.
      cacheRef.current.set(path, { ...next, view: data.view, diskChanged: false })
    } catch (error) {
      // File gone / unreadable: surface the failure instead of stale content.
      cacheRef.current.set(path, {
        ...data,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        diskChanged: false,
      })
    }
    refresh()
  }, [readFile, refresh])

  /**
   * Handle one disk-change event for an open path. Clean tabs auto-sync;
   * dirty tabs keep their unsaved edits and show the reload badge instead.
   */
  const syncFromDisk = useCallback((path: string) => {
    const data = cacheRef.current.get(path)
    if (data === undefined || data.status === 'loading' || data.status === 'image') return
    if (data.status === 'error') {
      // Previously failed tab: retry the read (e.g. the file was re-created).
      void reloadFromDisk(path)
      return
    }
    if (data.dirty === true) {
      if (data.diskChanged !== true) {
        data.diskChanged = true
        refresh()
      }
      return
    }
    void reloadFromDisk(path)
  }, [reloadFromDisk, refresh])

  // Disk watch: tell the host which paths to watch (debounced), and re-send on
  // every SSE (re)connect so a dropped stream heals itself.
  useEffect(() => {
    const timer = setTimeout(() => {
      void watchFiles([...tabs]).catch(() => {
        // Host side not ready yet — the next tab change or SSE open retries.
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [tabs, watchFiles])

  // Disk change events pushed by the host (fs.watch + SSE).
  useEffect(() => {
    const source = new EventSource(EVENTS_ENDPOINT)
    source.onopen = () => {
      void watchFiles([...tabsRef.current]).catch(() => {
        // Ignore — the next onopen or tab change re-syncs.
      })
    }
    const onChange = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { path?: unknown }
        if (typeof payload.path === 'string' && tabsRef.current.includes(payload.path)) {
          syncFromDisk(payload.path)
        }
      } catch {
        // Malformed frame — ignore.
      }
    }
    source.addEventListener('change', onChange)
    return () => {
      source.removeEventListener('change', onChange)
      source.close()
    }
  }, [syncFromDisk, watchFiles])

  // Read the ACTIVE tab's content. Other tabs load lazily on first
  // activation, so switching to a workspace with many large files doesn't
  // re-read every tab at once (which used to freeze the switch).
  useEffect(() => {
    const cache = cacheRef.current
    for (const [path] of cache) {
      if (!tabs.includes(path)) cache.delete(path)
    }
    const target = active ?? tabs[0]
    if (target === undefined || cache.has(target)) {
      refresh()
      return undefined
    }
    const controller = new AbortController()
    // Image files skip the text RPC read entirely: the raw-bytes route serves
    // them straight into an <img> tag, so there is nothing to load here.
    if (imageSrcOf(target) !== undefined) {
      cache.set(target, { status: 'image' })
      refresh()
      return () => controller.abort()
    }
    cache.set(target, { status: 'loading' })
    readFile(target, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          cache.set(target, previewDataOf(result))
          // Large content: yield one frame so the browser paints the
          // loading→loaded transition before the heavy text layout runs —
          // the UI stays responsive instead of freezing in the same frame
          // as the tab-open interaction.
          if (result.size > HIGHLIGHT_MAX_BYTES) requestAnimationFrame(refresh)
          else refresh()
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          cache.set(target, { status: 'error', message: error instanceof Error ? error.message : String(error) })
          refresh()
        }
      })
    refresh()
    return () => controller.abort()
  }, [tabs, active, readFile, refresh])

  // A failed <img> (deleted file, oversized, …) must not keep showing the
  // broken-image placeholder when the user switches away and back.
  useEffect(() => {
    setImageFailed(undefined)
  }, [active])

  // Animate the last tab closing without a mount/unmount bounce: keep the pane
  // mounted while `hasOpenedRef` is set, then drop it after the transition.
  if (tabs.length > 0) hasOpenedRef.current = true
  useEffect(() => {
    if (tabs.length > 0) {
      setClosing(false)
      return undefined
    }
    if (hasOpenedRef.current) {
      setClosing(true)
      const timer = setTimeout(() => {
        setClosing(false)
        hasOpenedRef.current = false
      }, 200)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [tabs.length])

  const isOpen = !collapsed && (tabs.length > 0 || closing || hasOpenedRef.current)

  const activeData = active !== undefined ? cacheRef.current.get(active) : undefined
  const language = active !== undefined ? detectLanguage(active) : undefined
  const tooBig = (activeData?.size ?? 0) > HIGHLIGHT_MAX_BYTES
  const plain = language === undefined || tooBig || (language !== undefined && PLAIN_LANGUAGES.has(language))
  const isMarkdown = language === 'markdown'
  const mdRenderable = (activeData?.size ?? 0) <= MD_RENDER_MAX_BYTES
  // Rebuild the compiled markdown only when the draft (or the view mode)
  // changes — never on tab switches or focus re-renders.
  const mdHtml = useMemo(() => {
    if (activeData?.status !== 'loaded' || !isMarkdown || activeData.view !== 'rendered') return ''
    return renderMarkdown(activeData.draft ?? '', dirnameOf(active ?? ''))
  }, [activeData?.status, activeData?.draft, activeData?.view, isMarkdown, active])
  // Rebuild the gutter text only when the draft changes (not on every bump
  // from tab switches or focus re-renders).
  const gutterNumbers = useMemo(
    () => (activeData?.status === 'loaded' ? lineNumbersOf(activeData.draft ?? '') : ''),
    [activeData?.status, activeData?.draft],
  )

  // Keep the highlight layer and the line-number gutter in lockstep with the
  // textarea on every frame while the editor is open: some engines don't fire
  // scroll events during selection auto-scroll, which would otherwise leave
  // the visible layer and the numbers behind the selection (drag-select
  // misalignment). All layers are `overflow: auto|hidden` with identical
  // content geometry, so the assignment is a no-op whenever they align.
  useEffect(() => {
    const pre = highlightRef.current
    const ta = textareaRef.current
    const gutter = gutterRef.current
    if (ta === null || gutter === null) return undefined
    let raf = 0
    const tick = () => {
      if (pre !== null) {
        pre.scrollTop = ta.scrollTop
        pre.scrollLeft = ta.scrollLeft
      }
      gutter.scrollTop = ta.scrollTop
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isOpen, active, activeData?.status, activeData?.view, plain])

  // Publish the rendered preview width so the skin's fixed top/bottom trim can
  // shift past this pane (covering only the chat).
  useEffect(() => {
    if (!isOpen) {
      document.body.style.removeProperty('--dsh-preview-width')
      return undefined
    }
    const el = previewRef.current
    if (el === null) return undefined
    const update = () => {
      document.body.style.setProperty('--dsh-preview-width', `${el.getBoundingClientRect().width}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      observer.disconnect()
      document.body.style.removeProperty('--dsh-preview-width')
    }
  }, [isOpen])

  // Apply the persisted width once the pane gets its first real layout: the
  // saved px may exceed the CURRENT center column (window resized since the
  // last drag), so clamp it against a live measurement before applying —
  // otherwise a stale wide value would squeeze the chat seat to nothing.
  useEffect(() => {
    const saved = storedPreviewWidth()
    if (saved === null) return
    const preview = previewRef.current
    const center = laidOutParent(preview)
    if (preview === null || preview === undefined || center === null || center === undefined) return
    const centerWidth = center.getBoundingClientRect().width
    const max = Math.max(PREVIEW_MIN, centerWidth - CHAT_MIN)
    setPreviewWidth(clamp(saved, PREVIEW_MIN, max))
  }, [isOpen])

  // Unmount during a drag (slot removed mid-drag): drop the window listeners
  // so no stale move handler survives to rewrite widths in the next mount.
  useEffect(() => () => {
    window.removeEventListener('pointermove', dragMoveRef.current)
    window.removeEventListener('pointerup', dragUpRef.current)
    window.removeEventListener('pointercancel', dragUpRef.current)
  }, [])

  /**
   * Start a split-width drag. Robustness notes (the "pane suddenly shrinks
   * and freezes" bug class):
   *
   * - Pointer capture reroutes every later pointer event to the handle, so
   *   `pointerup` fires EVEN when the mouse is released outside the window.
   *   Without it the up event is lost, `onUp` never runs, and the leftover
   *   `onMove` keeps rewriting the width from its stale baseline on every
   *   mouse move anywhere on the page — that is the "cannot drag / cannot
   *   restore" state.
   * - `pointercancel` is cleaned up too (browser steals the pointer, e.g. a
   *   tablet palm or an OS gesture).
   * - Pointerdown defensively removes any previous listeners first, so even a
   *   capture-less leftover cannot survive into a second drag.
   * - The max is re-measured every move: the chat minimum is relative to the
   *   CURRENT center column, which can change while the drag is in flight.
   */
  const onHandleDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = handleRef.current
    const preview = previewRef.current
    if (handle === null || preview === null) return
    // NOT handle.parentElement: the slot wrapper is `display: contents` and
    // measures 0×0 — the flex container to clamp against is one level up (see
    // laidOutParent). Measuring the wrapper made every drag snap to
    // PREVIEW_MIN and then stick (the reported "sudden shrink / can't drag").
    const center = laidOutParent(handle)
    if (center === null) return
    const startX = e.clientX
    const startWidth = preview.getBoundingClientRect().width
    const onMove = (ev: PointerEvent) => {
      const centerWidth = center.getBoundingClientRect().width
      const max = Math.max(PREVIEW_MIN, centerWidth - CHAT_MIN)
      const width = clamp(startWidth + ev.clientX - startX, PREVIEW_MIN, max)
      setPreviewWidth(width)
      try {
        window.localStorage.setItem(PREVIEW_WIDTH_KEY, String(width))
      } catch {
        // storage unavailable — the width just won't persist across reloads
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', dragMoveRef.current)
      window.removeEventListener('pointerup', dragUpRef.current)
      window.removeEventListener('pointercancel', dragUpRef.current)
    }
    // Defensive reset of any previous drag (see the doc comment above).
    window.removeEventListener('pointermove', dragMoveRef.current)
    window.removeEventListener('pointerup', dragUpRef.current)
    window.removeEventListener('pointercancel', dragUpRef.current)
    dragMoveRef.current = onMove
    dragUpRef.current = onUp
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      // Pointer capture unsupported — the window listeners still cover the drag.
    }
  }, [])

  const onSave = useCallback(async () => {
    if (active === undefined) return
    const data = cacheRef.current.get(active)
    if (data === undefined || data.status !== 'loaded' || data.draft === undefined || !data.dirty) return
    try {
      const result = await writeFile(active, data.draft)
      data.content = data.draft
      data.dirty = false
      data.size = result.size
      setSaveError(undefined)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    }
    refresh()
  }, [active, writeFile, refresh])

  const onTextareaChange = useCallback((value: string) => {
    if (active === undefined) return
    const data = cacheRef.current.get(active)
    if (data === undefined || data.status !== 'loaded') return
    data.draft = value
    data.dirty = value !== data.content
    if (data.dirty === false) setSaveError(undefined)
    refresh()
  }, [active, refresh])

  /** Flip the active markdown tab between rendered preview and source editor. */
  const toggleMdView = useCallback(() => {
    if (active === undefined) return
    const data = cacheRef.current.get(active)
    if (data === undefined || data.status !== 'loaded') return
    data.view = data.view === 'rendered' ? 'source' : 'rendered'
    refresh()
  }, [active, refresh])

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void onSave()
    }
  }, [onSave])

  const onTextareaScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const pre = highlightRef.current
    const gutter = gutterRef.current
    const ta = e.currentTarget
    if (pre !== null) {
      pre.scrollTop = ta.scrollTop
      pre.scrollLeft = ta.scrollLeft
    }
    if (gutter !== null) gutter.scrollTop = ta.scrollTop
  }, [])

  const onTabDragStart = useCallback((e: ReactDragEvent<HTMLDivElement>, path: string) => {
    setDragPath(path)
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', path)
    } catch {
      /* some browsers restrict dataTransfer — ignore */
    }
  }, [])

  const onTabDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>, path: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragPath !== undefined && dragPath !== path) moveTab(dragPath, path)
  }, [dragPath])

  const onTabDragEnd = useCallback(() => {
    setDragPath(undefined)
  }, [])

  if (!isOpen) return null

  const renderBody = () => {
    if (activeData === undefined) return <div className={styles.previewHint}>{t('preview.loading')}</div>
    switch (activeData.status) {
      case 'loading':
        return <div className={styles.previewHint}>{t('preview.loading')}</div>
      case 'loaded':
        if (isMarkdown && activeData.view === 'rendered') {
          return (
            <div
              className={styles.mdPreview}
              dangerouslySetInnerHTML={{ __html: mdHtml }}
            />
          )
        }
        return (
          <div
            className={`${styles.editor}${plain ? ` ${styles.editorPlain}` : ''}`}
            data-wrap={wrap ? 'on' : 'off'}
          >
            <div ref={gutterRef} className={styles.gutter} aria-hidden="true">
              <div className={styles.gutterNumbers}>{gutterNumbers}</div>
            </div>
            {!plain && active !== undefined && (
              <pre ref={highlightRef} className={styles.editorHighlight} aria-hidden="true">
                <code dangerouslySetInnerHTML={{ __html: highlightCode(activeData.draft ?? '', active) }} />
              </pre>
            )}
            <textarea
              ref={textareaRef}
              className={styles.editorTextarea}
              value={activeData.draft ?? ''}
              onChange={(e) => onTextareaChange(e.target.value)}
              onScroll={onTextareaScroll}
              onKeyDown={onKeyDown}
              spellCheck={false}
              wrap={wrap ? 'soft' : 'off'}
            />
            {isMarkdown && !mdRenderable && <div className={styles.editorHint}>{t('preview.mdRenderOff')}</div>}
            {language !== undefined && !isMarkdown && tooBig && <div className={styles.editorHint}>{t('preview.highlightOff')}</div>}
            {saveError !== undefined && <div className={styles.saveError}>{saveError}</div>}
          </div>
        )
      case 'image': {
        const src = active !== undefined ? imageSrcOf(active) : undefined
        const name = active !== undefined ? basenameOf(active) : ''
        if (src === undefined) {
          return <div className={styles.previewHint}>{t('preview.binary')}</div>
        }
        if (imageFailed === active) {
          return (
            <div className={styles.previewHint}>
              <div>{t('preview.imageFailed')}</div>
              <div className={styles.previewMeta}>{name}</div>
            </div>
          )
        }
        return (
          <div className={styles.imageView}>
            <img
              className={styles.image}
              src={src}
              alt={name}
              onError={() => setImageFailed(active)}
            />
            <div className={styles.previewMeta}>{name}</div>
          </div>
        )
      }
      case 'binary':
        return (
          <div className={styles.previewHint}>
            <div>{t('preview.binary')}</div>
            <div className={styles.previewMeta}>{formatSize(activeData.size)}</div>
          </div>
        )
      case 'too-large':
        return (
          <div className={styles.previewHint}>
            <div>{t('preview.tooLarge', { limit: PREVIEW_TOO_LARGE_LABEL })}</div>
            <div className={styles.previewMeta}>{formatSize(activeData.size)}</div>
          </div>
        )
      case 'error':
        return (
          <div className={styles.previewHint}>
            <div>{t('preview.error')}</div>
            <div className={styles.previewMeta}>{activeData.message}</div>
          </div>
        )
    }
  }

  const previewClassName = closing && tabs.length === 0
    ? `${styles.preview} ${styles.previewClosing}`
    : styles.preview

  return (
    <>
      <div
        ref={previewRef}
        className={previewClassName}
        style={previewWidth !== null ? { flex: `0 0 ${previewWidth}px` } : undefined}
        data-pane="explorer-preview"
        data-fe-theme={theme}
      >
        {tabs.length > 0 && (
          <div className={styles.tabBar}>
            <div className={styles.tabScroller}>
              {tabs.map((path) => {
                const data = cacheRef.current.get(path)
                return (
                  <div
                    key={path}
                    className={`${styles.tab} ${path === active ? styles.tabActive : ''}`}
                    onClick={() => activateFile(path)}
                    draggable
                    onDragStart={(e) => onTabDragStart(e, path)}
                    onDragOver={(e) => onTabDragOver(e, path)}
                    onDragEnd={onTabDragEnd}
                    title={path}
                  >
                    <span className={styles.tabIcon}><FileIcon name={basenameOf(path)} /></span>
                    <span className={styles.tabName}>{basenameOf(path)}</span>
                    {data?.dirty === true && <span className={styles.tabDot} />}
                    {data?.diskChanged === true && (
                      <button
                        type="button"
                        className={styles.tabDiskBadge}
                        title={t('tab.diskChanged')}
                        onClick={(e) => {
                          e.stopPropagation()
                          void reloadFromDisk(path)
                        }}
                      >
                        {'⟳'}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.tabClose}
                      title={t('tab.close')}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeFile(path)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
            {isMarkdown && activeData?.status === 'loaded' && mdRenderable && (
              <button
                type="button"
                className={styles.tabAction}
                title={activeData.view === 'rendered' ? t('action.mdSource') : t('action.mdRender')}
                onClick={toggleMdView}
              >
                {activeData.view === 'rendered' ? '📝' : '👁'}
              </button>
            )}
            <button
              type="button"
              className={`${styles.tabAction}${wrap ? ` ${styles.tabActionActive}` : ''}`}
              title={wrap ? t('action.wrapOff') : t('action.wrapOn')}
              onClick={toggleWrap}
            >
              {'⤶'}
            </button>
            <button
              type="button"
              className={styles.collapse}
              title={t('tab.collapse')}
              onClick={collapsePreview}
            >
              {'<'}
            </button>
          </div>
        )}
        <div className={styles.previewBody}>{renderBody()}</div>
      </div>
      <div ref={handleRef} className={styles.handle} onPointerDown={onHandleDown} role="separator" aria-orientation="vertical" />
    </>
  )
}
