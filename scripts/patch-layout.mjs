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
 * The same @deepseek-ai/dsh-client-ui-layout version ships as TWO different
 * builds with byte-different output:
 *   - "npm":        the npm-registry tarball (function bodies at 0 indent,
 *                   literal `56`, LF-only line endings);
 *   - "desktop-ci": the build packaged inside DSH Desktop's resources/app and
 *                   cloned into its profile (2-tab indented computeColumns,
 *                   `COLLAPSED_SIDEBAR_WIDTH` constant, one stray CRLF).
 * Every variant shares all anchors except `computeColumns`; both variants are
 * dry-run against the target and the first one whose anchors ALL match is
 * applied. If none matches, the bundle changed again — update the anchors.
 *
 * Usage:
 *   node scripts/patch-layout.mjs [--target <abs path to client.js>] [--force]
 *   node scripts/patch-layout.mjs [--target <abs path to client.js>] --restore
 *
 * --restore copies the pristine backup (patches/layout.backup/client.js.orig,
 * written by the first successful patch) back over the target — the uninstall
 * recovery path: after removing this plugin, run this once and restart dsh web
 * to get the stock dsh-client-ui-layout bundle back. Without it a leftover
 * patch is harmless since 0.0.18 (the explorer column auto-hides when no
 * plugin contributes to its slots), but restoring is the clean state.
 *
 * Default target resolves the profile junction to its npx-cache copy:
 *   <DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BACKUP_DIR = join(REPO_ROOT, 'patches', 'layout.backup')

const args = process.argv.slice(2)
const targetArg = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined
const force = args.includes('--force')
const restore = args.includes('--restore')

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const defaultTarget = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js')

/** @param {string[]} lines */
const L = (...lines) => lines.join('\n')

