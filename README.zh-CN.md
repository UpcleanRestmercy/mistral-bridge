# Mistral Bridge

[English](README.md) | **简体中文**

为 ZCode 和 DeepSeek Harness（DSH）提供 Mistral 协议适配。直接使用各自已有的模型设置和 API Key 输入框，不需要专用配置界面。

代理将 Mistral 的 thinking 内容块转换为宿主的原生思考字段，并保留 Markdown、工具调用和历史。它只监听 `127.0.0.1`。

## 日常使用

- **ZCode：** 在模型选择器中打开「Manage models / 管理模型」，编辑已有提供商的 API Key。插件读取原生配置，自动更新可用模型，不需要手动调用 MCP 工具。保留现有提供商名称和 ID；本机已有的 **Vibe** 和 **Mistral** 不会重命名。
- **DSH：** 在「设置 → 模型」中编辑 **Vibe / Mistral** 的 API Key。桥接路由注册到宿主现有的 `llm-pi-ai` 配置，使用原生 API Key 输入框和凭据服务。保存后的密钥用于后续请求，无需重启。
- 未指定模型白名单时，从账号的 `/v1/models` 获取全部聊天模型，不再只显示 `zai-glm-latest`。图片、思考和上下文能力按上游声明填写；嵌入、语音等非聊天模型不会混入。
- 旧 `.env` 仍可用于初始导入。DSH 首次导入时把密钥交给宿主凭据服务；之后可直接在原生界面修改。ZCode 原生界面填写的密钥优先于旧 `.env`。
- 更换密钥的同步可能需要几秒；ZCode 每 5 分钟刷新模型，失败时按 2、4、8 秒递增退避，最长 60 秒后重试。重新打开模型选择器即可。首次升级插件需要加载新版本代码；这与日常换密钥是两回事。

**API Key** 字段填写 Mistral 的真实密钥；**API 地址 / Base URL** 显示 `http://127.0.0.1:<自动端口>/v1`，由插件维护。不要把端口号填进 API Key，也无需手动修改代理地址。

原生界面保存密钥的位置和访问规则由各自宿主管理。桥接层不把密钥放进聊天记录、MCP 参数或诊断输出。

## 获取源码与环境

需要 Git 和 **Node.js 20.12 或更新版本**。ZCode 的 `.mcp.json` 执行 `node`，因此 **ZCode 宿主进程的 PATH** 必须能找到它；只在 WSL 或某个终端安装 Node 不代表 Windows GUI 能找到。安装 Node 后重新打开宿主。

Windows PowerShell：

```powershell
node --version
Get-Command node
git clone https://github.com/UpcleanRestmercy/mistral-bridge.git
Set-Location mistral-bridge
$BridgePath = (Get-Location).Path
```

macOS / Linux：

```sh
node --version
command -v node
git clone https://github.com/UpcleanRestmercy/mistral-bridge.git
cd mistral-bridge
```

ZCode 接口参考为桌面版 **3.17.1** 的插件市场与 v2 模型配置；尚未建立更早版本的最低兼容边界，也未完成全新 GUI 安装验收。DSH 集成验证针对 **0.2.1-rc.5**，声明的适配范围为 `>=0.2.1-rc.5 <0.3.0`；使用 DSH 自带 Node 或遵循它的运行时要求。

## 安装到 ZCode

打开 **设置 → 插件管理 → 发现 → `+`**，添加克隆后的目录（目录内含 `marketplace.json`），或添加本仓库的 Git URL。在发现页找到 **Mistral Bridge** 并点击安装，再到已安装页确认启用。仓库同时包含插件清单和 `.mcp.json`；MCP 加载后自动启动代理并同步模型。ZCode 使用不需要 `npm install`。

全新安装会自动创建一个尚未填写密钥的 **Mistral** 提供商，同时自动设置本地 API 地址。直接打开「管理模型」，填写真实 Mistral API Key 并保存即可；不需要 `.env`、代理端口或手工调用工具。旧 `.env` 中的账号仍可自动导入。

旧版和新版留下相同账号的重复项时，只在实际密钥相同或引用明确指向同一账号时合并；优先保留旧名称和旧 provider ID，同时迁移默认选择和手工模型规则。不凭相似名称删除账号。

ZCode 会监视提供商配置变化。日常编辑 API Key 无需退出应用或调用 `sync_mistral`。`MISTRAL_BRIDGE_AUTO_SYNC=0` 可关闭桥接层的自动同步。

`remove_mistral` 只删除桥接持有的连接，并记录显式删除，防止旧 `.env` 再次导入。需要恢复时，主动调用 `sync_mistral` 并传入 `restore_removed: true`；仅保存在原生连接中的密钥被删除后需要重新填写。

## 安装到 DSH

适配 DSH `0.2.1-rc.5` 起、`0.3.0` 之前的接口，Node 版本遵循宿主要求。

