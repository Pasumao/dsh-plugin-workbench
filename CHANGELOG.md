# Changelog

本项目所有重要变更都会记录在此文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.0.3] - 2026-08-16

### Added

- 文件图标：常见格式按扩展名显示着色徽章（TS/JS/PY/HTML/CSS 等代码文件）、
  emoji（图片、音视频、压缩包、Office 文档、安装包等），目录展开/收起图标区分
- 自动换行开关：标签栏一键在「软换行（仅显示层换行，不改动文件）」与
  「长行横向滚动」之间切换；偏好写入 localStorage 持久化
- 高亮层与编辑层滚动槽对齐、tab 缩进对齐修复

## [0.0.1] - 2026-08-14

### Added

- 初始版本发布（https://github.com/Pasumao/dsh-plugin-workbench）：
  - VS Code 风格文件树列：跟随会话工作区、懒加载展开、每 2 秒自动刷新
  - 可编辑分栏预览：语法高亮层 + 透明 textarea、`Ctrl+S`/`Cmd+S` 保存、
    脏标记圆点、保存失败提示
  - 标签页：多文件同时打开、点选/拖拽排序/逐个关闭、收起/弹出
  - 明暗主题：VS Code 亮色/暗色配色一键切换（独立于 app 皮肤）
  - 按工作区隔离：每个 cwd 各自保存标签、激活文件、收起与展开状态
  - 内置 highlight.js：JS/TS、Python、JSON、HTML/XML、CSS、Markdown、Shell、
    Java、C/C++、C#、Go、Rust、SQL、YAML、INI
  - 布局补丁脚本 `scripts/patch-layout.mjs`：4 列布局 + explorer 槽位 +
    中心分栏（幂等、可回滚、锚点校验）
  - MIT 许可
