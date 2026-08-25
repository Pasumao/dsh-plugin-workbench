/**
 * Composer @-mention hyperlink enhancement.
 *
 * The composer's visible text lives in a core-rendered backdrop (`textarea`
 * text is transparent) that React re-renders on every keystroke, so plugin
 * code must not mutate it. Instead this module renders its OWN overlay — an
 * absolutely-positioned copy of the draft, in the same font/padding/wrap
 * metrics as the textarea (copied from the core `.input,.mirror,.backdrop`
 * rule), with every `@.\`-style mention drawn in the link color and
 * underlined. The overlay's plain text is fully transparent, so the visible
 * glyphs still come from the core backdrop; mention spans paint on top at the
 * identical position (same metrics => same layout), which shows the mention as
 * a real hyperlink inside the chat input.
 *
 * The overlay is appended directly to the core `.grow` container (a sibling
 * of the backdrop/mirror) — React never manages nodes it did not create, and
 * the overlay is `position:absolute;inset:0` so it always tracks the input
 * box, including scroll inside `[data-input-scroll]`. It re-syncs whenever the
 * core `[data-input-mirror]` text changes (a React-written text node, so it
 * updates for typing AND programmatic inserts such as the core `@` menu or
 * this plugin's own insertIntoComposer).
 *
 * Interaction: Ctrl/Cmd+click inside the composer textarea opens the mention
 * under the caret in the workbench preview (the visible link is a decoration;
 * the real input gains the click), mirroring the rendered-message linkifier.
 */
import { openMention } from './composer'
import { findMentions } from './mentions'

/** One-time install guard (the client bundle re-applies on HMR). */
let installed = false

/** Style-tag guard (the bundle may re-apply on HMR). */
let styleInstalled = false

const OVERLAY_CSS = [
  // Layout metrics must match the core rule for `.input,.mirror,.backdrop`
  // exactly, so the overlay's invisible text wraps identically to the visible
  // backdrop text and mentions paint at the right place.
  '[data-wb-composer-mention-overlay]{position:absolute;inset:0;overflow:hidden;pointer-events:none;box-sizing:border-box;font-family:var(--dsw-font-family);font-size:inherit;line-height:inherit;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;padding:4px 12px 0 16px;color:transparent}',
  '[data-wb-composer-mention-overlay][hidden]{display:none}',
  '.dswb-composer-mention{color:var(--dsw-alias-state-business-primary);-webkit-text-fill-color:var(--dsw-alias-state-business-primary);text-decoration:underline;text-underline-offset:2px}',
].join('')

function installStyle(): void {
  if (styleInstalled || typeof document === 'undefined') return
  styleInstalled = true
  const tagId = 'dsh-plugin-workbench/composer-mention.module.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-plugin-workbench'
    tag.dataset.pluginCss = tagId
    tag.textContent = OVERLAY_CSS
    document.head.appendChild(tag)
  }
}

/** The overlay element for the currently visible composer, or null. */
let overlayEl: HTMLElement | null = null

/** Last draft rendered into the overlay (avoids re-rendering on own mutations). */
let lastDraft: string | null = null

/** Create (once per composer instance) and return the overlay inside `.grow`. */
function ensureOverlay(): HTMLElement | null {
  const seat = document.querySelector('[data-composer-seat]')
  if (seat === null) return null
  const mirror = seat.querySelector<HTMLElement>('[data-input-mirror]')
  const grow = mirror?.parentElement
  if (grow === null || grow === undefined) return null
  let overlay = grow.querySelector<HTMLElement>('[data-wb-composer-mention-overlay]')
  if (overlay === null) {
    overlay = document.createElement('div')
    overlay.dataset.wbComposerMentionOverlay = ''
    overlay.setAttribute('aria-hidden', 'true')
    grow.appendChild(overlay)
  }
  if (overlayEl !== overlay) {
    overlayEl = overlay
    lastDraft = null
  }
  return overlay
}

/** Render the (transparent) draft with mention spans into the overlay. */
function render(overlay: HTMLElement, draft: string): void {
  const hits = findMentions(draft)
  if (hits.length === 0) {
    overlay.hidden = true
    return
  }
  overlay.hidden = false
  const frag = document.createDocumentFragment()
  let cursor = 0
  for (const hit of hits) {
    if (hit.start > cursor) frag.appendChild(document.createTextNode(draft.slice(cursor, hit.start)))
    const span = document.createElement('span')
    span.className = 'dswb-composer-mention'
    span.dataset.wbMention = hit.mention
    span.textContent = draft.slice(hit.start, hit.end)
    frag.appendChild(span)
    cursor = hit.end
  }
  if (cursor < draft.length) frag.appendChild(document.createTextNode(draft.slice(cursor)))
  overlay.replaceChildren(frag)
}

/** Re-sync the overlay with the composer draft (cheap no-op when unchanged). */
function sync(): void {
  const seat = document.querySelector('[data-composer-seat]')
  if (seat === null) return
  // Skip the hero workspace picker / disabled states — only a usable input gets decorated.
  if (seat.querySelector('textarea:not([disabled]):not([readonly])') === null) return
  const mirror = seat.querySelector<HTMLElement>('[data-input-mirror]')
  const overlay = ensureOverlay()
  if (mirror === null || overlay === null) return
  // The mirror renders `${draft}\n`; strip exactly that trailing newline.
  const draft = (mirror.textContent ?? '').replace(/\n$/, '')
  if (draft === lastDraft) return
  lastDraft = draft
  render(overlay, draft)
}

/** Ctrl/Cmd+click on the composer: open the mention under the caret. */
function onDocumentClick(e: MouseEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return
  const target = e.target
  if (!(target instanceof HTMLTextAreaElement)) return
  if (target.closest('[data-composer-seat]') === null) return
  // The caret has already moved to the clicked character when click fires.
  const pos = target.selectionStart
  const draft = target.value
  const hits = findMentions(draft)
  let hit = hits.find((h) => pos >= h.start && pos <= h.end)
  if (hit === undefined) hit = hits.find((h) => pos - 1 >= h.start && pos - 1 < h.end)
  if (hit === undefined) return
  e.preventDefault()
  e.stopPropagation()
  openMention(hit.mention)
}

/** Start the composer mention overlay + Ctrl+click opener (idempotent). */
export function installComposerMentions(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => undefined
  if (installed) return () => undefined
  installed = true
  installStyle()
  document.addEventListener('click', onDocumentClick)
  let pending = false
  const scan = (): void => {
    pending = false
    sync()
  }
  const observer = new MutationObserver(() => {
    if (pending) return
    pending = true
    requestAnimationFrame(scan)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  scan()
  return () => {
    observer.disconnect()
    document.removeEventListener('click', onDocumentClick)
    installed = false
  }
}
