[English](README.md) | 简体中文

# 则灵（zesia）· 通用 Skill 与 Runtime

面向支持本地 Skill 和命令的 Agent 提供独立咨询。原 Agent 整理证据，用户审阅后发送，云端顾问通过 A2A 返回建议；不依赖原生按钮。

## 安装

```text
Read https://zesia.dev/install.md and install Zesia for this agent.
```

[固定版本发行页](https://github.com/Rowtion/zesia-skill/releases)提供通用 Skill ZIP、校验文件、源提交信息，以及各宿主适配依赖的 `@zesia/runtime` tarball。官网可能分发另行验证过的版本。

验证并解压 Skill，将其安装到宿主规定的目录，再运行：

```sh
node <skill-directory>/scripts/install-a2a.mjs
node <skill-directory>/scripts/zesia.mjs --help
node <skill-directory>/scripts/configure.mjs
```

需要 Node.js 20+ 和正常文件/命令权限。传输安装器只在安装时下载官方 a2a-cli 0.4.0，核对固定平台 SHA-256 并保留 Apache-2.0 许可证。不要求管理员权限、全局可执行文件或私有仓库。试用 token 在终端隐藏输入，不要发到聊天里。

## 咨询流程

- `prepare <packet.json>`：创建私有本地草稿，零网络请求。
- `send <draftId> <approvedHash> <confirmation.txt>`：明确确认后发送已审阅的原稿。
- `result <draftId>`：读取本地缓存结果，不调用模型。
- `followup <draftId> <answers.json>`：在同一 A2A 上下文准备后续草稿，重新审阅并确认后再发送。

参阅 [SKILL.md](SKILL.md) 和[资料格式](references/packet.md)。`requester` 和 `project` 分别填写实际 Agent 名称与用户项目；这些标签不代表认证身份或所有权。

默认配置保存在 `~/.config/zesia/agent.json`，私有草稿与结果保存在 `~/.local/state/zesia/consult`，不得提交 Git。只发送选定且批准的资料；未知结果不自动重试。云端无状态，`contextId` 只关联多轮请求，不会取回隐藏历史。

Runtime 负责本地证据、确认、凭证和结果处理。官方 CLI 通过瞬时 localhost 守卫向固定地址转发一次批准的请求，真实 token 不交给 CLI。本项目是本地适配 Runtime，不是单独发行的远程 SDK 或 Consult MCP 服务。

## 开发

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run package
```

先发布本 Runtime，再更新消费端。锁文件的 integrity 必须取自实际已发布的不可变 tarball，并验证空缓存安装；本机与 CI 的包即使内容相同，字节也可能不同。在 `main` 显式触发发行，不能覆盖版本。参见 [LICENSE](LICENSE) 和[第三方声明](THIRD_PARTY_NOTICES.md)。
