# 参与贡献

欢迎任何形式的贡献：提 Issue、修 Bug、加功能、改进文档。开始之前请先阅读
[README](./README.md) 了解项目架构（host/client 双半部 + 布局补丁）。

## 开发环境

```powershell
git clone https://github.com/Pasumao/dsh-plugin-workbench.git
cd dsh-plugin-workbench
pnpm install
pnpm run build       # 产出 lib/index.js（host）与 lib/client.js（browser）
pnpm run watch       # 开发热更
pnpm run typecheck   # 提交前必须通过
```

> 需要一套本地 DSH web 才能真正运行插件（RPC 通道仅限 loopback）；
> 安装步骤见 README「安装与启用」。

## 提交前的检查清单

- [ ] `pnpm run typecheck` 无错误
- [ ] `pnpm run build` 成功
- [ ] 改动涉及 `src/index.ts`（RPC 端点）时，已复核权限边界：
      `list`/`read` 只读放行，`write` 仅经 loopback + `danger-full-access`
- [ ] 改动涉及 UI 文案时，`locales.ts` 中 zh/en 同步更新
- [ ] 新增 CSS 时使用 `files.module.css` 中的变量（亮暗主题自动适配）

## 代码规范

- TypeScript 严格模式（`strict: true`）；不通过 `any` 绕过类型检查
- CSS Modules；颜色一律走 `--fe-*` 主题变量，不写死
- 组件通过 slot 注入的 props 取数据，不直接触碰全局状态
- 提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：
  `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 等

## 如何提 PR

1. Fork 本仓库，从 `main` 开一个功能分支（如 `fix/tree-refresh`）
2. 在分支上完成改动并补齐上述检查
3. 提交后推送，创建 Pull Request，描述改动动机与验证方式
4. 维护者 review 后会合并或给出反馈

## 布局补丁（scripts/patch-layout.mjs）的注意事项

该脚本对 DSH 编译产物做精确字符串替换。改动它之前：

- 先确认你的 DSH 版本与 `patches/layout.backup/` 中原版匹配（升级后需重新生成）
- 每个替换项都有 `id` 与唯一锚点；锚点失效时脚本会中止并提示
- 涉及 UI 布局结构时，同步更新 README 的架构图

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT](./CODE_OF_CONDUCT.md)。
