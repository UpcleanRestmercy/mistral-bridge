# Changelog

## 1.1.0

- Add an optional standalone Pi user extension for native Mistral. Measure JSON bytes through the public request hook, archive older screenshots with recovery-path placeholders, preserve session history and the newest screenshot, and explicitly abort requests that still cannot fit. Include a user-directory installer and offline native Pi integration check without editing Pi runtime or credentials.

- Lower DSH's cumulative base64 image budget from 8 MiB to 4 MiB so the host offloads older screenshots earlier.
- Enable DSH request retries: normal mode, 8 retries, 2-60 second exponential backoff with 20% jitter (about four minutes), configurable through the plugin's `retryPolicy` option. Legacy profiles adopt it on migration.
- Retry upstream 502/503/504 and dropped connections twice (1 s, 3 s) inside the bridge before any byte reaches the client. Never retry after streamed output.
- Report transient mid-stream failures as "upstream connection terminated mid-stream" with `providerCode: "network_error_retryable"`, so DSH and Pi classify them as transport errors and ZCode starts stream recovery.
- Fix the mid-stream error frame being discarded: the bridge now breaks the transport only after the frame is flushed (1 s fallback).
- Log DSH listener requests to `proxy.log` with a `dsh` prefix.
- Keep at most 20 images per chat request (bridge and Pi extension). Mistral rejects a 21st image with a misleading HTTP 503 code 3800; older images in that request become text notes and are logged as `images_omitted`.
- Add opt-in `MISTRAL_BRIDGE_CAPTURE_DIR`: failed upstream chat requests are saved there (mode 0600, no key) for replay.
- Guard the complete rewritten UTF-8 chat body at 8 MiB before upstream dispatch, including prompts, tools, text and images. Return an actionable HTTP 413 instead of forwarding a body likely to encounter the observed gateway 503 size rejection. Preserve history and upstream error responses.
- Report request byte counts in metadata-only logs and expose the body limit in health checks. Cover accumulated screenshots, tool/text overhead, UTF-8, rewritten-body boundaries and real DSH adapter offload/replay offline.

## 1.0.0

- Retry failed ZCode model discovery with exponential backoff (2 seconds to 60 seconds), refresh unchanged accounts every five minutes, and serialize manual/automatic synchronization.
- Import legacy dotenv accounts even after native connections exist. Fill empty credentials, add new accounts, preserve native key edits and explicit ZCode removals.
- Capture the daemon build at launcher load and require a startup lease. Failed or abandoned launches terminate their own child without killing unrelated or older listeners.
- Support native ZCode keys and the actual managed endpoint in the paid smoke script; explicitly document that DSH native credentials require a host-side check.
- Add a ZCode marketplace manifest, bilingual installation/upgrade/uninstall steps, pinned DSH integration dependencies, an npm lockfile, Linux/Windows CI and extracted-package tests. Ship tests in the npm archive.
- Publish as Mistral Bridge under UpcleanRestmercy/mistral-bridge with GitHub private vulnerability reporting.


## 0.5.4

- Remove pi-ai's DeepSeek-specific top-level `thinking` switch before forwarding to Mistral, which rejects it with HTTP 422. Preserve `reasoning_effort` and assistant thinking history.
- Reject that field in the local Mistral integration fixture so successful mock streams cannot hide this protocol mismatch.

## 0.5.3

- Reuse the verified native DSH endpoint across plugin reloads and cold starts, falling back only when its port is unavailable. Keep explicitly configured ports strict.
- Test native endpoint updates and bridge reloads through the real Settings and ConfigEditor services, beyond the earlier settings substitute.
- Fix cold upgrades of native DSH connections created before ownership markers existed. When the old listener has stopped, require both the exact legacy bridge profile shape and a native credential matching the explicit Mistral dotenv import before migrating the endpoint.
- Bind migration permission to the verified profile snapshot; a mismatched credential or changed profile cannot grant ownership.
- Cover the real native-loader legacy upgrade, preserved provider identity, and a subsequent cold restart without dotenv keys in the integration test.

## 0.5.2

