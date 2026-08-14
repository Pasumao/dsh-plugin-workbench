# dsh-plugin-workbench

![License](https://img.shields.io/github/license/Pasumao/dsh-plugin-workbench)
![CI](https://img.shields.io/github/actions/workflow/status/Pasumao/dsh-plugin-workbench/ci.yml?branch=main)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Stars](https://img.shields.io/github/stars/Pasumao/dsh-plugin-workbench?style=social)
![AI Assisted](https://img.shields.io/badge/AI-Assisted-8A2BE2)

DSH Web GUI 的 VS Code 风格工作区文件浏览器插件：在 sidebar 与聊天区之间新增
**文件树列**，点文件在中间区左侧打开**可编辑的代码预览**（语法高亮 + 标签页），
文件树自动刷新，每个工作区各自保存自己的标签与展开状态。

> 需要两条改动线同时存在：本插件仓库 + 对 `dsh-client-ui-layout` 编译产物的布局补丁。

## 功能特性

- **文件树**：跟随当前会话工作区（`SessionSummary.cwd`），目录在前、按名称排序、
  懒加载展开；每 2 秒自动刷新可见目录，磁盘变化无需手动刷新。
- **分栏预览**：点文件在中间区左侧打开（默认 55% 宽），聊天区压缩到右侧；
  分隔条可拖拽调宽；打开/关闭带淡入淡出动画。
- **直接编辑**：预览即编辑器（透明 textarea 叠加语法高亮层），打开即可打字；
  `Ctrl+S` / `Cmd+S` 保存写回磁盘，未保存的标签显示脏标记圆点。
- **标签页**：可同时打开多个文件，标签可点选、可拖拽排序、可逐个关闭。
- **收起/弹出**：标签栏最右侧 `<` 收起（暂存，标签与内容保留）；文件列头部 `>`
  原样弹出。
- **明暗主题**：文件列头部 ☀/🌙 一键切换 VS Code 亮色/暗色配色（独立于 app 皮肤）。
- **按工作区隔离**：每个工作区（cwd）各存一份标签、激活文件、收起状态、展开目录；
  切换工作区互不干扰，切回后原样恢复。
- **语法高亮**：内置 highlight.js，覆盖 JS/TS、Python、JSON、HTML/XML、CSS、Markdown、
  Shell、Java、C/C++、C#、Go、Rust、SQL、YAML、INI（按扩展名自动识别）。

## 架构

一个包同时承载 host 半部（cordis 插件）与 client 半部（浏览器 bundle），外加一处
对 DSH 核心布局编译产物的补丁。

```
浏览器                                                        host (Node)
┌────────────────────────────────────────────┐        ┌──────────────────────┐
│ AppFrame (4 列: sidebar|explorer|center|details) │        │ ctx.fs (沙箱文件系统)  │
│  ├ explorer 槽位 → FileExplorer（文件树）    │  RPC   │  /dsh-plugin-files   │
│  ├ explorer.preview 槽位 → FilePreview（编辑）│◄─────►│   ├ list  目录列举    │
│  └ 会话区 = conversation 槽位（聊天）        │        │   ├ read  文件读取    │
└────────────────────────────────────────────┘        │   └ write 文件写回    │
```

- **host 半部**（`src/index.ts`）：`apply(ctx)` 注册 loopback 专属 RPC 通道
  `/dsh-plugin-files`，端点 `list`/`read`/`write` 全部基于 `ctx.fs`
  （`resolve/stat/listDir/readText/writeText/processPath`）。读操作任何沙箱模式均放行；
  `write` 显式以 `danger-full-access` 策略写回（等价 `/api` 写工具的权限模型）。
- **client 半部**（`src/client/*`）：`apply(ctx)` 注册 `files` locale 命名空间，
  并把 `FileExplorer` / `FilePreview` 分别注入 `explorer` / `explorer.preview` 槽位；
  数据读写经 `ctx.connection.rpc.call` 走 host 端点，`ctx.workspaces.openPath` 打开系统。
  `store.ts` 是共享状态：标签、激活文件、收起状态按 cwd 分桶（`workspaces[cwd]`）。
- **布局补丁**（`scripts/patch-layout.mjs`）：DSH 自带的 `dsh-client-ui-layout` 只有
  `sidebar | center | details` 三列。脚本对已安装包编译产物 `lib/client.js` 做精确
  字符串替换，新增：`explorer` 列 + 拖拽手柄 + layout store 的 `explorer` 面板，
  以及中心列分栏（`conversation` + `explorer.preview` 并排）。

## 文件结构

```
dsh-plugin-workbench/
├─ package.json               # 包定义（main→host / exports["./client"]→client / dsh.bundle）
├─ cordis.patch.yml           # bundle 补丁层：loader 条目（boot 自动应用）
├─ tsdown.config.ts           # clientBundle 双面打包配置
├─ tsconfig.json              # typecheck 配置（strict）
├─ README.md                  # 本文档
├─ CONTRIBUTING.md            # 贡献指南
├─ CODE_OF_CONDUCT.md         # 行为准则
├─ SECURITY.md                # 安全政策
├─ CHANGELOG.md               # 变更日志
├─ .github/
│  ├─ workflows/ci.yml        # CI：pnpm install + typecheck + build（Node 20/22）
│  └─ ISSUE_TEMPLATE/         # Bug 报告 / 功能建议模板
├─ build/
│  ├─ tsdown.client.ts        # 复用的 tsdown 预设（CSS Modules 内联 / banner / 纯净门）
│  └─ web-platform.ts         # 平台模块表（外置 externals 清单）
├─ scripts/
│  └─ patch-layout.mjs        # 布局补丁：4 列 + explorer 槽位 + 中心分栏（幂等、可回滚）
├─ patches/
│  └─ layout.backup/          # 布局 bundle 原版备份（脚本自动生成，不入库）
├─ src/
│  ├─ index.ts                # host：/dsh-plugin-files RPC（list/read/write）
│  ├─ dsh.d.ts                # 本地最小 Context 类型声明（DX only）
│  └─ client/
│     ├─ index.ts             # client 入口：locale + 两个槽位注册
│     ├─ FileExplorer.tsx     # 文件树列（懒加载 / 自动刷新 / 每工作区展开状态）
│     ├─ FilePreview.tsx      # 分栏预览（标签 / 可编辑 / 语法高亮 / 收起弹出）
│     ├─ highlight.ts         # highlight.js 语言集 + 扩展名识别
│     ├─ store.ts             # 每工作区一份的标签/激活/收起状态
│     ├─ locales.ts           # zh/en 文案
│     ├─ css-modules.d.ts     # CSS Modules 类型声明（typecheck 用）
│     └─ files.module.css     # VS Code 亮暗配色 + 编辑器 + 标签栏样式
└─ lib/                       # 构建产物（不入库，`pnpm run build` 生成）
```

## 前置要求

- 本地可运行的 DSH web（插件 RPC 通道仅限 loopback）
- Node.js ≥ 18 与 pnpm
- 本文档以 Windows 为例；macOS/Linux 路径同理（`~/.dsh`）

## 构建

```powershell
pnpm install
pnpm run build      # 产出 lib/index.js（host）与 lib/client.js（browser）
pnpm run watch      # 开发热更
pnpm run typecheck  # 可选（tsdown 本身不做类型检查）
```

## 安装与启用

> **兼容性**：布局补丁针对 `dsh-client-ui-layout@0.1.0-rc.6` 的编译产物编写；
> 其他 DSH 版本需先按新产物更新 `scripts/patch-layout.mjs` 里的锚点。

本包是一个标准 DSH bundle（`package.json` 声明 `dsh.bundle`，自带
`cordis.patch.yml` 补丁层），推荐用 `dsh plugin` 命令安装：

**方式 A：从 npm 安装（官方推荐）**

```powershell
dsh plugin --profile web add dsh-plugin-workbench
```

**方式 B：从 GitHub 安装**

```powershell
dsh plugin --profile web add github:Pasumao/dsh-plugin-workbench
```

> git 安装会在安装时通过 `prepare` 脚本构建；pnpm 默认拦截构建脚本，
> 按提示把包名加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑。

**方式 C：本地路径（开发调试）**

```powershell
dsh plugin --profile web add C:/path/to/dsh-plugin-workbench
```

**手动安装（不用 `dsh plugin` 命令时）**

1. 在 `<DSH_HOME>/profiles/web/package.json` 的 dependencies 加入
   `"dsh-plugin-workbench": "^0.0.1"`，然后 `cd <DSH_HOME>/profiles/web && pnpm install`
2. 把本包根目录 `cordis.patch.yml` 的内容追加到 profile 的 `cordis.patch.yml`
   （loader 条目）

**以上所有方式装完后，还需要打布局补丁**（bundle 层只注入 loader 条目，
不会改写布局编译产物）：

```powershell
node node_modules/dsh-plugin-workbench/scripts/patch-layout.mjs
```

> pnpm 安装时包体在只读 store 中，备份目录可能无法写入；此时可省略备份
> （脚本仍会继续），或改用 link 方式安装。

最后重启 dsh web。

## 验证

```powershell
# 插件 bundle 可访问（200）
Invoke-WebRequest http://127.0.0.1:3080/plugins/dsh-plugin-workbench/client.js
# 布局 bundle 已打补丁（含 explorerCol / conversationSeat / renderSlot("explorer.preview")）
Invoke-WebRequest http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-client-ui-layout/client.js
```

RPC 自测（loopback，`path` 换成你要列出的目录）：

```powershell
$body = @{ type='client-request'; rpcId='t'; method='list';
           payload=@{ path='C:\path\to\workspace' } } | ConvertTo-Json -Depth 5
Invoke-WebRequest http://127.0.0.1:3080/dsh-plugin-files/list -Method POST `
  -ContentType 'application/json' -Body $body -UseBasicParsing
```

## 回滚

1. `dsh plugin --profile web remove dsh-plugin-workbench`（手动安装时：从 profile
   `package.json` 移除依赖并删除 profile `cordis.patch.yml` 中对应 insert）。
2. 还原布局 bundle：把 `patches/layout.backup/client.js.orig` 覆盖回
   `@deepseek-ai\dsh-client-ui-layout\lib\client.js`（npx-cache 副本）。
3. 重启 dsh web。

## dsh 升级后

`npm`/`npx` 重装 `@deepseek-ai/dsh` 会覆盖布局 bundle，升级后重新执行
`node scripts/patch-layout.mjs`。若脚本报 "anchor not found"，说明编译产物结构
变了，需按新 bundle 更新 `scripts/patch-layout.mjs` 里的锚点。插件本身是
bundle 依赖，升级用 `dsh plugin --profile web update dsh-plugin-workbench`
（本地 link 开发时 `pnpm run build` 重建即可）。

## 说明

- `/dsh-plugin-files` 通道仅限 loopback（与产品既有安全模型一致）。
- 文件树自动刷新为 2 秒轮询（与 DSH 自带 HMR 的轮询机制一致），只重列可见目录。
- 编辑保存为无条件写回；保存失败会在编辑区右下角提示，标签保持脏标记。
- 明暗主题只作用于文件浏览器（`data-fe-theme`），不影响聊天区与皮肤。
- 本仓库不包含 DSH 的任何编译产物；`patches/layout.backup/` 由补丁脚本按需生成。

## 参与贡献

欢迎提交 Issue 与 PR！请先阅读 [CONTRIBUTING](./CONTRIBUTING.md)（开发环境、
提交检查清单、代码规范）与 [CODE_OF_CONDUCT](./CODE_OF_CONDUCT.md)。
完整变更记录见 [CHANGELOG](./CHANGELOG.md)，安全相关事项见 [SECURITY](./SECURITY.md)。

## AI 生成声明

本项目的部分内容（包括部分源码、本文档与工程化配置）由 AI 辅助编码工具
（DeepSeek Harness）生成。所有 AI 生成内容均经过人工审查、类型检查、编译验证
与实机测试；涉及权限与文件系统的逻辑（`src/index.ts` 的 RPC 端点、
`scripts/patch-layout.mjs`）已按最小权限原则人工复核。项目以 MIT 许可开源，
欢迎任何人审计、修改与分发。

## License

[MIT](./LICENSE)
