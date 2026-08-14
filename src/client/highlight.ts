/**
 * Syntax highlighting for the file preview. Uses highlight.js core with a
 * hand-picked set of common languages so the bundle stays lean; unknown
 * languages fall back to plain (HTML-escaped) text.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('css', css)
hljs.registerLanguage('go', go)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python',
  json: 'json', jsonc: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'css', less: 'css',
  md: 'markdown', markdown: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  java: 'java',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  yml: 'yaml', yaml: 'yaml',
  ini: 'ini', conf: 'ini',
}

/** Map a file path to a registered highlight.js language id, or undefined. */
export function detectLanguage(path: string): string | undefined {
  const idx = path.lastIndexOf('.')
  if (idx < 0) return undefined
  const ext = path.slice(idx + 1).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Highlight code for a file; returns safe HTML (code is HTML-escaped). */
export function highlightCode(code: string, path: string): string {
  const language = detectLanguage(path)
  if (language !== undefined && hljs.getLanguage(language) !== undefined) {
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    } catch {
      // fall through to plain text
    }
  }
  return escapeHtml(code)
}
