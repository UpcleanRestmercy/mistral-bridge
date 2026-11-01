---
name: mistral-bridge
description: Configure or troubleshoot Mistral Bridge in ZCode and DSH using the hosts' existing Models settings, native API-key editors, model discovery and legacy dotenv import.
---

# Mistral Bridge

Use each host's existing Models API Key input. Do not build a separate configuration page or ask for a key in chat. Do not pass a key through MCP parameters.

In ZCode, open Manage models from the model picker. Native provider credentials and existing display names take precedence. The MCP process synchronizes bridge providers automatically; manual `sync_mistral` is a repair tool rather than a routine requirement. ZCode observes provider-file changes without an application restart.

In DSH, use Settings → Models. The bridge configures the existing `llm-pi-ai` routes, whose native editor writes credentials through the host credential service. Loading a new plugin version may need a profile restart; ordinary API-key changes do not.

Preserve the user's existing Vibe and Mistral names and provider IDs. Merge duplicates only after comparing actual keys or explicit references. Keep unrelated providers, manual model rules and historical sessions intact.

Discover advertised chat models unless the legacy environment explicitly supplies an allowlist. Capabilities come from upstream declarations; do not claim that every model was exercised. `.env` remains a bootstrap/fallback source, not the required daily workflow.

Check the actual running proxy and profile before deployment. Keep old daemons alive for their active requests when switching endpoints. DSH has its own listener. Never replace an unknown port owner.

Preserve Markdown, reasoning and tool history. Incomplete streams must fail, and partial tool calls must never be executed. Tests use local fixtures unless a bounded live verification is appropriate to the user's request.
