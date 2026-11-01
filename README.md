# Mistral Bridge

**English** | [简体中文](README.zh-CN.md)

Mistral protocol support for ZCode and DeepSeek Harness (DSH). Use each host's existing Models settings and API Key field; no separate configuration UI is needed.

The loopback proxy converts Mistral thinking blocks into native reasoning fields while preserving Markdown, tool calls and history.

## Everyday use

- **ZCode:** open **Manage models** from the model picker and edit the existing provider's API Key. The bridge reads native provider settings and synchronizes the model list automatically. Existing names and provider IDs are preserved, including the user's **Vibe** and **Mistral** connections.
- **DSH:** edit **Vibe / Mistral** under **Settings → Models**. The bridge configures the host's existing `llm-pi-ai` routes, so the standard API Key editor and credential service own the key. Changes reach subsequent requests without restarting.
- Unless a model allowlist is specified, discover every chat model advertised by the account's `/v1/models` endpoint. Vision, reasoning and context capabilities follow upstream declarations; non-chat models are excluded.
- Legacy `.env` files remain supported for import. DSH imports keys into its credential service; ZCode's native provider credentials take precedence over the legacy file.
- Key changes synchronize within a few seconds. ZCode refreshes models every five minutes; failures retry after 2, 4, 8 seconds, capped at 60 seconds. Reopen the model picker. Loading a new plugin version is separate from routine API-key edits.

The **API Key** field takes the real Mistral key. **API address / Base URL** contains `http://127.0.0.1:<automatic-port>/v1`, maintained by the plugin. Do not put a port number in the key field or replace the managed proxy address.

Each host controls how its native credentials are stored. Bridge tools and diagnostics never expose key material.

## Get the source and runtime

Install Git and **Node.js 20.12 or later**. `.mcp.json` launches `node`, so it must be on the **ZCode host process's PATH**. Node installed only in WSL or a terminal does not make it available to the Windows GUI. Reopen the host after installing Node.

Windows PowerShell:

```powershell
node --version
Get-Command node
git clone https://github.com/UpcleanRestmercy/mistral-bridge.git
Set-Location mistral-bridge
$BridgePath = (Get-Location).Path
```

macOS / Linux:

```sh
node --version
command -v node
git clone https://github.com/UpcleanRestmercy/mistral-bridge.git
cd mistral-bridge
```

The ZCode interface reference is Desktop **3.17.1** with plugin marketplaces and v2 provider settings. A minimum older version and fresh GUI installation acceptance have not been established. DSH integration is tested against **0.2.1-rc.5**; the declared API range is `>=0.2.1-rc.5 <0.3.0`. Use DSH's bundled Node or follow its runtime requirements.

## Install in ZCode

Open **Settings → Plugin Management → Discover → `+`** and add the cloned directory (containing `marketplace.json`), or this repository's Git URL. Find **Mistral Bridge**, click **Get**, and confirm it is enabled in **Installed**. The repository includes both the marketplace and plugin manifests plus `.mcp.json`. The MCP process starts the proxy and synchronizes providers. ZCode use does not require `npm install`.

A fresh installation creates an unconfigured **Mistral** provider and sets its local API address automatically. Open the native Models editor, enter the real Mistral API key, and save. No dotenv file, manual port selection or tool call is required. Existing dotenv accounts remain importable. Never send a key through chat.

Duplicate connections from older versions are merged only when their actual key or explicit credential reference identifies the same account. The old name and provider ID win; default selections and manual model rules are redirected. Similar names alone do not justify removing a connection.

ZCode watches provider configuration changes. Routine key edits require neither application restarts nor `sync_mistral` calls. `MISTRAL_BRIDGE_AUTO_SYNC=0` disables bridge synchronization.

`remove_mistral` removes only bridge-owned connections and remembers the removal, including legacy dotenv imports. To restore removed accounts deliberately, call `sync_mistral` with `restore_removed: true`; a native-only key must be entered again after removal.

## Install in DSH

Compatible with the `0.2.1-rc.5` APIs and subsequent versions before `0.3.0`. Follow the host's Node requirements.

After loading the plugin, open **Settings → Models → Mistral → Edit**, enter the API key, and save. The provider and local address are created automatically. For Windows Desktop, use its bundled command and reserved profile:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "$BridgePath"
```

Other installations:

```sh
dsh plugin --profile web add "$PWD"
```

From a prepared source checkout, use `pnpm dsh plugin ...`. To import a legacy env file elsewhere, set the plugin row in the profile's `cordis.patch.yml`:

```yaml
- id: mistral-bridge
  config:
    envFile: C:/Users/your-name/.zcode/.env
