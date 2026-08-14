/**
 * Split file preview with VS Code-style tabs and a directly-editable editor.
 * Files open in tabs; the active tab is an always-editable textarea overlaid on
 * a syntax-highlighted layer (Ctrl/Cmd+S saves). Tabs are drag-reorderable.
 * Opening/closing the first/last tab is animated.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import styles from './files.module.css'
import { highlightCode } from './highlight'
import type { FilesKey } from './locales'
import { activateFile, closeFile, collapsePreview, moveTab, useTabsState } from './store'
import type { FsReadResult } from './FileExplorer'

interface TabData {
  status: 'loading' | 'loaded' | 'binary' | 'too-large' | 'error'
  content?: string
  draft?: string
  dirty?: boolean
  size?: number
  message?: string
}

export interface FsWriteResult {
  path: string
  size: number
}

export interface FilePreviewProps {
  t: (key: FilesKey, params?: Record<string, unknown>) => string
  readFile: (path: string, signal?: AbortSignal) => Promise<FsReadResult>
  writeFile: (path: string, content: string, signal?: AbortSignal) => Promise<FsWriteResult>
}

const PREVIEW_MIN = 240
const CHAT_MIN = 240
const PREVIEW_TOO_LARGE_LABEL = '512KB'

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function previewDataOf(result: FsReadResult): TabData {
  if (result.truncated) return { status: 'too-large', size: result.size }
  if (result.binary) return { status: 'binary', size: result.size }
  return { status: 'loaded', content: result.content, draft: result.content, dirty: false, size: result.size }
}

export function FilePreview({ t, readFile, writeFile }: FilePreviewProps) {
  const { tabs, active, theme, collapsed } = useTabsState()

  const [previewWidth, setPreviewWidth] = useState<number | null>(null)
  const [closing, setClosing] = useState(false)
  const [dragPath, setDragPath] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)

  const cacheRef = useRef<Map<string, TabData>>(new Map())
  const hasOpenedRef = useRef(false)
  const [, bump] = useState(0)

  const previewRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)

  const refresh = useCallback(() => bump((v) => v + 1), [])

  // Read newly opened tabs and drop cache entries for closed tabs.
  useEffect(() => {
    const cache = cacheRef.current
    for (const [path] of cache) {
      if (!tabs.includes(path)) cache.delete(path)
    }
    const controllers: AbortController[] = []
    for (const path of tabs) {
      if (cache.has(path)) continue
      cache.set(path, { status: 'loading' })
      const controller = new AbortController()
      controllers.push(controller)
      readFile(path, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            cache.set(path, previewDataOf(result))
            refresh()
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            cache.set(path, { status: 'error', message: error instanceof Error ? error.message : String(error) })
            refresh()
          }
        })
    }
    refresh()
    return () => controllers.forEach((c) => c.abort())
  }, [tabs, readFile, refresh])

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

  const onHandleDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = handleRef.current
    const preview = previewRef.current
    if (handle === null || preview === null) return
    const center = handle.parentElement
    if (center === null) return
    const startX = e.clientX
    const startWidth = preview.getBoundingClientRect().width
    const centerWidth = center.getBoundingClientRect().width
    const max = Math.max(PREVIEW_MIN, centerWidth - CHAT_MIN)
    const onMove = (ev: PointerEvent) => {
      setPreviewWidth(clamp(startWidth + ev.clientX - startX, PREVIEW_MIN, max))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
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

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void onSave()
    }
  }, [onSave])

  const onTextareaScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const pre = highlightRef.current
    const ta = e.currentTarget
    if (pre !== null) {
      pre.scrollTop = ta.scrollTop
      pre.scrollLeft = ta.scrollLeft
    }
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

  const activeData = active !== undefined ? cacheRef.current.get(active) : undefined

  if (!isOpen) return null

  const renderBody = () => {
    if (activeData === undefined) return <div className={styles.previewHint}>{t('preview.loading')}</div>
    switch (activeData.status) {
      case 'loading':
        return <div className={styles.previewHint}>{t('preview.loading')}</div>
      case 'loaded': {
        const highlighted = active !== undefined ? highlightCode(activeData.draft ?? '', active) : ''
        return (
          <div className={styles.editor}>
            <pre ref={highlightRef} className={styles.editorHighlight} aria-hidden="true">
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
            <textarea
              className={styles.editorTextarea}
              value={activeData.draft ?? ''}
              onChange={(e) => onTextareaChange(e.target.value)}
              onScroll={onTextareaScroll}
              onKeyDown={onKeyDown}
              spellCheck={false}
              wrap="off"
              title={t('action.saveHint')}
            />
            {saveError !== undefined && <div className={styles.saveError}>{saveError}</div>}
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
                    <span className={styles.tabName}>{basenameOf(path)}</span>
                    {data?.dirty === true && <span className={styles.tabDot} />}
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
