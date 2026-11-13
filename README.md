English | [简体中文](README.zh-CN.md)

# ZESIA shared client

Shared Skill, local evidence/consent runtime and official A2A CLI transport for independent
expert consultation. The cloud consultant stays separate from this public client.

Version 0.4 uses one `https://zesia.dev/consult` review page. A short-lived loopback bridge
shows an immutable local draft and read-only attachments; only explicit browser approval
starts cloud preflight and A2A. No long-lived token enters the webpage, URL or composer.
Browser loopback permission may be needed. This is not a remote draft-upload service.

## Usage

Install for your host using the single prompt:

```text
Read https://zesia.dev/install.md and install ZESIA for this agent.
```

The guide must point at actually published versions; source implementation does not imply a
new version has been released. The standalone assets remove the extra Node requirement;
Node-based compatibility scripts remain for existing installations. Never disable browser
security, expose the bridge port or require administrator rights.

```text
scripts/zesia configure --token-file <private-token-file>
scripts/zesia prepare <private-packet.json>
scripts/zesia review <draftId>
scripts/zesia wait <draftId> 900
scripts/zesia result <draftId>
```

Use `.exe` on Windows. Credentials and state stay in private local files. Preparation returns
compact metadata; materials are shown in the online window, not pasted into the conversation.
The original agent receives the full opinion plus work-relevant structured fields. Requests
have stable IDs, result recovery reads the same cloud execution, and unknown outcomes never
trigger automatic inference retries. A local receipt distinguishes saved from retrieved results.
Follow-ups use reviewed snapshots and new approval. Advice never grants execution permission.

## Development and distribution

`npm ci --ignore-scripts`, `npm run build`, `npm test`, `npm run package`.
`npm run build:native` uses pinned Bun 1.3.13 and the pinned official a2a-cli; end users need
neither toolchain. Mac builds are signed during packaging. Standalone ZIPs contain checksums,
source/version metadata, licenses and the public JS bundle/rebuild instructions. See
[NATIVE-NOTICES.md](NATIVE-NOTICES.md). CI release publishes only after all platform builds
and their no-extra-Node tests pass; versions/assets are immutable.

Chrome loopback permission and local-host operation require actual verification. Remote/SSH
workspaces, other browsers and each host's real-session behavior have separate support gates;
do not equate a binary build with universal host acceptance. Website code is trusted software
that can access its own page memory; local-only draft handling is not a cryptographic claim.
