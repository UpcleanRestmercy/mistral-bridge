# Security and privacy

Mistral Bridge is intended for a trusted, single-user desktop. Its HTTP listeners bind only to `127.0.0.1` and reject foreign Host and Origin headers. It does not isolate other local processes that can already access your account or submit local credential references. Do not expose or forward these listeners to a network.

Enter real keys only in the host's native Models editor, its credential service, or a private legacy dotenv file. Do not put keys in chat, MCP arguments, issues, screenshots, or committed configuration. Requests go to the Mistral API; the host controls native credential storage. Request logs exclude prompts, reasoning, and Authorization headers.

ZCode ownership records are stored outside the repository under `~/.zcode/mistral-proxy/providers.json`. They contain provider IDs, managed local endpoints, and explicit removals, without keys. Daemon health includes code and credential-source digests without publishing paths or credentials. DSH uses a public, endpoint-bound ownership header in its native provider configuration; this is a management marker, not an authentication secret.

Existing provider names alone do not prove ownership. Legacy endpoints are probed without credentials, only on loopback and without redirects. Unverifiable connections remain untouched; see the migration instructions in the README.

The npm package uses an explicit file list. Private dotenv files, host profiles, credential stores, runtime state, logs, and local evidence must also stay out of source uploads and Git history. `.gitignore` does not remove secrets already committed. Review the actual files and history before publishing.

Report suspected vulnerabilities or credential disclosure using [GitHub private vulnerability reporting](https://github.com/UpcleanRestmercy/mistral-bridge/security/advisories/new) (sign in to GitHub). Do not put security details or credentials in public issues. Share redacted reproduction steps and synthetic credentials rather than raw host profiles or logs. If a real key has already been published, revoke it at the provider before cleaning the public copy.
