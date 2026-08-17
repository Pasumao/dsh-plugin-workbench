/** Locale namespace and dictionaries for the files-explorer column. */

export const NS = 'files'

export const zh = {
  'placeholder.noSession': '暂无会话',
  'placeholder.noCwd': '当前会话没有工作目录',
  'action.refresh': '刷新',
  'action.open': '在系统中打开',
  'action.theme': '切换浅色/暗色主题',
  'action.saveHint': 'Ctrl+S 保存',
  'action.wrapOn': '开启自动换行（显示层换行，不改文件）',
  'action.wrapOff': '关闭自动换行（长行横向滚动）',
  'tab.close': '关闭标签页',
  'tab.collapse': '收起文件详情',
  'tab.expand': '弹出文件详情',
  'preview.loading': '加载中…',
  'preview.binary': '二进制文件，无法预览',
  'preview.tooLarge': '文件过大，仅支持预览不超过 {limit}',
  'preview.emptyDir': '空目录',
  'preview.error': '加载失败',
  'preview.highlightOff': '大文件：已关闭语法高亮（仍可编辑）',
} as const

export type FilesKey = keyof typeof zh

export const en: Record<FilesKey, string> = {
  'placeholder.noSession': 'No session',
  'placeholder.noCwd': 'No working directory for this session',
  'action.refresh': 'Refresh',
  'action.open': 'Open in system',
  'action.theme': 'Toggle light/dark theme',
  'action.saveHint': 'Ctrl+S to save',
  'action.wrapOn': 'Enable word wrap (display only, file unchanged)',
  'action.wrapOff': 'Disable word wrap (long lines scroll horizontally)',
  'tab.close': 'Close tab',
  'tab.collapse': 'Collapse file details',
  'tab.expand': 'Expand file details',
  'preview.loading': 'Loading…',
  'preview.binary': 'Binary file, cannot preview',
  'preview.tooLarge': 'File too large to preview (limit {limit})',
  'preview.emptyDir': 'Empty directory',
  'preview.error': 'Load failed',
  'preview.highlightOff': 'Large file: syntax highlighting off (still editable)',
}
