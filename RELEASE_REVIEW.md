# Release verification: 1.0.0

The 0.5.4 review identified failures in discovery recovery, late legacy credential imports, upgrade/startup process cleanup, installation instructions, native-key smoke testing and reproducible package verification. Version 1.0.0 addresses these with regression tests, a marketplace manifest, pinned development dependencies and CI.

Local verification on Linux and Windows for this release uses synthetic credentials and local HTTP fixtures: **60/60 offline tests**, **3/3 real DSH integration tests** installed from the pinned public dependency graph, and **60/60 tests from the extracted npm archive**. Regression coverage includes automatic retry/refresh scheduling, a real MCP startup HTTP 503 followed by timer-driven recovery, late imports and native-key priority, a source upgrade after launcher import, failed-startup cleanup and native-only ZCode smoke-script configuration.

The ZCode installation instructions use the installed 3.17.1 interface reference. This is not a fresh GUI installation acceptance run. This release does not claim a new paid API test or every-model compatibility. Earlier limited online evidence is preserved below with its original scope.

The original working directory contained no Git metadata. The 1.0.0 publication starts a new repository history from the reviewed source; it does not reconstruct or audit unavailable historical commits. Release checks inspect this new history and the actual archive for common credential patterns; no pattern scan can prove that every possible secret format is absent. GitHub private vulnerability reporting is the release's private feedback channel.

---

# Open-source review: 0.5.2

**Superseded by a real upgrade regression:** after this review, an existing DSH installation cold-started with a stopped legacy endpoint and no ownership marker. Version 0.5.2 refused to update that connection, producing a transport connection error. The fresh-install tests below did not cover that upgrade state; their passing results were insufficient to establish upgrade compatibility. Version 0.5.3 adds credential-verified migration for the exact legacy bridge layout and extends the real-loader integration test through both the upgrade and a later cold restart without dotenv keys. The original review evidence below applies to its recorded 0.5.2 snapshot, not to a renewed independent approval of 0.5.3.

## Follow-up verification: 0.5.4

The reported connection failure persisted after the first repair: a later plugin reload allocated another ephemeral port, leaving native routes behind. Automatic mode now tries the verified existing endpoint first and allocates a replacement only if that port is unavailable. Explicit ports remain strict. The affected local installation was configured with a fixed port so its current native routes and listener remain aligned.

A bounded live request through the installed Windows Desktop runtime then revealed a separate HTTP 422: pi-ai's DeepSeek dialect emitted a top-level `thinking` switch that Mistral rejects. Version 0.5.4 removes that switch while preserving `reasoning_effort` and assistant thinking history. The local integration fixture now rejects this field too.

Verification after these fixes:

- WSL/Linux and native Windows offline suites: **52/52 passed on each**.
- Integration suite: **3/3 passed**, now including real Settings and ConfigEditor profile reconciliation, native endpoint persistence, and bridge reloads. The earlier settings substitute remains covered separately.
- The installed Windows Desktop DSH components, current native provider profiles, saved credentials, and running bridge completed one minimal synthetic generation for each of the two affected accounts. Both returned `OK` with finish state `stop`.

The live verification used a separate minimal LLM context with the installed components; it did not resubmit the user's existing conversation or prove every GUI/agent-loop action. It consumed bounded live generation, unlike the original review below. These follow-up checks were performed by the primary agent and are not a new independent reviewer approval. No private profiles, credentials, screenshots, or diagnostic logs were added to this source directory.

## Original independent review

Reviewed on 2026-11-01 UTC. An independent reviewer inspected the source, reproduced failures with synthetic credentials, and checked the fixes. No unresolved substantive finding remained in the reviewed source or npm archive. This is bounded evidence, not a guarantee against every defect or disclosure.

## Findings and fixes

| Finding | Resolution |
| --- | --- |
| Private local evidence contained real provider credentials. | Moved the evidence and local logs to a private backup outside this source directory. Neither the current source nor the npm archive contains those credentials. |
| Foreign Host/Origin requests could use locally saved keys. | Reject these requests before health handling, key resolution, or upstream access. Independently reproduced and rechecked. |
| Mistral-like provider names could cause unrelated gateway credentials to be sent upstream. | Verify ownership by provider ID and endpoint, endpoint-bound DSH markers, or explicit legacy migration evidence. Health probes contain no credentials. Foreign providers remain unchanged. |
| ZCode could reuse a DSH listener with a different account and lifecycle. | Require the independent ZCode daemon role, code fingerprint, and credential-source identity. DSH listeners are rejected. |
| Discovery failures discarded model lists or capabilities. | Retain existing metadata during outages, including native DSH cold starts and ZCode model rules. Current credentials remain independent of cached metadata. |
| Removal could delete unrelated providers or recreate deleted accounts. | Restrict removal to owned connections, write atomically, persist removals across synchronization and restart, and require explicit restoration. |
| Duplicate literal credentials could replace an older provider identity. | Preserve the first existing literal identity and associated selections. Reject stale synchronization results if a native key changes during discovery. |
| Error messages could quote private malformed input. | Use fixed messages for settings parsing and model-discovery transport/JSON failures. |

Windows WMI launchers also reject unsupported transient process key/model overrides rather than silently losing them. Native Models credentials and explicit private env files remain supported. Older unverified connections fail closed; the bilingual README describes the one-time recovery procedure.

## Verification

- Offline suite: **49/49 passed** independently on WSL/Linux; the primary agent also ran **49/49 on native Windows Node**, including WMI daemon startup and parent process termination.
- Real DSH source and pi-ai components: **2/2 integration tests passed**, independently repeated. These use local HTTP fixtures; the native settings mutation layer is a test substitute that invokes the real loader.
- Independent MCP probes covered fresh installation, native key entry, discovery, removal authorization, persistence across timer/restart, explicit restoration, and absence of key material in RPC results.
- Actual package extraction: syntax checks passed for **15 modules**; core and lazy DSH entry imports passed.
- No paid generation calls, application restarts, publication, or plugin reinstallations were performed for this review.

## Disclosure checks

The reviewer scanned the 34-file source snapshot and the actual 26-file npm archive. The primary agent separately checked this added review record. Two known live credential values, personal home-directory literals, and common private-key/token patterns had no matches. The archive excludes private dotenv files, host profiles, backups, evidence, logs, runtime state, and test files; `.env.example` contains placeholders only.

The earlier private evidence was preserved outside the project, rather than deleted. Its previous exclusion from npm and `.gitignore` was insufficient protection for someone uploading the whole directory, so it was physically removed from the release source.

Reviewed archive: `mistral-bridge-0.5.2.tgz`

SHA-256: `1707eb9dd9423b2c882f2dd1eb7a30de396523393461877d31c4815fb87cbc65`

## Limits

This directory has no `.git` metadata, so historical commits and remote history were not checked. No fresh GUI click-through or paid generation across every online model was performed. Native host credential storage, upstream capability declarations, and a trusted local OS remain external assumptions. The reviewer inherited the conversation, while independently verifying the source and local reproductions.

Running applications must load the new version to receive its fixes. No remote repository or package was published as part of this review.
