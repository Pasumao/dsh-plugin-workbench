/**
 * File-type icons for the explorer tree rows and the preview tabs.
 *
 * Code/config files render as small colored badges with an extension label
 * (VS Code "Minimal"-theme style); media, archives and installer files use
 * emoji; anything unknown falls back to a generic document glyph. No icon
 * assets are shipped — badges are pure CSS (per-language colors) and emoji
 * come from the platform font.
 */
import styles from './files.module.css'

interface BadgeSpec {
  label: string
  bg: string
  fg: string
}

/** lowercase extension (no dot) → badge colors. */
const BADGES: Record<string, BadgeSpec> = {
  // code
  ts: { label: 'TS', bg: '#3178c6', fg: '#ffffff' },
  mts: { label: 'TS', bg: '#3178c6', fg: '#ffffff' },
  cts: { label: 'TS', bg: '#3178c6', fg: '#ffffff' },
  tsx: { label: 'TSX', bg: '#61dafb', fg: '#06283d' },
  js: { label: 'JS', bg: '#f7df1e', fg: '#1e1e1e' },
  mjs: { label: 'JS', bg: '#f7df1e', fg: '#1e1e1e' },
  cjs: { label: 'JS', bg: '#f7df1e', fg: '#1e1e1e' },
  jsx: { label: 'JSX', bg: '#61dafb', fg: '#06283d' },
  json: { label: '{}', bg: '#cbcb41', fg: '#1e1e1e' },
  jsonc: { label: '{}', bg: '#cbcb41', fg: '#1e1e1e' },
  html: { label: 'HTML', bg: '#e44d26', fg: '#ffffff' },
  htm: { label: 'HTML', bg: '#e44d26', fg: '#ffffff' },
  css: { label: 'CSS', bg: '#2965f1', fg: '#ffffff' },
  scss: { label: 'SCSS', bg: '#cc6699', fg: '#ffffff' },
  less: { label: 'LESS', bg: '#2a4d80', fg: '#ffffff' },
  md: { label: 'MD', bg: '#519aba', fg: '#ffffff' },
  markdown: { label: 'MD', bg: '#519aba', fg: '#ffffff' },
  py: { label: 'PY', bg: '#3572a5', fg: '#ffffff' },
  pyw: { label: 'PY', bg: '#3572a5', fg: '#ffffff' },
  go: { label: 'GO', bg: '#00add8', fg: '#06283d' },
  rs: { label: 'RS', bg: '#dea584', fg: '#1e1e1e' },
  java: { label: 'JAVA', bg: '#b07219', fg: '#ffffff' },
  c: { label: 'C', bg: '#6e6e6e', fg: '#ffffff' },
  h: { label: 'H', bg: '#6e6e6e', fg: '#ffffff' },
  cpp: { label: 'CPP', bg: '#f34b7d', fg: '#ffffff' },
  cc: { label: 'CPP', bg: '#f34b7d', fg: '#ffffff' },
  cxx: { label: 'CPP', bg: '#f34b7d', fg: '#ffffff' },
  hpp: { label: 'HPP', bg: '#f34b7d', fg: '#ffffff' },
  hxx: { label: 'HPP', bg: '#f34b7d', fg: '#ffffff' },
  cs: { label: 'CS', bg: '#178600', fg: '#ffffff' },
  sh: { label: 'SH', bg: '#89e051', fg: '#1e1e1e' },
  bash: { label: 'SH', bg: '#89e051', fg: '#1e1e1e' },
  zsh: { label: 'SH', bg: '#89e051', fg: '#1e1e1e' },
  ps1: { label: 'PS1', bg: '#012456', fg: '#ffffff' },
  psm1: { label: 'PS1', bg: '#012456', fg: '#ffffff' },
  psd1: { label: 'PS1', bg: '#012456', fg: '#ffffff' },
  bat: { label: 'BAT', bg: '#6e6e6e', fg: '#ffffff' },
  cmd: { label: 'BAT', bg: '#6e6e6e', fg: '#ffffff' },
  sql: { label: 'SQL', bg: '#e38c00', fg: '#ffffff' },
  yml: { label: 'YML', bg: '#cb171e', fg: '#ffffff' },
  yaml: { label: 'YML', bg: '#cb171e', fg: '#ffffff' },
  toml: { label: 'TOML', bg: '#8b8b8b', fg: '#ffffff' },
  ini: { label: 'INI', bg: '#8b8b8b', fg: '#ffffff' },
  conf: { label: 'INI', bg: '#8b8b8b', fg: '#ffffff' },
  cfg: { label: 'INI', bg: '#8b8b8b', fg: '#ffffff' },
  xml: { label: 'XML', bg: '#a074c4', fg: '#ffffff' },
  xsl: { label: 'XML', bg: '#a074c4', fg: '#ffffff' },
  svg: { label: 'SVG', bg: '#e37933', fg: '#ffffff' },
  vue: { label: 'VUE', bg: '#41b883', fg: '#06283d' },
  lock: { label: 'LOCK', bg: '#9d9d9d', fg: '#1e1e1e' },
  env: { label: 'ENV', bg: '#f05033', fg: '#ffffff' },
  gitignore: { label: 'GIT', bg: '#f05033', fg: '#ffffff' },
  gitattributes: { label: 'GIT', bg: '#f05033', fg: '#ffffff' },
  gitmodules: { label: 'GIT', bg: '#f05033', fg: '#ffffff' },
  editorconfig: { label: 'CFG', bg: '#8b8b8b', fg: '#ffffff' },
  npmrc: { label: 'CFG', bg: '#8b8b8b', fg: '#ffffff' },
  pnpmrc: { label: 'CFG', bg: '#8b8b8b', fg: '#ffffff' },
  yarnrc: { label: 'CFG', bg: '#8b8b8b', fg: '#ffffff' },
  mk: { label: 'MK', bg: '#6d8086', fg: '#ffffff' },
  makefile: { label: 'MK', bg: '#6d8086', fg: '#ffffff' },
  txt: { label: 'TXT', bg: '#9d9d9d', fg: '#ffffff' },
  log: { label: 'TXT', bg: '#9d9d9d', fg: '#ffffff' },
  pdf: { label: 'PDF', bg: '#e74c3c', fg: '#ffffff' },
}

