#!/usr/bin/env node
/**
 * Patch the compiled dsh-client-ui-layout client bundle to add a fourth
 * "explorer" column (sidebar | explorer | center | details), its slot
 * declaration, the layout-store panel, and a drag handle.
 *
 * The bundle is a compiled artifact (no source checkout on this machine), so
 * this script performs precise, idempotent string replacements and verifies
 * every anchor landed. It backs up the original before the first write.
 *
 * Usage:
 *   node scripts/patch-layout.mjs [--target <abs path to client.js>] [--force]
 *
 * Default target resolves the profile junction to its npx-cache copy:
 *   <DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BACKUP_DIR = join(REPO_ROOT, 'patches', 'layout.backup')

const args = process.argv.slice(2)
const targetArg = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined
const force = args.includes('--force')

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const defaultTarget = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js')

/** @param {string[]} lines */
const L = (...lines) => lines.join('\n')

/** One precise replacement: `anchor` must occur exactly once in the file. */
const REPLACEMENTS = [
  {
    id: 'css.explorerCol.rule',
    anchor: '.pI_x6G_detailsCol{border-left:1px solid var(--dsw-alias-border-l2);min-width:0;overflow:hidden}',
    replacement: '.pI_x6G_detailsCol{border-left:1px solid var(--dsw-alias-border-l2);min-width:0;overflow:hidden}.pI_x6G_explorerCol{background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);min-width:0;overflow:hidden}',
  },
  {
    id: 'css.explorerCol.handleContent',
    anchor: '.pI_x6G_handle[data-side=details]:after{',
    replacement: '.pI_x6G_handle[data-side=details]:after,.pI_x6G_handle[data-side=explorer]:after{',
  },
  {
    id: 'css.explorerCol.handleOpacity',
    anchor: '.pI_x6G_detailsCol:hover~.pI_x6G_handle[data-side=details]:after,.pI_x6G_handle[data-side=details]:hover:after,.pI_x6G_handle[data-side=details][data-dragging=true]:after{opacity:1}',
    replacement: '.pI_x6G_detailsCol:hover~.pI_x6G_handle[data-side=details]:after,.pI_x6G_handle[data-side=details]:hover:after,.pI_x6G_handle[data-side=details][data-dragging=true]:after{opacity:1}.pI_x6G_explorerCol:hover~.pI_x6G_handle[data-side=explorer]:after,.pI_x6G_handle[data-side=explorer]:hover:after,.pI_x6G_handle[data-side=explorer][data-dragging=true]:after{opacity:1}',
  },
  {
    id: 'css.explorerCol.handleHover',
    anchor: '.pI_x6G_handle[data-side=details]:hover:after,.pI_x6G_handle[data-side=details][data-dragging=true]:after{background:var(--dsw-alias-button-floating-hover);border-color:var(--dsw-alias-border-l3)}',
    replacement: '.pI_x6G_handle[data-side=details]:hover:after,.pI_x6G_handle[data-side=details][data-dragging=true]:after{background:var(--dsw-alias-button-floating-hover);border-color:var(--dsw-alias-border-l3)}.pI_x6G_handle[data-side=explorer]:hover:after,.pI_x6G_handle[data-side=explorer][data-dragging=true]:after{background:var(--dsw-alias-button-floating-hover);border-color:var(--dsw-alias-border-l3)}',
  },
  {
    id: 'css.classMap.explorerCol',
    anchor: '"centerCol": "pI_x6G_centerCol"',
    replacement: '"centerCol": "pI_x6G_centerCol",\n\t\t\t"explorerCol": "pI_x6G_explorerCol"',
  },
  {
    id: 'computeColumns',
    anchor: L(
      'function computeColumns(viewport, sidebar, details) {',
      '\t\t\tconst s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);',
      '\t\t\tconst d0 = details === 0 ? 0 : clampWidth(details, 300, 520);',
      '\t\t\tif (s + d0 + 640 <= viewport) return {',
      '\t\t\t\tsidebar: s,',
      '\t\t\t\tcenter: viewport - s - d0,',
      '\t\t\t\tdetails: d0',
      '\t\t\t};',
      '\t\t\tconst d1 = d0 === 0 ? 0 : Math.max(300, viewport - s - 640);',
      '\t\t\tif (s + d1 + 640 <= viewport) return {',
      '\t\t\t\tsidebar: s,',
      '\t\t\t\tcenter: 640,',
      '\t\t\t\tdetails: d1',
      '\t\t\t};',
      '\t\t\treturn {',
      '\t\t\t\tsidebar: s,',
      '\t\t\t\tcenter: Math.max(0, viewport - s),',
      '\t\t\t\tdetails: 0',
      '\t\t\t};',
      '\t\t}',
    ),
    replacement: L(
      'function computeColumns(viewport, sidebar, explorer, details) {',
      '\t\t\tconst s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);',
      '\t\t\tconst e0 = explorer === 0 ? 0 : clampWidth(explorer, 200, 420);',
      '\t\t\tconst d0 = details === 0 ? 0 : clampWidth(details, 300, 520);',
      '\t\t\tif (s + e0 + d0 + 640 <= viewport) return {',
      '\t\t\t\tsidebar: s,',
      '\t\t\t\texplorer: e0,',
      '\t\t\t\tcenter: viewport - s - e0 - d0,',
      '\t\t\t\tdetails: d0',
      '\t\t\t};',
      '\t\t\tconst d1 = d0 === 0 ? 0 : Math.max(300, viewport - s - e0 - 640);',
      '\t\t\tif (s + e0 + d1 + 640 <= viewport) return {',
      '\t\t\t\tsidebar: s,',
      '\t\t\t\texplorer: e0,',
      '\t\t\t\tcenter: 640,',
      '\t\t\t\tdetails: d1',
      '\t\t\t};',
      '\t\t\treturn {',
      '\t\t\t\tsidebar: s,',
      '\t\t\t\texplorer: e0,',
      '\t\t\t\tcenter: Math.max(0, viewport - s - e0),',
      '\t\t\t\tdetails: 0',
      '\t\t\t};',
      '\t\t}',
    ),
  },
  {
    id: 'store.init.explorer',
    anchor: '\t\t\t\t\tsidebar: 280,\n\t\t\t\t\tdetails: 0,',
    replacement: '\t\t\t\t\tsidebar: 280,\n\t\t\t\t\texplorer: 260,\n\t\t\t\t\tdetails: 0,',
  },
  {
    id: 'store.action.setExplorer',
    anchor: '\t\t\t\t\tsetDetails: (d, px) => {\n\t\t\t\t\t\td.details = clampWidth(px, 300, 520);\n\t\t\t\t\t},',
    replacement: '\t\t\t\t\tsetDetails: (d, px) => {\n\t\t\t\t\t\td.details = clampWidth(px, 300, 520);\n\t\t\t\t\t},\n\t\t\t\t\tsetExplorer: (d, px) => {\n\t\t\t\t\t\td.explorer = clampWidth(px, 200, 420);\n\t\t\t\t\t},',
  },
  {
    id: 'appframe.computeCall',
    anchor: 'const cols = computeColumns(viewport, sidebarCollapsed ? 0 : panels.sidebar === 0 ? 280 : panels.sidebar, detailsSession === void 0 ? 0 : panels.details);',
    replacement: 'const explorerEffective = narrow ? 0 : panels.explorer;\n\t\t\tconst cols = computeColumns(viewport, sidebarCollapsed ? 0 : panels.sidebar === 0 ? 280 : panels.sidebar, explorerEffective, detailsSession === void 0 ? 0 : panels.details);',
  },
  {
    id: 'appframe.explorerBase',
    anchor: 'const detailsBase = (0, react.useRef)(0);',
    replacement: 'const detailsBase = (0, react.useRef)(0);\n\t\t\tconst explorerBase = (0, react.useRef)(0);',
  },
  {
    id: 'appframe.explorerDragCallbacks',
    anchor: L(
      '\t\t\tconst onDetailsDrag = (0, react.useCallback)((dx) => {',
      '\t\t\t\tactions.setDetails(detailsBase.current - dx);',
      '\t\t\t}, [actions]);',
    ),
    replacement: L(
      '\t\t\tconst onDetailsDrag = (0, react.useCallback)((dx) => {',
      '\t\t\t\tactions.setDetails(detailsBase.current - dx);',
      '\t\t\t}, [actions]);',
      '\t\t\tconst onExplorerStart = (0, react.useCallback)(() => {',
      '\t\t\t\texplorerBase.current = colsRef.current.explorer;',
      '\t\t\t\tsetDragging(true);',
      '\t\t\t}, []);',
      '\t\t\tconst onExplorerDrag = (0, react.useCallback)((dx) => {',
      '\t\t\t\tactions.setExplorer(explorerBase.current + dx);',
      '\t\t\t}, [actions]);',
    ),
  },
  {
    id: 'appframe.gridTemplate',
    anchor: 'gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px`',
    replacement: 'gridTemplateColumns: `${cols.sidebar}px ${cols.explorer}px minmax(0, 1fr) ${cols.details}px`',
  },
  {
    id: 'appframe.dataExplorerCollapsed',
    anchor: '"data-details-collapsed": cols.details === 0 || void 0,',
    replacement: '"data-details-collapsed": cols.details === 0 || void 0,\n\t\t\t\t"data-explorer-collapsed": cols.explorer === 0 || void 0,',
  },
  {
    id: 'appframe.explorerColumn',
    anchor: '\t\t\t\t\t(0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(CenterColumn, { children: renderSlot("conversation", {}) }), (0, react_jsx_runtime.jsx)(DetailsColumn, { children: renderSlot("details", {}) })] }),',
    replacement: L(
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {',
      '\t\t\t\t\t\tclassName: AppFrame_module_css_default.explorerCol,',
      '\t\t\t\t\t\tchildren: renderSlot("explorer", {',
      '\t\t\t\t\t\t\twidth: cols.explorer',
      '\t\t\t\t\t\t})',
      '\t\t\t\t\t}),',
      '\t\t\t\t\t(0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(CenterColumn, { children: renderSlot("conversation", {}) }), (0, react_jsx_runtime.jsx)(DetailsColumn, { children: renderSlot("details", {}) })] }),',
    ),
  },
  {
    id: 'appframe.explorerHandle',
    anchor: '\t\t\t\t\tcols.details > 0 && (0, react_jsx_runtime.jsx)(DragHandle, {',
    replacement: L(
      '\t\t\t\t\tcols.explorer > 0 && (0, react_jsx_runtime.jsx)(DragHandle, {',
      '\t\t\t\t\t\tside: "explorer",',
      '\t\t\t\t\t\tleft: cols.sidebar + cols.explorer,',
      '\t\t\t\t\t\tonStart: onExplorerStart,',
      '\t\t\t\t\t\tonDrag: onExplorerDrag,',
      '\t\t\t\t\t\tonEnd: onDragEnd',
      '\t\t\t\t\t}),',
      '\t\t\t\t\tcols.details > 0 && (0, react_jsx_runtime.jsx)(DragHandle, {',
    ),
  },
  {
    id: 'apply.children.explorer',
    anchor: L(
      '\t\t\t\t\t\t"sidebar": {',
      '\t\t\t\t\t\t\tkind: "single",',
      '\t\t\t\t\t\t\tscope: "root"',
      '\t\t\t\t\t\t},',
    ),
    replacement: L(
      '\t\t\t\t\t\t"sidebar": {',
      '\t\t\t\t\t\t\tkind: "single",',
      '\t\t\t\t\t\t\tscope: "root"',
      '\t\t\t\t\t\t},',
      '\t\t\t\t\t\t"explorer": {',
      '\t\t\t\t\t\t\tkind: "single",',
      '\t\t\t\t\t\t\tscope: "root"',
      '\t\t\t\t\t\t},',
    ),
  },
  {
    id: 'css.centerSplit',
    anchor: '.pI_x6G_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}',
    replacement: '.pI_x6G_centerCol{flex-direction:row;min-width:0;display:flex;overflow:hidden}.pI_x6G_conversationSeat{flex:1 1 0;min-width:0;overflow:hidden}',
  },
  {
    id: 'css.classMap.conversationSeat',
    anchor: '"centerCol": "pI_x6G_centerCol"',
    replacement: '"centerCol": "pI_x6G_centerCol",\n\t\t\t"conversationSeat": "pI_x6G_conversationSeat"',
  },
  {
    id: 'appframe.centerSplit',
    anchor: '(0, react_jsx_runtime.jsx)(CenterColumn, { children: renderSlot("conversation", {}) })',
    replacement: '(0, react_jsx_runtime.jsx)(CenterColumn, { children: [renderSlot("explorer.preview", {}), (0, react_jsx_runtime.jsx)("div", { className: AppFrame_module_css_default.conversationSeat, children: renderSlot("conversation", {}) })] })',
  },
  {
    id: 'apply.children.explorerPreview',
    anchor: L(
      '\t\t\t\t\t\t"explorer": {',
      '\t\t\t\t\t\t\tkind: "single",',
      '\t\t\t\t\t\t\tscope: "root"',
      '\t\t\t\t\t\t},',
    ),
    replacement: L(
      '\t\t\t\t\t\t"explorer": {',
      '\t\t\t\t\t\t\tkind: "single",',
      '\t\t\t\t\t\t\tscope: "root"',
      '\t\t\t\t\t\t},',
      '\t\t\t\t\t\t"explorer.preview": {',
      '\t\t\t\t\t\t\tkind: "single",',
      '\t\t\t\t\t\t\tscope: "root"',
      '\t\t\t\t\t\t},',
    ),
  },
]

const PATCHED_MARKERS = ['"explorerCol": "pI_x6G_explorerCol"', 'setExplorer: (d, px) => {', 'renderSlot("explorer"', 'renderSlot("explorer.preview"', 'conversationSeat']

function main() {
  const target = resolve(targetArg ?? defaultTarget)
  if (!existsSync(target)) {
    console.error(`[patch-layout] target not found: ${target}`)
    console.error('[patch-layout] is DSH_HOME correct, or pass --target <abs path>?')
    process.exit(1)
  }

  const real = realpathSync(target)
  const original = readFileSync(real, 'utf8')

  const alreadyPatched = PATCHED_MARKERS.every((marker) => original.includes(marker))
  if (alreadyPatched && !force) {
    console.log(`[patch-layout] already patched (${real}) — nothing to do.`)
    return
  }
  if (alreadyPatched && force) {
    console.log('[patch-layout] --force: re-patching from the current file. Consider restoring the .orig backup first.')
  }

  mkdirSync(BACKUP_DIR, { recursive: true })
  const pristine = join(BACKUP_DIR, 'client.js.orig')
  if (!existsSync(pristine)) {
    copyFileSync(real, pristine)
    console.log(`[patch-layout] pristine backup written: ${pristine}`)
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(real, join(BACKUP_DIR, `client.js.${stamp}.bak`))
  }

  let patched = original
  const failures = []
  for (const item of REPLACEMENTS) {
    const count = countOccurrences(patched, item.anchor)
    if (count === 0) {
      failures.push(`${item.id}: anchor not found`)
      continue
    }
    if (count > 1) {
      failures.push(`${item.id}: anchor found ${count} times (expected exactly 1)`)
      continue
    }
    patched = patched.replace(item.anchor, item.replacement)
  }

  if (failures.length > 0) {
    console.error('[patch-layout] ABORTED — the bundle does not match the expected compiled output:')
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error('[patch-layout] the dsh version may have changed; update scripts/patch-layout.mjs anchors.')
    process.exit(1)
  }

  const missingMarkers = PATCHED_MARKERS.filter((marker) => !patched.includes(marker))
  if (missingMarkers.length > 0) {
    console.error('[patch-layout] verification failed — missing markers:')
    for (const marker of missingMarkers) console.error(`  - ${marker}`)
    process.exit(1)
  }

  writeFileSync(real, patched, 'utf8')
  console.log(`[patch-layout] patched: ${real}`)
  console.log('[patch-layout] verified: explorerCol class, setExplorer action, explorer slot render.')
  console.log('[patch-layout] restart dsh web to serve the new bundle rev.')
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

main()
