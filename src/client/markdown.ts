/**
 * Markdown rendering for the file preview.
 *
 * markdown-it with raw HTML disabled (escaped, never executed — same
 * no-unsafe-HTML stance as every other preview in this plugin), linkified
 * text, and fenced code blocks highlighted through the highlight.js languages
 * registered in ./highlight. Relative image srcs are rewritten onto the
 * plugin's raw-bytes route (the same one image tabs use), resolved against the
 * markdown file's own directory, so README images render next to their file.
 */
import MarkdownIt from 'markdown-it'
import { canHighlight, highlightFence } from './highlight'

/** Same-origin raw-bytes route registered by the host half (see src/index.ts). */
const RAW_PREFIX = '/dsh-plugin-files/raw'

/** srcs that pass through unchanged: scheme URLs, anchors, protocol-relative. */
const ABSOLUTE_SRC = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i

const md = new MarkdownIt({
  // Raw HTML in the source is escaped, never rendered (XSS containment).
  html: false,
  linkify: true,
  typographer: true,
  highlight: (code: string, lang: string): string => {
    // Empty return lets markdown-it apply its own default escaping.
    if (!canHighlight(lang)) return ''
    return `<pre class="hljs"><code>${highlightFence(code, lang)}</code></pre>`
  },
})

// Relative image srcs resolve against the md file's directory and are served
// through the raw-bytes route; absolute URLs / data URIs pass through.
const defaultImage = md.renderer.rules.image
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const src = String(token.attrGet('src') ?? '')
  const base = typeof env === 'object' && env !== null && typeof (env as { base?: unknown }).base === 'string'
    ? (env as { base: string }).base
    : ''
  if (src !== '' && !ABSOLUTE_SRC.test(src) && base !== '') {
    const resolved = base.endsWith('/') || base.endsWith('\\') ? base + src : `${base}/${src}`
    token.attrSet('src', `${RAW_PREFIX}/${encodeURIComponent(resolved)}`)
  }
  return defaultImage(tokens, idx, options, env, self)
}

// markdown-it does not sanitize link protocols: a hostile .md file could carry
// `[x](javascript:…)`. Follow markdown-it's default policy — reject the
// vbscript/javascript/file/data schemes (data:image/* stays allowed so data-URI
// images keep working); relative URLs pass through unchanged, and rejected
// links render as inert text. Raw HTML is escaped above (html: false), so no
// script/iframe can pass through either.
const BAD_LINK_PROTOCOL = /^(?:vbscript|javascript|file|data):/i
const GOOD_DATA_IMAGE = /^data:image\/(?:gif|png|jpeg|webp);/i
md.validateLink = (url: string): boolean => {
  const trimmed = url.trim()
  return !BAD_LINK_PROTOCOL.test(trimmed) || GOOD_DATA_IMAGE.test(trimmed)
}

/**
 * Render markdown content to safe HTML.
 * @param content - raw markdown text.
 * @param baseDir - directory of the source file, used to resolve relative
 *   image paths ('' when there is none).
 */
export function renderMarkdown(content: string, baseDir: string): string {
  return md.render(content, { base: baseDir })
}
