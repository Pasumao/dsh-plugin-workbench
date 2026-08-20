# dsh-plugin-workbench

![npm version](https://img.shields.io/npm/v/dsh-plugin-workbench)
![License](https://img.shields.io/github/license/Pasumao/dsh-plugin-workbench)
![CI](https://img.shields.io/github/actions/workflow/status/Pasumao/dsh-plugin-workbench/ci.yml?branch=main)
![Stars](https://img.shields.io/github/stars/Pasumao/dsh-plugin-workbench?style=social)
![AI Assisted](https://img.shields.io/badge/AI-Assisted-8A2BE2)

**能直接改文件的 VS Code 风格工作台**——不是只读预览：文件树 + 可编辑代码预览
（语法高亮、标签页、行号栏）+ 右键文件操作（新建 / 重命名 / 删除 / 复制 / 剪切 /
粘贴 / 在系统中打开 / 在资源管理器打开）+ 图片内联预览，每个工作区独立保存状态。
装上之后，DSH 网页就是一个轻量代码编辑器。

> ⚠️ 安装后需打一个布局补丁（见下方安装节）。

## 功能

- 文件树：懒加载、2 秒自动刷新、每工作区独立展开状态
- 文件图标：常见格式显示着色徽章（代码）/ emoji（图片、音视频、压缩包等），目录展开/收起区分
- 可编辑预览：透明 textarea 叠加语法高亮，`Ctrl+S`/`Cmd+S` 保存；
  md 默认渲染预览（源码/渲染一键切换），.txt 等散文格式与超大代码文件
  自动降级为纯文本编辑，加载快、不卡界面
- **磁盘变更同步**：打开的文件被外部修改（如 agent 或其它编辑器保存）时，
  干净标签页自动重读，带未保存编辑的标签页显示「⟳」徽标（点击重新加载）
- **行号栏**：编辑器左侧逻辑行号，与文本滚动锁定对齐（纯文本/高亮模式均生效）
- **图片预览**：png/jpg/gif/webp/avif/svg 等直接内联渲染（同源字节路由，20MB 上限）
- **右键菜单**（VS Code 风格）：文件/文件夹/空白区域均可右键——
  新建文件、新建文件夹、重命名、删除（递归带确认）、复制路径、复制 / 剪切 / 粘贴、
  刷新、在系统中打开、
  在资源管理器打开（文件在所在文件夹中被选中，文件夹直接打开；
  Windows `explorer` / macOS `open`，WSL 自动转译）
- **复制 / 剪切 / 粘贴**：Ctrl/Cmd+C/X/V（或右键菜单），支持跨工作区粘贴；
  复制到同名已存在的目标时询问「是否覆盖」，与系统文件管理器一致；
  剪切（移动）成功后自动清空剪贴板
- **批量操作**：Ctrl/Cmd+点击、Ctrl+A 多选，右键菜单/Delete 批量删除选中项，
  拖拽整组移动
- **操作可撤销**：右上角「↩」或 Ctrl+Z 撤销最近操作（每工作区独立、上限 30 条）：
  复制（删副本）、剪切/拖拽移动（移回原位）、重命名、新建、删除；删除为可撤销删除
  （瞬移进隐藏 `.dsh-trash`，不复制字节）
- **在资源管理器打开**：右键菜单项（同 VS Code 的 Reveal in File Explorer），
  把文件/文件夹定位到系统文件管理器（Windows 资源管理器、macOS Finder 等），
  经 loopback RPC 的 `reveal` 端点执行
- 自动换行：标签栏一键切换软换行（仅显示层换行，不改动文件内容）或长行横向滚动，偏好持久化
- 标签页：多文件、拖拽排序、收起/弹出；亮暗主题一键切换
- 语法高亮：highlight.js（JS/TS、Python、JSON、HTML、CSS、Shell 等；
  Markdown 默认渲染预览，可切源码）
- Markdown 渲染：markdown-it（原始 HTML 一律转义不执行），相对路径图片经
  同源路由 `/dsh-plugin-files/raw/<path>` 内联显示
- 磁盘变更：宿主对打开文件做 `fs.watch`（监听父目录，可存活原子重命名），
  变更经 SSE `/dsh-plugin-files/events` 推送，干净标签自动同步

## 配置

无需环境变量或配置文件，安装后打一次布局补丁即可：

- **布局补丁**：`node node_modules/dsh-plugin-workbench/scripts/patch-layout.mjs`
  （针对 `dsh-client-ui-layout@0.1.0-rc.6` 编写，DSH 升级覆盖 bundle 后需重跑）；
- **行为偏好**（自动换行、亮暗主题、标签布局、文件树展开状态）按工作区持久化，无需手动配置；
- **文件操作通道**：经 loopback RPC `/dsh-plugin-files`，写操作显式以 `danger-full-access` 执行，无外部配置项。

## 安装

> 布局补丁针对 `dsh-client-ui-layout@0.1.0-rc.6` 编写，其他版本需更新锚点。

```powershell
# npm（推荐）
dsh plugin --profile web add dsh-plugin-workbench
# 或 GitHub
dsh plugin --profile web add github:Pasumao/dsh-plugin-workbench
```

源码安装（本地开发 / 调试）：

```bash
git clone https://github.com/Pasumao/dsh-plugin-workbench.git
cd dsh-plugin-workbench
pnpm install
pnpm run build     # 产出 lib/index.js 与 lib/client.js
# 以 link: 方式挂载进 profile
```

安装后打布局补丁并重启：

```powershell
node node_modules/dsh-plugin-workbench/scripts/patch-layout.mjs
# 重启 dsh web
```

## 开发

```powershell
pnpm install
pnpm run build       # 产出 lib/index.js（host）与 lib/client.js（browser）
pnpm run typecheck
```

## 卸载

```powershell
dsh plugin --profile web remove dsh-plugin-workbench
# 并还原布局 bundle（patches/layout.backup/client.js.orig → dsh-client-ui-layout/lib/client.js）
```

## 说明

- `/dsh-plugin-files` RPC 通道仅限 loopback；写操作显式以 `danger-full-access` 执行；
  右键菜单的新建/重命名/删除同样经该通道（loopback 信任，与编辑器保存一致）
- 图片预览走同源路由 `/dsh-plugin-files/raw/<path>`：仅响应图片扩展名，
  先经 `ctx.fs.resolve → stat`（沙箱一致的路径解析）再读取字节，20MB 上限
- DSH 升级会覆盖布局 bundle，需重新运行补丁脚本；锚点失效时更新 `scripts/patch-layout.mjs`
- 本仓库不包含 DSH 编译产物

## 参与贡献

见 [CONTRIBUTING](./CONTRIBUTING.md) 与 [CODE_OF_CONDUCT](./CODE_OF_CONDUCT.md)；
变更记录见 [CHANGELOG](./CHANGELOG.md)。

## AI 生成声明

部分源码与文档由 AI 辅助生成（DeepSeek Harness），均经人工审查与实机验证；
权限相关逻辑已按最小权限原则复核。

## License

[MIT](./LICENSE)
