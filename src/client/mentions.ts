/**
 * @-mention linkifier for the conversation.
 *
 * The workbench inserts `@<relative-workspace-path>` into the composer (menu
 * gesture "在消息中引用"), and this module makes the mention VISIBLE as a
 * hyperlink once the message is rendered: any `@` followed by a token that
 * matches the mention grammar is wrapped in an anchor, and clicking it opens
 * the file in the workbench preview.
 *
 * Grammar (anything else stays plain text with no special meaning):
 *   - `@` must sit at a token boundary (start of text, whitespace, or
 *     punctuation like `（(` `，,` `。.` quotes and brackets) — so `user@x`,
 *     `a.b@c` and URLs never match;
 *   - the token is the longest run of non-whitespace, non-`@` characters,
 *     with trailing sentence punctuation trimmed (`.。 ,， ;； :： !！ ?？ )）`…);
 *   - the remaining token must be a RELATIVE path (never drive-absolute or
 *     leading-slash), and path-shaped: either contains a `/` or `\` directory
 *     separator, or is a single segment ending in a file extension.
 *
 * Scanning mirrors the table-zoom enhancer: a MutationObserver on
 * `document.body`, rAF-coalesced, walks the text nodes of every
 * `[data-conversation-scroll]` subtree and skips protected containers
 * (code blocks, existing links, aria-hidden overlays like the composer
 * mirror/backdrop, the composer seat, popups, and the workbench column).
 */
import { openMention } from './composer'

/** Mention pattern: `@` + token (no whitespace, no embedded `@`). */
const MENTION_RE = /@([^\s@]+)/g

/** Trailing characters trimmed from a mention token before validation. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '。', '，', '；', '：', '！', '？', ')', '）', ']', '】', '}', '》', '」', '』', '"', "'"])

/** Characters that may legally precede `@` in a mention (start/whitespace/punctuation). */
function isBoundaryBefore(ch: string | undefined): boolean {
  if (ch === undefined) return true
  // NOTE: `]` is escaped — an unescaped `]` inside a character class ends it
  // early and silently turns the rest into required literal matches.
  return /[\s(（[【「『"'`、，。；：！？,.!?:;>\])}）]/.test(ch)
}

/** Whether `token` (already trailing-trimmed) matches the relative-path grammar. */
export function isMentionToken(token: string): boolean {
  if (token.length === 0) return false
  // Sentence punctuation inside the token means following text bled into the
  // mention (e.g. "@src/index.ts。谢谢"): that is plain text, not a path.
  // Sentence punctuation at the END is trimmed before this check.
  if (/[。，、；：！？（）、【】「」『』《》]/.test(token)) return false
  // Relative only: no drive prefix, no leading separator, no leading dot-dot.
  if (/^[A-Za-z]:[\\/]/.test(token)) return false
  if (token.startsWith('/') || token.startsWith('\\')) return false
  if (token.startsWith('..')) return false
  // Path-shaped: a directory separator anywhere, or a single file segment
  // with an extension.
  if (token.includes('/') || token.includes('\\')) return true
  return /^[^\\/]+\.[A-Za-z0-9_][A-Za-z0-9._~+-]*$/.test(token)
}

/** Trim trailing sentence punctuation from a raw mention token. */
export function trimMentionToken(raw: string): string {
  let token = raw
  while (token.length > 0 && TRAILING.has(token[token.length - 1])) {
    token = token.slice(0, -1)
  }
  return token
}

/**
 * Extract every valid mention from `text` as [start, end, mention] ranges.
 * `end` covers `@` + the TRIMMED token (trailing punctuation stays outside the
 * link). Pure and testable: the DOM walk uses it and then splits the text node.
 */
export function findMentions(text: string): Array<{ start: number; end: number; mention: string }> {
  const hits: Array<{ start: number; end: number; mention: string }> = []
  MENTION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MENTION_RE.exec(text)) !== null) {
    const at = match.index
    const raw = match[1]
    if (!isBoundaryBefore(at > 0 ? text[at - 1] : undefined)) continue
    const token = trimMentionToken(raw)
    if (!isMentionToken(token)) continue
    hits.push({ start: at, end: at + 1 + token.length, mention: token })
  }
  return hits
}

/** Containers whose text is never linkified (code, existing links, overlays). */
const SKIP_SELECTOR = [
  'code',
  'pre',
  'a',
  'script',
  'style',
  'textarea',
  '[data-composer-seat]',
  '[data-input-mirror]',
  '[data-input-backdrop]',
  '[data-pane="explorer"]',
  '[aria-hidden="true"]',
  '.dstz-popup',
  '.dshpick-lightbox',
  '[data-wb-mention]',
].join(',')

/** Walk the text nodes of one conversation scroll container and linkify. */
function linkifyRoot(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const toCheck: Text[] = []
  let node: Node | null = walker.nextNode()
  while (node !== null) {
    if (node.parentElement !== null && node.parentElement.closest(SKIP_SELECTOR) === null) {
      toCheck.push(node as Text)
    }
    node = walker.nextNode()
  }
  for (const textNode of toCheck) {
    linkifyTextNode(textNode)
  }
}

/** Wrap every mention in one text node; returns true when anything changed. */
function linkifyTextNode(node: Text): boolean {
  const text = node.data
  const hits = findMentions(text)
  if (hits.length === 0) return false
  const frag = document.createDocumentFragment()
  let cursor = 0
  for (const hit of hits) {
    if (hit.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, hit.start)))
    const anchor = document.createElement('a')
    anchor.className = 'dswb-mention'
    anchor.dataset.wbMention = hit.mention
    anchor.textContent = text.slice(hit.start, hit.end)
    anchor.title = `@${hit.mention}`
    frag.appendChild(anchor)
    cursor = hit.end
  }
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
  node.parentNode?.replaceChild(frag, node)
  return true
}

/** Style tag guard (the bundle may re-apply on HMR). */
let styleInstalled = false

const MENTION_CSS = [
  '.dswb-mention{color:var(--dsw-alias-state-business-primary);text-decoration:underline;text-underline-offset:2px;cursor:pointer;border-radius:4px;padding:0 1px}',
  '.dswb-mention:hover{background:var(--dsw-alias-interactive-bg-hover)}',
].join('')

function installStyle(): void {
  if (styleInstalled || typeof document === 'undefined') return
  styleInstalled = true
  const tagId = 'dsh-plugin-workbench/mention.module.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-plugin-workbench'
    tag.dataset.pluginCss = tagId
    tag.textContent = MENTION_CSS
    document.head.appendChild(tag)
  }
}

/** Click handler: open the mentioned file in the workbench preview. */
function onDocumentClick(e: MouseEvent): void {
  const target = e.target
  if (!(target instanceof Element)) return
  const anchor = target.closest('a.dswb-mention')
  if (anchor === null) return
  const mention = anchor.getAttribute('data-wb-mention')
  if (mention === null) return
  e.preventDefault()
  e.stopPropagation()
  openMention(mention)
}

/** One-time install guard (HMR re-applies must not double-observe). */
let linkifierInstalled = false

/** Start the linkifier: initial scan + MutationObserver with rAF coalescing. */
export function installMentionLinkifier(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => undefined
  if (linkifierInstalled) return () => undefined
  linkifierInstalled = true
  installStyle()
  document.addEventListener('click', onDocumentClick)
  let pending = false
  const scan = (): void => {
    pending = false
    for (const root of document.querySelectorAll<HTMLElement>('[data-conversation-scroll]')) {
      linkifyRoot(root)
    }
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
    linkifierInstalled = false
  }
}