```

DSH owns a separate listener and closes it on unload. Native Models settings retain its connection definitions; the bridge must be enabled to use them. Other providers are preserved. Compositions without the native settings service retain the direct pi-ai adapter and dotenv path.

## Legacy dotenv configuration

```dotenv
MISTRAL_API_KEY=your-key
MISTRAL_API_KEY_ARBX=another-key
# Optional model allowlists; omission enables discovery.
# MISTRAL_MODELS=zai-glm-5-3-flash,mistral-large-latest
```

Process values override file values. Files fill missing values in order: `./.env`, `~/.zcode/.env`, `~/.env`. `MISTRAL_BRIDGE_ENV` selects one file; DSH's `envFile` independently selects its import source. Parsing uses `node:util.parseEnv`. Quote values containing `#`, and do not commit secrets.

Windows detached ZCode daemons cannot inherit transient process key/model overrides. The launcher rejects those overrides instead of silently using another account; use native Models settings or `MISTRAL_BRIDGE_ENV`. DSH runs in the host process and retains normal environment precedence.

## Upgrading legacy connections

New versions record provider ownership separately from names. ZCode can adopt a legacy local connection if its endpoint identifies itself as Mistral Bridge, or if an explicit legacy Mistral credential matches. DSH can also migrate a stopped legacy bridge endpoint when the old bridge profile shape and its native credential match the explicitly configured Mistral dotenv import. It then persists the endpoint-bound marker; subsequent cold starts need only native credentials. No API key is sent during health probes.

If an old endpoint has stopped and ownership cannot be verified, the connection is left untouched; a conflicting provider ID is never overwritten. Start the previous bridge once so it can be verified, or remove the obsolete connection through the host's native Models editor. If the replacement Mistral connection has not appeared, reload the plugin (or call ZCode's `sync_mistral` repair tool once), then enter the key in the new connection. This one-time recovery is distinct from routine key edits.

## Runtime behaviour

ZCode's detached proxy survives MCP exits. Ports are selected from explicit `MISTRAL_BRIDGE_PORT`, the remembered port, `8791..8800`, then an OS-assigned port. Reuse is limited to independent ZCode daemons with matching code and credential-source identities; DSH listeners are excluded. Foreign listeners are never replaced. Provider URLs update when the port changes; existing daemons are retained to avoid interrupting active requests.

DSH initially uses an OS-assigned port. On subsequent starts and plugin reloads it first tries to reuse the endpoint in its verified native connection settings; only an unavailable port triggers a new allocation and route update. An explicit plugin `port` remains fixed and refuses conflicts. `autoDiscover` defaults to true; `models` supplies fallback IDs. Capacity, effort, vision and idle-timeout options remain available for deployment adjustments.

- Translate thinking blocks to `reasoning_content` and assistant history back to Mistral blocks.
- Preserve tool IDs, argument fragments, results, Markdown and UTF-8 boundaries.
- Parse SSE events with CRLF, comments and multiline data. Incomplete streams fail explicitly.
- Retain upstream HTTP errors. Bridge routes disable automatic request retries.
- Health and logs contain request metadata rather than prompts, reasoning or API keys.

Discovered capabilities are upstream declarations, not proof that generation was tested on every model. Pricing and quota remain account-specific.

Discovery outages retain existing model metadata, including native DSH settings after a restart. Cached metadata does not grant access to a model; each request uses the current key. See [SECURITY.md](SECURITY.md) for credential handling and the local trust boundary.

## Verify, upgrade and uninstall

- **Verify:** check the plugin's MCP status in ZCode, then open Models and confirm the Mistral connection and discovered models after entering a key. In DSH use Settings → Models. GET the connection's `/healthz` URL (replace `/v1`) and check `service: mistral-bridge` and version `1.0.0`. Health proves the listener is running, not that upstream generation works.
- **Troubleshoot:** check Node on the GUI's PATH first, then `~/.zcode/mistral-proxy/proxy.log` or the DSH plugin error. On Windows `~` is your user directory. Discovery failures retain models and retry; for HTTP 401, check the native key. Redact logs and settings before sharing.
- **Upgrade:** for a local directory install, run `git pull --ff-only` in the checkout and update/reload through the host's plugin manager. For Git marketplaces, use the marketplace update control. Avoid repeated toggles while copying release files. Existing ZCode daemons may remain for active requests; new MCP sessions use a matching build. DSH reload closes its listener and updates native endpoints.
- **Uninstall:** disable or uninstall in the host's plugin manager, then delete unwanted bridge connections in native Models settings. ZCode's independent daemon survives MCP exit; after requests finish, verify its PID through `/healthz` and stop that process in Task Manager (Windows) or with `kill PID` (macOS/Linux). Do not stop all Node processes by name. DSH closes its listener automatically. Remove the source directory last; do not delete the host's entire settings or credentials directory.

## Tests

```sh
npm test
# Node 24: install pinned test dependencies for real DSH components/local fixtures:
npm ci --ignore-scripts
npm run test:dsh
```

Optional paid **ZCode-only** smoke test using native Models credentials or legacy dotenv and synthetic prompts. DSH native keys require a generation check in its own UI:

```sh
node live-smoke.mjs default zai-glm-latest
```

The archive includes offline tests. Run `npm run test:package` to verify the actual package. See [CONTRIBUTING.md](CONTRIBUTING.md) for reproducible contributor and release checks.

MIT. See [LICENSE](LICENSE).