安装到实际使用的 profile。插件加载后会自动建立原生模型连接和代理地址；没有旧密钥时，打开「设置 → 模型 → Mistral → 编辑」填写 API Key 即可。Windows 桌面版使用它自带的命令：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "$BridgePath"
```

其他已安装的 DSH：

```sh
dsh plugin --profile web add "$PWD"
```

源码运行可使用 `pnpm dsh plugin --profile web add "$PWD"`。初始导入其他位置的旧 `.env` 时，可在 profile 的 `cordis.patch.yml` 指定：

```yaml
- id: mistral-bridge
  config:
    envFile: C:/Users/your-name/.zcode/.env
```

DSH 使用自己的代理端口，不共享 ZCode 的 daemon。插件卸载时关闭监听器；它生成的连接由原生模型设置持有，使用时需要桥接插件处于启用状态。已有的其他提供商配置保持不变。

在没有原生 settings 服务的程序组合中，插件直接注册同样的 pi-ai 适配器，保留 `.env` 用法。

## Pi 原生 Mistral 扩展

Pi 直接使用原生 `mistral` / `mistral-conversations` 时不经过桥接代理，可安装独立用户扩展：

```sh
node scripts/install-pi.mjs
```

然后在 Pi 中执行 `/reload` 或重新启动。安装器把扩展复制到 `~/.pi/agent/extensions/mistral-request-budget/`，不修改 Pi 版本目录、provider、模型或密钥；源码目录变化和 Pi 更新不会覆盖已安装的扩展。扩展更新时重新运行安装器，卸载时删除该扩展目录并 `/reload`。

扩展通过公开的 `before_provider_request` 钩子计量实际 JSON payload 的 UTF-8 字节，使用 4 MiB 累计 base64 图片目标、8 MiB 完整请求预算，另预留 64 KiB 给原生 provider 的最终字段转换。超限时按先后顺序省略较早截图，保留最新截图，把省略的图片保存到 `~/.pi/agent/mistral-image-archive/`，并在本次请求中留下可恢复路径与通知；会话原始历史保持不变。单张最新截图可超过图片目标，但完整请求仍须满足预算。文本或最新截图仍过大时，明确中止请求，提示使用 `/compact` 或缩小内容，不再把相同超大请求发送上游。

只处理原生 Mistral，独立于 DSH 的卸载机制。已通过 Pi 1.4.0 的真实扩展加载器、事件 runner 和原生 provider 对本地 HTTP 服务的离线检查，未调用付费 API。归档图片自动清理未启用；确认不再需要后可手工删除归档目录。其他扩展若在该钩子之后继续增加请求内容，需要单独检查。

## 旧 `.env` 配置

```dotenv
MISTRAL_API_KEY=your-key
MISTRAL_API_KEY_ARBX=another-key

# 可选白名单。省略时自动发现聊天模型。
# MISTRAL_MODELS=zai-glm-5-3-flash,mistral-large-latest
# MISTRAL_MODELS_ARBX=deepseek-v4-1-flash-1017
```

进程环境变量优先于文件。文件依次查找 `./.env`、`~/.zcode/.env`、`~/.env`，后面的文件只补充缺失值。`MISTRAL_BRIDGE_ENV` 可指定单个文件；DSH 的 `envFile` 可独立指定。

文件使用 `node:util.parseEnv` 解析，支持引号、转义换行和行内注释。包含 `#` 的值应加引号。请勿提交 `.env`。

Windows 下独立 ZCode daemon 无法继承临时进程中的密钥或模型环境变量。启动器会明确拒绝这些覆盖项，避免静默使用其他账号；请使用原生模型设置或 `MISTRAL_BRIDGE_ENV` 指定文件。DSH 在宿主进程内运行，保留正常的环境变量优先级。

## 旧连接升级

新版本独立记录供应商归属，不凭名称接管连接。ZCode 仅在本地端点确认为 Mistral Bridge，或有明确匹配的旧 Mistral 凭据时迁移。DSH 的旧端点已停止时，也可在旧桥接配置结构、原生凭据与显式指定的 Mistral dotenv 导入均匹配后自动迁移，并保存绑定端点的归属标记；此后的冷启动只需要原生凭据。健康探测不发送 API Key。

如果旧端点已停止、无法证明归属，原连接保持原样；同 ID 冲突时拒绝覆盖。可先启动一次旧桥接以完成验证，或在宿主原生模型界面删除过时连接。如果尚未出现新的 Mistral 连接，重新加载一次插件（ZCode 也可调用一次 `sync_mistral` 修复工具），再向新连接填写密钥。这是旧版本的一次性恢复步骤，与日常换密钥无关。

## 代理与兼容行为

ZCode 的代理独立于 MCP 进程，端口按显式 `MISTRAL_BRIDGE_PORT`、记住的端口、`8791..8800`、系统分配的顺序选择。仅复用角色为独立 ZCode daemon、代码与凭据来源指纹均一致的监听器；不复用 DSH 监听器。其他进程占用的端口不会被替换。端口变化后自动更新桥接提供商地址；保留旧 daemon 以免中断其活动请求。

