# 安全政策

## 支持的版本

| 版本 | 支持状态 |
| ---- | -------- |
| main 分支 | ✅ 积极维护 |
| 历史 release | ⚠️ 仅修复高危问题 |

## 报告漏洞

请**不要**公开提交包含漏洞细节的 Issue。请通过 GitHub 的
**Private vulnerability reporting**（仓库主页 → Security → Report a vulnerability）
提交报告，或直接联系维护者（见仓库主页）。

报告时请包含：

- 受影响的版本与 DSH 版本
- 复现步骤（尽量精简）
- 影响评估（例如：是否可越权读写文件系统）

## 处理流程

1. 确认漏洞并评估影响（一般 3 个工作日内回复）
2. 修复并发布补丁版本
3. 修复发布后再公开披露细节

## 已知风险与边界

本项目是一个浏览器端插件，与 DSH web 同源运行：

- `/dsh-plugin-files` RPC 通道**仅限 loopback**（host 侧以 `authority: 'loopback'`
  注册，与产品既有安全模型一致）
- 写操作（`write` 端点）显式以 `danger-full-access` 策略执行——与 DSH `/api`
  写工具的权限模型等价，任何改动需同时复核这两处的权限边界
- 布局补丁（`scripts/patch-layout.mjs`）会改写本地 DSH 编译产物，升级 DSH 后
  需重新执行；请确认脚本来源后再运行
