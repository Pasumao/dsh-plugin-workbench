# dsh-plugin-workbench

![License](https://img.shields.io/github/license/Pasumao/dsh-plugin-workbench)
![CI](https://img.shields.io/github/actions/workflow/status/Pasumao/dsh-plugin-workbench/ci.yml?branch=main)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Stars](https://img.shields.io/github/stars/Pasumao/dsh-plugin-workbench?style=social)
![AI Assisted](https://img.shields.io/badge/AI-Assisted-8A2BE2)

DSH Web GUI 的 VS Code 风格文件浏览器插件：文件树 + 可编辑代码预览
（语法高亮、标签页），每个工作区独立保存状态。**需要布局补丁**（见下）。

## 功能

- 文件树：懒加载、2 秒自动刷新、每工作区独立展开状态
- 文件图标：常见格式显示着色徽章（代码）/ emoji（图片、音视频、压缩包等），目录展开/收起区分
- 可编辑预览：透明 textarea 叠加语法高亮，`Ctrl+S`/`Cmd+S` 保存；
  md/.txt 等散文格式与超大代码文件自动降级为纯文本编辑，加载快、不卡界面
- 自动换行：标签栏一键切换软换行（仅显示层换行，不改动文件内容）或长行横向滚动，偏好持久化
- 标签页：多文件、拖拽排序、收起/弹出；亮暗主题一键切换
- 语法高亮：highlight.js（JS/TS、Python、JSON、HTML、CSS、Shell 等；Markdown 以纯文本显示）

## 安装

> 布局补丁针对 `dsh-client-ui-layout@0.1.0-rc.6` 编写，其他版本需更新锚点。

```powershell
# npm（推荐）
dsh plugin --profile web add dsh-plugin-workbench
# 或 GitHub
dsh plugin --profile web add github:Pasumao/dsh-plugin-workbench
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

- `/dsh-plugin-files` RPC 通道仅限 loopback；写操作显式以 `danger-full-access` 执行
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