DSH 首次使用系统分配的端口；此后的启动和插件重载优先复用已验证原生连接中的端口，仅在端口不可用时重新分配并同步地址。也可用插件 `port` 显式固定，此时遇冲突会拒绝启动。`autoDiscover` 默认开启，`models` 是发现不可用时的兜底；`contextWindow`、`maxTokens`、`reasoningEfforts`、`visionModels` 和 `idleMs` 可用于部署调整。DSH 原生模型设置中的账号密钥与显示名称由宿主管理。

- `thinking` 块转换为 `reasoning_content`，assistant 历史转回 Mistral 内容块。
- 保留工具 ID、参数片段、结果和 UTF-8 文本。
- SSE 支持 CRLF、注释、多行 `data:`；缺少 finish reason 或 `[DONE]` 时明确失败。
- HTTP 错误保留状态和响应体；桥接路由禁用自动请求重试。
- Mistral 单次对话请求最多接受 20 张图片；第 21 张会被以 HTTP 503 `Service unavailable`、code `3800` 拒绝，看起来像服务故障。bridge（DSH 与 ZCode）和 Pi 扩展会保留最新 20 张，把本次请求中更早的图片替换为文字说明；会话历史不变。proxy 日志记为 `images_omitted=N`。
- DSH 的累计 base64 图片预算为 4 MiB，超出时由宿主记录卸载决定，并把最旧图片替换为占位文本；附件原件仍由宿主管理。该预算不包含提示词、工具定义和对话文本。
- 代理按转换后的完整 UTF-8 JSON 请求体计量，聊天请求上限为 8 MiB（为实测约 10 MB 的网关拒绝边界留出余量，并非上游公布的限制）。超出时在转发前返回明确的 HTTP 413 `request_too_large`；请压缩会话或新建会话、减少截图或工具输出，原样重试无效。文本过大时也会触发此保护，不会静默删除历史。更新后重载插件或重启 DSH，使已有连接采用新预算。
- `/healthz` 返回服务角色、版本、指纹、PID、活动请求数和完整请求体上限 `maxRequestBodyBytes`，不含密钥。日志记录请求字节数，不记录提示词、推理或密钥。

自动发现使用上游声明，不等于每个模型都已实际生成验证。模型费用和账号额度以 Mistral 为准。

发现服务故障时保留已有模型及能力；原生 DSH 设置中的元数据在插件重启后仍可保留。缓存元数据不代表当前账号有访问权限，每次请求使用当前密钥。凭据处理与本地信任边界见 [SECURITY.md](SECURITY.md)。

断流重试：上游返回 502/503/504 或连接中断、且尚未向客户端输出任何内容时，bridge 自身会快速重试 2 次（1 秒、3 秒），`proxy.log` 中记为 `retry=`。之后由 DSH 按步骤重试（8 次，退避 2–60 秒，约 4 分钟）；可在 `mistral-bridge` 插件配置中用 `retryPolicy` 覆盖，例如 `{ mode: normal, maxRetries: 4 }`。已经开始输出后的中途断流不会在 bridge 内重试，而是报告为 transport 错误，由 DSH 重新执行整步。

## 验证、升级与卸载

- **验证：** 在 ZCode 插件详情确认 MCP 正常，在模型管理确认 Mistral 连接、填写密钥后出现模型；DSH 在设置 → 模型检查。可对该连接地址去掉 `/v1` 后的 `/healthz` 发起 GET，确认 `service: mistral-bridge` 与版本 `1.0.0`；这只证明监听器健康，不代表上游生成成功。
- **启动失败：** 先检查 GUI 的 Node PATH；再看 ZCode 的 `~/.zcode/mistral-proxy/proxy.log` 或 DSH 的插件错误。Windows 的 `~` 是用户目录。模型发现临时失败会保留旧模型并重试；401 请检查原生密钥。不要分享未脱敏日志或配置。
- **升级：** 本地目录安装先在源码目录 `git pull --ff-only`，再通过宿主插件管理更新或重新加载；Git 市场安装使用市场更新入口。请勿在文件覆盖过程中反复启停插件。ZCode 已存在的独立代理可能保留以完成活动请求，新 MCP 会选用匹配版本的代理。DSH 重载时关闭自身监听器并同步连接地址。
- **卸载：** 在宿主插件管理中卸载或禁用，然后在原生模型管理中删除不用的桥接连接。ZCode 独立代理不会随 MCP 退出，待无活动请求后可按健康端点核实的 PID 在任务管理器（Windows）或 `kill PID`（macOS/Linux）停止；不要按通用 `node` 名称批量结束进程。DSH 卸载会自动关闭监听器。最后再删除源码目录；不要删除宿主的整个设置或凭据目录。

## 测试

```sh
npm test
# Node 24：安装锁定的开发依赖，再运行 DSH 本地集成测试：
npm ci --ignore-scripts
npm run test:dsh
```

离线检查不调用付费 API。以下可选在线冒烟测试**仅适用 ZCode**，支持原生模型密钥和旧 dotenv；使用合成提示词并消耗少量额度。DSH 的原生密钥请在其界面中进行生成验证：

```sh
node live-smoke.mjs default zai-glm-latest
```

发布包也包含离线测试，可运行 `npm run test:package` 验证实际打包内容。完整贡献和发布步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

MIT，见 [LICENSE](LICENSE)。
