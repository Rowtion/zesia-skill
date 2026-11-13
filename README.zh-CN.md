[English](README.md) | 简体中文

# 则灵（zesia）共享客户端

共享 Skill、本地咨询资料与授权流程，以及官方 A2A CLI 传输。云端顾问与公开客户端独立。

0.4 版本使用同一个 `https://zesia.dev/consult` 网页。临时本地桥只展示不可变草稿和只读附件，
用户在网页批准之后才进行云端预检及 A2A 调用。长期 token 不进入网页、网址或消息输入框。
浏览器可能要求允许连接本机 loopback；确认前不通过远程服务器中转草稿，包括密文中转。

## 使用

所有宿主使用同一安装提示词：

```text
Read https://zesia.dev/install.md and install ZESIA for this agent.
```

安装指南以实际已发布版本为准，源码完成不代表新版已经发行。独立可执行文件不要求另装
Node；旧版本兼容脚本保留。不得要求管理员权限、全局 PATH 调整、关闭浏览器安全保护或
公开转发本地端口。

```text
scripts/zesia configure --token-file <私密凭证文件>
scripts/zesia prepare <私密资料包.json>
scripts/zesia review <draftId>
scripts/zesia wait <draftId> 900
scripts/zesia result <draftId>
```

Windows 使用 `.exe`。凭证和状态保存在本地私密文件中；准备命令仅返回简短元数据，
资料在网页展示，不再整包塞回聊天。原 Agent 取回完整意见和必要结构化字段。
请求使用稳定 ID，恢复只读同一次云端执行；未知结果不得自动重新推理。
单独的本地收件记录区分“结果已保存”和“原 Agent 已取回”。追问重新准备并批准新资料。
意见不构成新的执行授权。

## 研发与发行

运行 `npm ci --ignore-scripts`、`npm run build`、`npm test`、`npm run package`。
`npm run build:native` 使用固定 Bun 1.3.13 和官方 A2A CLI；用户不需要这些开发环境。
Mac 可执行文件在构建时签名。独立包保留校验和、来源版本、许可证、公开 JS 包及重建说明，
见 [NATIVE-NOTICES.md](NATIVE-NOTICES.md)。所有平台构建和无额外 Node 测试通过后才发布，
不得覆盖已有版本。

浏览器权限、本机桥、各宿主真实会话分别验收；远程/SSH 工作区和未验证浏览器不提前声称支持。
网站脚本是能够读取页面内存的受信代码，本地草稿要求不代表密码学上的服务端不可读取保证。
