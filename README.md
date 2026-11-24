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

## One Agent Plugin for local clients

The release workflow builds one Agent Plugins 1.0 ZIP from the public Skill and
the five verified native artifacts. The generated dist/agent-plugin directory
is the matching Git distribution tree for clients that install from a repository.
Cursor, Copilot and Codex use the same Skill and pins. Their catalogs and reviews
are independent. The Git tree is published from the verified release ZIP, and
Codex takes the ZIP itself. Use the desktop-only listing for Codex.

The plugin includes installation instructions and per-platform Runtime checksums.
The separately released Setup 1.1.0 installs the verified executable and its
bundled A2A CLI in a versioned user directory. Installation, Skill discovery and
the first consultation are separate checks. Existing Skill paths remain available.

### Local workspace preview

Run `zesia workspace` to open the local session list. The browser only sees it after connecting to the short-lived loopback bridge. For offline reading, choose the `.zesia` directory from the workspace in a supported browser.

In Staging, configure the Consult Worker and run `zesia workspace --group packet.json` to open the local group confirmation. Keep the runtime running while it observes the approved room. It verifies each archived artifact's length and SHA-256, saves the result and audit locally, then signs the cloud handback acknowledgment. The caller signing key stays in the running runtime. Ending that process before synchronization can leave the room without a handback acknowledgment.

The launcher reports a stable group ID. The originating agent can use `zesia workspace-result <groupId> [seconds]` to retrieve the saved receipt and verified artifact paths without contacting the cloud.

`zesia workspace --driver packet.json` starts an interactive driver session against a Worker with Driver mode enabled. Keep its standard input open. After the human approves the materials and Workspace plan in the browser, the local agent can send one JSON object per line using `join`, `sync`, or `exec`. For example, send `{"operation":"join","commandId":"join-1"}`. The client discovers the approved scope and signs each operation with the key held in this process. Use stable command IDs and query an interrupted write with `sync` and its operation ID. The shared transport also reserves the fixed names `consult` and `submit_verify` for the platform review flow.
