English | [简体中文](README.zh-CN.md)

# ZESIA portable Skill and runtime

Independent consultation for agents with local Skill and command support. The original agent prepares the evidence, the user reviews it, and the cloud consultant returns advice through A2A. No native button is required.

## Install

```text
Read https://zesia.dev/install.md and install Zesia for this agent.
```

The [versioned releases](https://github.com/Rowtion/zesia-skill/releases) contain a portable Skill ZIP, checksums, source metadata and the `@zesia/runtime` tarball used by host adapters. The website may distribute a separately verified version.

Verify and extract the Skill, install it in the host's documented Skill directory, then run:

```sh
node <skill-directory>/scripts/install-a2a.mjs
node <skill-directory>/scripts/zesia.mjs --help
node <skill-directory>/scripts/configure.mjs
```

Node.js 20+ and normal file/command permissions are required. The transport installer downloads official a2a-cli 0.4.0 once, checks the pinned platform SHA-256, and retains its Apache-2.0 license. It does not need administrator permissions, a global executable or a private checkout. Configure the trial token in the terminal's hidden input, never in chat.

## Consultation flow

- `prepare <packet.json>` creates a private local draft with zero network calls.
- `send <draftId> <approvedHash> <confirmation.txt>` sends the exact reviewed draft after explicit confirmation.
- `result <draftId>` reads the cached local result without a model call.
- `followup <draftId> <answers.json>` prepares a continuation on the same A2A context; review and confirm again before sending.

Read [SKILL.md](SKILL.md) and the [packet reference](references/packet.md). Use the actual agent name and user project for `requester` and `project`; these labels do not establish identity or ownership.

Configuration defaults to `~/.config/zesia/agent.json`; private drafts and results default to `~/.local/state/zesia/consult`. Keep them out of Git. Only selected and approved material is sent. Unknown effects are not retried automatically. The cloud service is stateless; `contextId` correlates rounds rather than retrieving hidden history.

The runtime retains local evidence, consent, credentials and result handling. Official CLI serialization runs behind an ephemeral localhost guard that forwards one approved request to a fixed origin; the real token is not passed to the CLI. This is a local adapter runtime, not a separately published remote SDK or Consult MCP service.

## Develop

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run package
```

Publish this runtime before updating dependent adapters. Generate their lockfile integrity from the actual immutable published tarball, then verify a clean install. Local and CI tarballs may differ in bytes even when their contents match. Release is an explicit workflow on `main`; never overwrite a version. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

Managed upgrades retain the previous installation under `.zesia/skill-backups/`, outside Skill discovery. The installer returns the backup path; review it before manually removing it. Backups are locally ignored by Git. Symbolic links and hardlinked payload/cache files are refused.

## Local review window

Hosts without a verified native pane use `review <draftId>` after preparation. The command opens a temporary local page with read-only materials and attachments; only the user’s explicit click sends the stored packet. `wait <draftId> 60` or `result <draftId>` returns the saved advice to the original agent. No administrator access, cloud draft storage or browser-side trial token is required. The service binds a random 127.0.0.1 port, expires after five minutes idle or fifteen minutes total, and retains private result records for retrieval. Closing a tab does not cancel a request. The page shows actual request status, not a fabricated reasoning stream.

Local review requires the agent runtime and browser to run on the same computer. Remote/cloud coding sessions are not covered by this fallback; do not forward the port or expose the session publicly.