- Reject foreign Host and Origin headers before resolving local credentials.
- Track ZCode provider ownership by ID and endpoint; bind DSH ownership markers to their endpoint. Verify legacy endpoints without sending credentials before adoption, or use an explicit matching legacy Mistral credential reference in ZCode.
- Preserve model metadata during discovery outages, including native DSH cold starts.
- Restrict removal to owned providers, persist explicit removals, write atomically, and redact malformed-settings errors.
- Retain the first existing literal provider identity during duplicate merging and avoid overwriting concurrent native key edits.
- Require the detached ZCode daemon role and credential-source identity for reuse, and include additional credential-handling modules in the code fingerprint. DSH listeners cannot be reused as ZCode daemons.
- Reject unsupported process key/model overrides for Windows WMI daemons; use native Models settings or an explicit env file.
- Remove private local evidence and logs from the source directory before the open-source review.

## 0.5.1

- Create a native, keyless Mistral provider on fresh ZCode and DSH installations.
- Set the local API endpoint automatically so initial setup needs only the existing API-key field.
- Add isolated fresh-install checks, including discovery after the first DSH credential save.

## 0.5.0

- Reuse the existing ZCode and DSH Models API-key editors; no dedicated UI.
- Read ZCode native provider credentials without resetting them from legacy dotenv.
- Configure DSH native pi-ai routes and import legacy keys into its credential service.
- Discover all advertised chat models with per-model capabilities.
- Merge verified duplicate ZCode accounts while preserving legacy provider IDs and names.
- Update provider configuration automatically and retain active daemon listeners during upgrades.

## 0.4.0

- Add a native DSH Cordis bundle and the `mistral-bridge/dsh` entry point.
- Register one DSH route per Mistral account through the host's public pi-ai adapter, alongside existing providers.
- Keep keys out of DSH configuration and resolve them through a per-plugin proxy with an isolated optional env file.
- Scope DSH listener and route cleanup to plugin unloading; use OS-assigned ports by default without changing ZCode's daemon or configuration.
- Expose model, vision, reasoning, capacity and timeout options; disable automatic request retries.
- Add local lifecycle/isolation checks and a real-host integration test for streaming reasoning and tool replay.
- Sync ZCode provider config from `.env` automatically when the MCP server starts;
  `MISTRAL_BRIDGE_AUTO_SYNC=0` disables it.

## 0.3.0

- API keys are read from `.env` instead of MCP tool arguments.
- `.env` resolution follows the oh-my-pi convention: the process environment wins, then
  `./.env`, `~/.zcode/.env`, and `~/.env` fill only unset keys, parsed with
  `node:util.parseEnv`.
  - `MISTRAL_API_KEY` maps to `mistral-default`.
  - `MISTRAL_API_KEY_<NAME>` maps to `mistral-<name>`.
  - `MISTRAL_MODELS` and `MISTRAL_MODELS_<NAME>` set model lists.
- ZCode's provider config now stores `env:<name>`; the proxy resolves the real key per
  request and returns `401 missing_env_key` when it is absent.
- Provider IDs no longer derive from key characters.
- `configure_mistral` is replaced by `sync_mistral`, which syncs every key and removes
  providers whose key was deleted from `.env`.
- The proxy selects its port automatically and remembers it in
  `~/.zcode/mistral-proxy/state.json`. Explicit `MISTRAL_BRIDGE_PORT` still wins.
- The core fingerprint covers `proxy.mjs` and `env.mjs`, so an older daemon is never
  reused silently.
- The standalone launcher finds the installed plugin by name instead of a hard-coded
  marketplace ID.
- Local acceptance artifacts and machine-specific paths were removed from the repository.

## 0.2.1

- The HTTP listener moved into a detached daemon, so closing MCP stdin or terminating the
  MCP process tree no longer stops the proxy.
- Port reuse requires a matching core fingerprint.

## 0.2.0

- Thinking blocks map to `reasoning_content`; assistant history maps back to Mistral
  `ThinkChunk` blocks.
- SSE parsing handles split UTF-8, CRLF, comments, and multi-line data fields.
- Truncated streams fail explicitly and are never retried after partial output.
- Tool call IDs and argument fragments are preserved.
- Flash models declare image input support.

## 0.1.0

- Initial provider mapping and local proxy.