/** lowercase extension (no dot) → emoji glyph. */
const EMOJI: Record<string, string> = {
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', bmp: '🖼️', ico: '🖼️', avif: '🖼️', jfif: '🖼️', tif: '🖼️', tiff: '🖼️',
  mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', oga: '🎵', m4a: '🎵', aac: '🎵', wma: '🎵', opus: '🎵', mid: '🎵',
  mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬', flv: '🎬', wmv: '🎬', m4v: '🎬', mpg: '🎬', mpeg: '🎬',
  zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️', bz2: '🗜️', xz: '🗜️', tgz: '🗜️', tbz2: '🗜️', zst: '🗜️',
  doc: '📘', docx: '📘', odt: '📘', rtf: '📘',
  xls: '📗', xlsx: '📗', ods: '📗', csv: '📗',
  ppt: '📙', pptx: '📙', odp: '📙',
  epub: '📖', mobi: '📖',
  exe: '📦', msi: '📦', dmg: '📦', app: '📦', deb: '📦', rpm: '📦', apk: '📦', iso: '📦',
}

/** Well-known extension-less names (lowercase) → emoji. */
const NAMED_EMOJI: Record<string, string> = {
  dockerfile: '🐳',
}

export type FileIconSpec =
  | { kind: 'badge'; label: string; bg: string; fg: string }
  | { kind: 'emoji'; char: string }

/** Resolve a file name to its icon spec (badge colors or an emoji glyph). */
export function fileIconFor(name: string): FileIconSpec {
  const lower = name.trim().toLowerCase()
  if (lower === '') return { kind: 'emoji', char: '📄' }

  const namedEmoji = NAMED_EMOJI[lower]
  if (namedEmoji !== undefined) return { kind: 'emoji', char: namedEmoji }

  // Dotfiles use the dotted remainder as the key (`.gitignore` → gitignore,
  // `.env.local` → env), regular files use the last extension segment.
  let key: string
  if (lower.startsWith('.')) {
    const rest = lower.slice(1)
    key = rest.startsWith('env.') ? 'env' : rest
  } else {
    const dot = lower.lastIndexOf('.')
    key = dot > 0 ? lower.slice(dot + 1) : lower
  }

  const badge = BADGES[key]
  if (badge !== undefined) return { kind: 'badge', label: badge.label, bg: badge.bg, fg: badge.fg }
  const emoji = EMOJI[key]
  if (emoji !== undefined) return { kind: 'emoji', char: emoji }
  return { kind: 'emoji', char: '📄' }
}

/** Render a file's icon: a colored extension badge or an emoji glyph. */
export function FileIcon({ name }: { name: string }) {
  const icon = fileIconFor(name)
  if (icon.kind === 'emoji') return <>{icon.char}</>
  const className = icon.label.length >= 4 ? `${styles.fileBadge} ${styles.fileBadgeLong}` : styles.fileBadge
  return (
    <span className={className} style={{ background: icon.bg, color: icon.fg }}>
      {icon.label}
    </span>
  )
}