/** One precise replacement: `anchor` must occur exactly once in the file. */
const REPLACEMENTS = [
  {
    id: 'css.explorerCol.rule',
    anchor: '.pI_x6G_detailsCol{border-left:.5px solid var(--dsw-alias-border-l3);min-width:0;overflow:hidden}',
    replacement: '.pI_x6G_detailsCol{border-left:.5px solid var(--dsw-alias-border-l3);min-width:0;overflow:hidden}.pI_x6G_explorerCol{background:var(--dsw-specific-sidebar-fill);border-right:.5px solid var(--dsw-alias-border-l3);min-width:0;overflow:hidden}',
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
    replacement: '\t\t\t\t\tsidebar: 280,\n\t\t\t\t\texplorer: 260,\n\t\t\t\t\texplorerOccupied: false,\n\t\t\t\t\tdetails: 0,',
  },
  {
    id: 'store.action.setExplorer',
    anchor: '\t\t\t\t\tsetDetails: (d, px) => {\n\t\t\t\t\t\td.details = clampWidth(px, 300, 520);\n\t\t\t\t\t},',
    replacement: '\t\t\t\t\tsetDetails: (d, px) => {\n\t\t\t\t\t\td.details = clampWidth(px, 300, 520);\n\t\t\t\t\t},\n\t\t\t\t\tsetExplorer: (d, px) => {\n\t\t\t\t\t\td.explorer = clampWidth(px, 200, 420);\n\t\t\t\t\t},\n\t\t\t\t\tsetExplorerOccupied: (d, occupied) => {\n\t\t\t\t\t\td.explorerOccupied = occupied;\n\t\t\t\t\t},',
  },
  {
    id: 'controller.setExplorerOccupied',
    anchor: '\t\t\tcloseDetails() {\n\t\t\t\tthis.#require().closeDetails();\n\t\t\t}',
    replacement: '\t\t\tcloseDetails() {\n\t\t\t\tthis.#require().closeDetails();\n\t\t\t}\n\t\t\tsetExplorerOccupied(occupied) {\n\t\t\t\tif (this.#panels !== void 0) this.#panels.setExplorerOccupied(occupied);\n\t\t\t}',
  },
  {
    id: 'apply.explorerOccupancy',
    anchor: '\t\t\t\t\tinject: (actions) => {\n\t\t\t\t\t\tlayout.attachPanels(actions);\n\t\t\t\t\t\treturn {};\n\t\t\t\t\t}',
    replacement: '\t\t\t\t\tinject: (actions) => {\n\t\t\t\t\t\tlayout.attachPanels(actions);\n\t\t\t\t\t\tlayout.setExplorerOccupied(ctx.slots.entries("explorer").length + ctx.slots.entries("explorer.preview").length > 0);\n\t\t\t\t\t\treturn {};\n\t\t\t\t\t}',
  },
  {
    id: 'apply.explorerOccupancyWatch',
    anchor: '\t\t\t\treturn () => {\n\t\t\t\t\tdisposeRegistration();\n\t\t\t\t\tdisposeService();\n\t\t\t\t};\n\t\t\t}, "ui-layout: service + root registration");',
    replacement: '\t\t\t\treturn () => {\n\t\t\t\t\tdisposeRegistration();\n\t\t\t\t\tdisposeService();\n\t\t\t\t};\n\t\t\t}, "ui-layout: service + root registration");\n\t\t\tctx.effect(() => {\n\t\t\t\tconst syncExplorer = () => {\n\t\t\t\t\tlayout.setExplorerOccupied(ctx.slots.entries("explorer").length > 0 || ctx.slots.entries("explorer.preview").length > 0);\n\t\t\t\t};\n\t\t\t\tsyncExplorer();\n\t\t\t\treturn ctx.on("slots/changed", syncExplorer);\n\t\t\t}, "ui-layout: explorer occupancy sync");',
  },
  {
    id: 'appframe.computeCall',
    anchor: 'const cols = computeColumns(viewport, sidebarCollapsed ? 0 : panels.sidebar === 0 ? 280 : panels.sidebar, detailsSession === void 0 ? 0 : panels.details);',
    // `panels.details > 0` (details explicitly opened) collapses the explorer
    // column so the crowding solve keeps the STOCK width budget: with the
    // 260px explorer column parked in, the details pane needs a ~1480px
    // viewport instead of the stock ~1220px and gets squeezed to 0 — "open
    // details flashes and vanishes" (the user-visible regression).
    replacement: 'const explorerEffective = narrow || !panels.explorerOccupied || panels.details > 0 ? 0 : panels.explorer;\n\t\t\tconst cols = computeColumns(viewport, sidebarCollapsed ? 0 : panels.sidebar === 0 ? 280 : panels.sidebar, explorerEffective, detailsSession === void 0 ? 0 : panels.details);',
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
    anchor: '\t\t\t\t\t(0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(CenterColumn, { children: renderSlot("conversation", {}) }), (0, react_jsx_runtime.jsx)(DetailsColumn, { children: (0, react_jsx_runtime.jsx)(SessionProvider, { children: renderSlot("details", {}) }) })] }),',
    replacement: L(
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {',
      '\t\t\t\t\t\tclassName: AppFrame_module_css_default.explorerCol,',
      '\t\t\t\t\t\tchildren: renderSlot("explorer", {',
      '\t\t\t\t\t\t\twidth: cols.explorer',
      '\t\t\t\t\t\t})',
      '\t\t\t\t\t}),',
      '\t\t\t\t\t(0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(CenterColumn, { children: renderSlot("conversation", {}) }), (0, react_jsx_runtime.jsx)(DetailsColumn, { children: (0, react_jsx_runtime.jsx)(SessionProvider, { children: renderSlot("details", {}) }) })] }),',
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

// ---------------------------------------------------------------------------
// dsh 0.1.5-rc.1 variant: the frame was re-architected — the details column
// became the generic "rightbar" panel system (RightbarColumn, track/fullscreen
// presentation, keyed "main" slot) and the whole bundle gained a
// window.__ModuleLoader__ wrapper (+1 tab of indent). The explorer column is
// re-added between sidebar and center; the rightbar solve budgets it into
// `available`, and an explicitly shown rightbar panel collapses the explorer
// (parity with the 0.0.21 details-precedence rule).
// ---------------------------------------------------------------------------
const REPLACEMENTS_015 = [
  {
    id: 'css.explorerCol.rule',
    anchor: '.pI_x6G_sidebarCol{background:var(--dsw-specific-sidebar-fill);border-right:.5px solid var(--dsw-alias-border-l3);min-width:0;overflow:hidden}',
    replacement: '.pI_x6G_sidebarCol{background:var(--dsw-specific-sidebar-fill);border-right:.5px solid var(--dsw-alias-border-l3);min-width:0;overflow:hidden}.pI_x6G_explorerCol{background:var(--dsw-specific-sidebar-fill);border-right:.5px solid var(--dsw-alias-border-l3);min-width:0;overflow:hidden}',
  },
  {
    id: 'css.conversationSeat.rule',
    // Row direction is LOAD-BEARING: the preview slot renders as CenterColumn's
    // first child and must sit BESIDE the conversation seat (0.1.2 patch
    // parity). Leaving `column` stacks the preview full-width ABOVE the chat.
    anchor: '.pI_x6G_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}',
    replacement: '.pI_x6G_centerCol{flex-direction:row;min-width:0;display:flex;overflow:hidden}.pI_x6G_conversationSeat{flex:1 1 0;min-width:0;overflow:hidden}',
  },
  {
    id: 'css.classMap',
    anchor: '"centerCol": "pI_x6G_centerCol",',
    replacement: '"centerCol": "pI_x6G_centerCol",\n\t\t\t"explorerCol": "pI_x6G_explorerCol",\n\t\t\t"conversationSeat": "pI_x6G_conversationSeat",',
  },
  {
    id: 'computeColumns',
    anchor: L(
      'function computeColumns(viewport, sidebar, rightbar) {',
      '\t\t\tconst s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);',
      '\t\t\tconst available = viewport - s - 400;',
      '\t\t\tconst r = rightbar === 0 || available < 300 ? 0 : Math.min(available, clampWidth(rightbar, 300, viewport * RIGHTBAR_MAX_RATIO));',
      '\t\t\treturn {',
      '\t\t\t\tsidebar: s,',
      '\t\t\t\tcenter: Math.max(0, viewport - s - r),',
      '\t\t\t\trightbar: r',
      '\t\t\t};',
      '\t\t}',
    ),
    replacement: L(
      'function computeColumns(viewport, sidebar, explorer, rightbar) {',
      '\t\t\tconst s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);',
      '\t\t\tconst e0 = explorer === 0 ? 0 : clampWidth(explorer, 200, 420);',
      '\t\t\tconst available = viewport - s - e0 - 400;',
      '\t\t\tconst r = rightbar === 0 || available < 300 ? 0 : Math.min(available, clampWidth(rightbar, 300, viewport * RIGHTBAR_MAX_RATIO));',
      '\t\t\treturn {',
      '\t\t\t\tsidebar: s,',
      '\t\t\t\texplorer: e0,',
      '\t\t\t\tcenter: Math.max(0, viewport - s - e0 - r),',
      '\t\t\t\trightbar: r',
      '\t\t\t};',
      '\t\t}',
    ),
  },
  {
    id: 'store.init.explorer',
    anchor: '\t\t\t\t\t\tsidebar: 280,',
    replacement: '\t\t\t\t\t\tsidebar: 280,\n\t\t\t\t\t\texplorer: 260,\n\t\t\t\t\t\texplorerOccupied: false,',
  },
  {
    id: 'store.action.setExplorer',
    anchor: L(
      '\t\t\t\t\tsetSidebar: (d, px) => {',
      '\t\t\t\t\t\td.layoutInfo.rightbarInstant = false;',
      '\t\t\t\t\t\td.layoutInfo.sidebar = clampWidth(px, 264, 420);',
      '\t\t\t\t\t},',
    ),
    replacement: L(
      '\t\t\t\t\tsetSidebar: (d, px) => {',
      '\t\t\t\t\t\td.layoutInfo.rightbarInstant = false;',
      '\t\t\t\t\t\td.layoutInfo.sidebar = clampWidth(px, 264, 420);',
      '\t\t\t\t\t},',
      '\t\t\t\t\tsetExplorer: (d, px) => {',
      '\t\t\t\t\t\td.layoutInfo.explorer = clampWidth(px, 200, 420);',
      '\t\t\t\t\t},',
      '\t\t\t\t\tsetExplorerOccupied: (d, occupied) => {',
      '\t\t\t\t\t\td.layoutInfo.explorerOccupied = occupied;',
      '\t\t\t\t\t},',
    ),
  },
  {
    id: 'controller.setExplorerOccupied',
    anchor: L(
      '\t\t\tcloseRightbar() {',
      '\t\t\t\tthis.panels.closeRightbar();',
      '\t\t\t}',
    ),
    replacement: L(
      '\t\t\tcloseRightbar() {',
      '\t\t\t\tthis.panels.closeRightbar();',
      '\t\t\t}',
      '\t\t\tsetExplorerOccupied(occupied) {',
      '\t\t\t\tif (this.panels !== void 0) this.panels.setExplorerOccupied(occupied);',
      '\t\t\t}',
    ),
  },
  {
    id: 'apply.explorerOccupancyWatch',
    // Must live INSIDE the service+root registration effect: 0.1.5 declares
    // `const layout` in that callback's scope (0.1.2 had it at apply level —
    // an apply-level effect here throws "layout is not defined" on load).
    anchor: L(
      '\t\t\t\tretainMainPanels();',
      '\t\t\t\treturn () => {',
      '\t\t\t\t\tlayout.dispose();',
    ),
    replacement: L(
      '\t\t\t\tretainMainPanels();',
      '\t\t\t\tctx.effect(() => {',
      '\t\t\t\t\tconst syncExplorer = () => {',
      '\t\t\t\t\t\tlayout.setExplorerOccupied(ctx.slots.entries("explorer").length > 0 || ctx.slots.entries("explorer.preview").length > 0);',
      '\t\t\t\t\t};',
      '\t\t\t\t\tsyncExplorer();',
      '\t\t\t\t\treturn ctx.on("slots/changed", syncExplorer);',
      '\t\t\t\t}, "ui-layout: explorer occupancy sync");',
      '\t\t\t\treturn () => {',
      '\t\t\t\t\tlayout.dispose();',
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
  {
    id: 'appframe.explorerEffective.normal',
    // A shown rightbar panel collapses the explorer column so the stock width
    // budget is restored (0.0.21 parity: explicit panel open beats explorer).
    anchor: '\t\t\tconst normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference, rightbarPreference);',
    replacement: L(
      '\t\t\tconst explorerEffective = narrow || !layoutInfo.explorerOccupied || layoutInfo.rightbarShown ? 0 : layoutInfo.explorer;',
      '\t\t\tconst normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference, explorerEffective, rightbarPreference);',
    ),
  },
  {
    id: 'appframe.explorerEffective.cols',
    anchor: '\t\t\tconst cols = computeColumns(viewport, sidebarPreference, layoutInfo.rightbarTrack ? rightbarPreference : 0);',
    replacement: '\t\t\tconst cols = computeColumns(viewport, sidebarPreference, explorerEffective, layoutInfo.rightbarTrack ? rightbarPreference : 0);',
  },
  {
    id: 'appframe.explorerBase',
    anchor: '\t\t\tconst rightbarBase = (0, react.useRef)(0);',
    replacement: '\t\t\tconst rightbarBase = (0, react.useRef)(0);\n\t\t\tconst explorerBase = (0, react.useRef)(0);',
  },
  {
    id: 'appframe.explorerDragCallbacks',
    anchor: L(
      '\t\t\tconst onRightbarDrag = (0, react.useCallback)((dx) => {',
      '\t\t\t\tactions.setRightbar(rightbarBase.current - dx);',
      '\t\t\t}, [actions]);',
    ),
    replacement: L(
      '\t\t\tconst onRightbarDrag = (0, react.useCallback)((dx) => {',
      '\t\t\t\tactions.setRightbar(rightbarBase.current - dx);',
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
    anchor: 'gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.rightbar}px`',
    replacement: 'gridTemplateColumns: `${cols.sidebar}px ${cols.explorer}px minmax(0, 1fr) ${cols.rightbar}px`',
  },
  {
    id: 'appframe.dataExplorerCollapsed',
    anchor: '\t\t\t\t"data-rightbar-collapsed": cols.rightbar === 0 || void 0,',
    replacement: '\t\t\t\t"data-rightbar-collapsed": cols.rightbar === 0 || void 0,\n\t\t\t\t"data-explorer-collapsed": cols.explorer === 0 || void 0,',
  },
  {
    id: 'appframe.explorerColumn',
    anchor: L(
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {',
      '\t\t\t\t\t\tclassName: AppFrame_module_css_default.sidebarCol,',
      '\t\t\t\t\t\tchildren: sidebar',
      '\t\t\t\t\t}),',
    ),
    replacement: L(
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {',
      '\t\t\t\t\t\tclassName: AppFrame_module_css_default.sidebarCol,',
      '\t\t\t\t\t\tchildren: sidebar',
      '\t\t\t\t\t}),',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {',
      '\t\t\t\t\t\tclassName: AppFrame_module_css_default.explorerCol,',
      '\t\t\t\t\t\tchildren: renderSlot("explorer", {',
      '\t\t\t\t\t\t\twidth: cols.explorer',
      '\t\t\t\t\t\t})',
      '\t\t\t\t\t}),',
    ),
  },
  {
    id: 'appframe.explorerHandle',
    anchor: L(
      '\t\t\t\t\t!sidebarCollapsed && (0, react_jsx_runtime.jsx)(DragHandle, {',
      '\t\t\t\t\t\tside: "sidebar",',
      '\t\t\t\t\t\tleft: cols.sidebar,',
      '\t\t\t\t\t\tonStart: onSidebarStart,',
      '\t\t\t\t\t\tonDrag: onSidebarDrag,',
      '\t\t\t\t\t\tonEnd: onDragEnd',
      '\t\t\t\t\t}),',
    ),
    replacement: L(
      '\t\t\t\t\t!sidebarCollapsed && (0, react_jsx_runtime.jsx)(DragHandle, {',
      '\t\t\t\t\t\tside: "sidebar",',
      '\t\t\t\t\t\tleft: cols.sidebar,',
      '\t\t\t\t\t\tonStart: onSidebarStart,',
      '\t\t\t\t\t\tonDrag: onSidebarDrag,',
      '\t\t\t\t\t\tonEnd: onDragEnd',
      '\t\t\t\t\t}),',
      '\t\t\t\t\tcols.explorer > 0 && (0, react_jsx_runtime.jsx)(DragHandle, {',
      '\t\t\t\t\t\tside: "explorer",',
      '\t\t\t\t\t\tleft: cols.sidebar + cols.explorer,',
      '\t\t\t\t\t\tonStart: onExplorerStart,',
      '\t\t\t\t\t\tonDrag: onExplorerDrag,',
      '\t\t\t\t\t\tonEnd: onDragEnd',
      '\t\t\t\t\t}),',
    ),
  },
  {
    id: 'appframe.centerSplit',
    anchor: '(0, react_jsx_runtime.jsx)(CenterColumn, { children: main })',
    replacement: '(0, react_jsx_runtime.jsx)(CenterColumn, { children: [renderSlot("explorer.preview", {}), (0, react_jsx_runtime.jsx)("div", { className: AppFrame_module_css_default.conversationSeat, children: main })] })',
  },
]

// desktop-ci variant: same table, with `computeColumns` swapped for the anchor
// pair extracted mechanically from a real DSH Desktop packaged bundle.
const DESKTOP_CI = JSON.parse(readFileSync(join(SCRIPT_DIR, 'layout-anchors.desktop-ci.json'), 'utf8'))

/**
 * Delta table for bundles already carrying the PREVIOUS revision of this patch
 * (explorer column without occupancy gating). Anchors exist only in that
 * intermediate state, so these variants never match a pristine bundle — the
 * full variants above win there. Same for both npm and desktop-ci builds:
 * none of the delta anchors touch the `computeColumns` body.
 */
const DELTA_REPLACEMENTS = [
  {
    id: 'delta.appframe.computeCall',
    anchor: 'const explorerEffective = narrow ? 0 : panels.explorer;',
    replacement: 'const explorerEffective = narrow || !panels.explorerOccupied || panels.details > 0 ? 0 : panels.explorer;',
  },
  {
    id: 'delta.store.init',
    anchor: '\t\t\t\t\texplorer: 260,\n\t\t\t\t\tdetails: 0,',
    replacement: '\t\t\t\t\texplorer: 260,\n\t\t\t\t\texplorerOccupied: false,\n\t\t\t\t\tdetails: 0,',
  },
  {
    id: 'delta.store.action',
    anchor: '\t\t\t\t\tsetExplorer: (d, px) => {\n\t\t\t\t\t\td.explorer = clampWidth(px, 200, 420);\n\t\t\t\t\t},',
    replacement: '\t\t\t\t\tsetExplorer: (d, px) => {\n\t\t\t\t\t\td.explorer = clampWidth(px, 200, 420);\n\t\t\t\t\t},\n\t\t\t\t\tsetExplorerOccupied: (d, occupied) => {\n\t\t\t\t\t\td.explorerOccupied = occupied;\n\t\t\t\t\t},',
  },
  {
    id: 'delta.controller',
    anchor: '\t\t\tcloseDetails() {\n\t\t\t\tthis.#require().closeDetails();\n\t\t\t}',
    replacement: '\t\t\tcloseDetails() {\n\t\t\t\tthis.#require().closeDetails();\n\t\t\t}\n\t\t\tsetExplorerOccupied(occupied) {\n\t\t\t\tif (this.#panels !== void 0) this.#panels.setExplorerOccupied(occupied);\n\t\t\t}',
  },
  {
    id: 'delta.watch',
    anchor: '\t\t\t\treturn () => {\n\t\t\t\t\tdisposeRegistration();\n\t\t\t\t\tdisposeService();\n\t\t\t\t};\n\t\t\t}, "ui-layout: service + root registration");',
    replacement: '\t\t\t\treturn () => {\n\t\t\t\t\tdisposeRegistration();\n\t\t\t\t\tdisposeService();\n\t\t\t\t};\n\t\t\t}, "ui-layout: service + root registration");\n\t\t\tctx.effect(() => {\n\t\t\t\tconst syncExplorer = () => {\n\t\t\t\t\tlayout.setExplorerOccupied(ctx.slots.entries("explorer").length > 0 || ctx.slots.entries("explorer.preview").length > 0);\n\t\t\t\t};\n\t\t\t\tsyncExplorer();\n\t\t\t\treturn ctx.on("slots/changed", syncExplorer);\n\t\t\t}, "ui-layout: explorer occupancy sync");',
  },
  {
    id: 'delta.apply',
    anchor: '\t\t\t\t\tinject: (actions) => {\n\t\t\t\t\t\tlayout.attachPanels(actions);\n\t\t\t\t\t\treturn {};\n\t\t\t\t\t}',
    replacement: '\t\t\t\t\tinject: (actions) => {\n\t\t\t\t\t\tlayout.attachPanels(actions);\n\t\t\t\t\t\tlayout.setExplorerOccupied(ctx.slots.entries("explorer").length + ctx.slots.entries("explorer.preview").length > 0);\n\t\t\t\t\t\treturn {};\n\t\t\t\t\t}',
  },
]

/** Delta #2: bundles carrying the FIRST occupancy delta (watch effect exists,
 * inject-hook sync missing, computeCall still the 0.0.18 form). */
const DELTA2_REPLACEMENTS = [
  ...DELTA_REPLACEMENTS.filter((item) => item.id === 'delta.appframe.computeCall'),
  ...DELTA_REPLACEMENTS.filter((item) => item.id === 'delta.apply'),
]

/**
 * Delta #3: bundles already carrying BOTH the watch block and the inject-hook
 * sync (0.0.19/0.0.20 delta2 state). Just the computeCall update: the details
 * pane now takes precedence — an explicitly opened details pane collapses the
 * explorer column so the crowding solve keeps the stock width budget.
 */
const DELTA3_REPLACEMENTS = [
  {
    id: 'delta3.appframe.computeCall',
    anchor: 'const explorerEffective = narrow || !panels.explorerOccupied ? 0 : panels.explorer;',
    replacement: 'const explorerEffective = narrow || !panels.explorerOccupied || panels.details > 0 ? 0 : panels.explorer;',
  },
]

/** Completion markers of the dsh ≤ 0.1.2 explorer patch. */
const PATCHED_MARKERS = ['"explorerCol": "pI_x6G_explorerCol"', 'setExplorer: (d, px) => {', 'renderSlot("explorer"', 'renderSlot("explorer.preview"', 'conversationSeat', 'explorerOccupied', 'entries("explorer").length + ctx.slots', 'panels.details > 0 ? 0 : panels.explorer']

/** Completion markers of the dsh 0.1.5 (rightbar frame) explorer patch. */
const PATCHED_MARKERS_015 = ['"explorerCol": "pI_x6G_explorerCol"', 'setExplorer: (d, px) => {', 'renderSlot("explorer"', 'renderSlot("explorer.preview"', 'conversationSeat', 'explorerOccupied', 'entries("explorer").length > 0 || ctx.slots', 'layoutInfo.explorerOccupied || layoutInfo.rightbarShown ? 0 : layoutInfo.explorer', '"data-explorer-collapsed"']

const isFullyPatched = (text) => PATCHED_MARKERS.every((marker) => text.includes(marker)) || PATCHED_MARKERS_015.every((marker) => text.includes(marker))
const looksPatched = (text) => [...PATCHED_MARKERS, ...PATCHED_MARKERS_015].some((marker) => text.includes(marker))

const VARIANTS = [
  { id: 'npm-015', replacements: REPLACEMENTS_015, markers: PATCHED_MARKERS_015 },
  { id: 'npm', replacements: REPLACEMENTS, markers: PATCHED_MARKERS },
  { id: 'npm-delta', replacements: DELTA_REPLACEMENTS, markers: PATCHED_MARKERS },
  { id: 'npm-delta2', replacements: DELTA2_REPLACEMENTS, markers: PATCHED_MARKERS },
  { id: 'npm-delta3', replacements: DELTA3_REPLACEMENTS, markers: PATCHED_MARKERS },
  {
    id: 'desktop-ci',
    replacements: REPLACEMENTS.map((item) =>
      item.id === 'computeColumns'
        ? { id: 'computeColumns', anchor: DESKTOP_CI.anchor, replacement: DESKTOP_CI.replacement }
        : item
    ),
    markers: PATCHED_MARKERS,
  },
  { id: 'desktop-ci-delta', replacements: DELTA_REPLACEMENTS, markers: PATCHED_MARKERS },
  { id: 'desktop-ci-delta2', replacements: DELTA2_REPLACEMENTS, markers: PATCHED_MARKERS },
  { id: 'desktop-ci-delta3', replacements: DELTA3_REPLACEMENTS, markers: PATCHED_MARKERS },
]

function applyReplacements(original, replacements) {
  let patched = original
  const failures = []
  for (const item of replacements) {
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
  return { patched, failures }
}

function main() {
  const target = resolve(targetArg ?? defaultTarget)
  if (!existsSync(target)) {
    console.error(`[patch-layout] target not found: ${target}`)
    console.error('[patch-layout] is DSH_HOME correct, or pass --target <abs path>?')
    process.exit(1)
  }

  const real = realpathSync(target)
  const original = readFileSync(real, 'utf8')

  // Uninstall recovery: copy the pristine pre-patch bundle back over the
  // target. Runs before every other check — restoring must work regardless of
  // the current bundle's patch state.
  if (restore) {
    const pristine = join(BACKUP_DIR, 'client.js.orig')
    if (!existsSync(pristine)) {
      console.error('[patch-layout] no pristine backup found at ' + pristine)
      console.error('[patch-layout] recover by reinstalling the package instead:')
      console.error('  cd <dsh profile dir> && pnpm install   # (or upgrade dsh — the bundle ships with it)')
      process.exit(1)
    }
    // Staleness guard 1: the target may be a NEWER pristine from a dsh upgrade
    // (nothing to restore). Refuse unless --force.
    const wasPatched = looksPatched(original)
    // Staleness guard 2: the backup must itself be a pristine this script can
    // still patch (an old-dsh backup is useless on a newer dsh — restoring it
    // would be a silent downgrade). Refuse unless --force.
    const backupText = readFileSync(pristine, 'utf8')
    const backupPatchable = VARIANTS.filter((v) => v.id !== 'npm-delta' && v.id !== 'desktop-ci-delta')
      .some((variant) => applyReplacements(backupText, variant.replacements).failures.length === 0)
    if ((!wasPatched || !backupPatchable) && !force) {
      if (!wasPatched) {
        console.error('[patch-layout] target does not look patched — it may be a newer pristine bundle from a dsh upgrade.')
      }
      if (!backupPatchable) {
        console.error('[patch-layout] the pristine backup predates the installed dsh version (its anchors no longer match).')
        console.error('[patch-layout] recover by reinstalling the package instead:')
        console.error('  cd <dsh profile dir> && pnpm install   # (or upgrade dsh — the bundle ships with it)')
      }
      console.error('[patch-layout] refusing a risky restore; pass --force to restore anyway.')
      process.exit(1)
    }
    copyFileSync(pristine, real)
    console.log(`[patch-layout] restored the pristine dsh-client-ui-layout bundle: ${real}`)
    console.log('[patch-layout] restart dsh web to serve the restored bundle.')
    return
  }

  const alreadyPatched = isFullyPatched(original)
  if (alreadyPatched && !force) {
    console.log(`[patch-layout] already patched (${real}) — nothing to do.`)
    return
  }
  if (alreadyPatched && force) {
    console.log('[patch-layout] --force: re-patching from the current file. Consider restoring the .orig backup first.')
  }

  const trials = VARIANTS.map((variant) => ({ ...variant, ...applyReplacements(original, variant.replacements) }))
  const chosen = trials.find((trial) => trial.failures.length === 0)
  if (!chosen) {
    console.error('[patch-layout] ABORTED — the bundle matches no known build variant:')
    for (const trial of trials) {
      console.error(`  variant "${trial.id}":`)
      for (const failure of trial.failures) console.error(`    - ${failure}`)
    }
    console.error('[patch-layout] the dsh version may have changed; update the variant anchors in scripts/.')
    process.exit(1)
  }
  console.log(`[patch-layout] build variant: ${chosen.id}`)

  mkdirSync(BACKUP_DIR, { recursive: true })
  const pristine = join(BACKUP_DIR, 'client.js.orig')
  // client.js.orig must hold the PRISTINE bundle of the CURRENT dsh version —
  // it is what --restore hands back on uninstall. A dsh upgrade reverts the
  // bundle to a fresh pristine, so whenever the pre-patch target itself looks
  // unpatched, promote it (the previous orig belongs to an older dsh and would
  // otherwise be restored over a newer install — a silent downgrade). Only a
  // pre-patch state that already carries our markers gets the timestamped bak.
  const targetLooksPatched = looksPatched(original)
  const hadPristine = existsSync(pristine)
  // The shared pristine backup backs --restore for the DEFAULT profile bundle.
  // With an explicit --target (testing / another machine's bundle) never touch
  // it — an unrelated file must not overwrite the restore source.
  if (targetArg !== undefined) {
    console.log('[patch-layout] --target given: skipping backup bookkeeping (the shared pristine backup is only managed for the default profile bundle).')
  } else if (!hadPristine || !targetLooksPatched) {
    copyFileSync(real, pristine)
    if (!hadPristine) console.log(`[patch-layout] pristine backup written: ${pristine}`)
    else console.log('[patch-layout] pristine backup refreshed (dsh upgrade detected — the old orig was a different version).')
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(real, join(BACKUP_DIR, `client.js.${stamp}.bak`))
  }

  const missingMarkers = (chosen.markers ?? PATCHED_MARKERS).filter((marker) => !chosen.patched.includes(marker))
  if (missingMarkers.length > 0) {
    console.error('[patch-layout] verification failed — missing markers:')
    for (const marker of missingMarkers) console.error(`  - ${marker}`)
    process.exit(1)
  }

  writeFileSync(real, chosen.patched, 'utf8')
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
