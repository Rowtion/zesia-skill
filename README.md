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

`zesia workspace --driver packet.json` starts an interactive driver against a Worker with Driver mode enabled. Keep standard input open. After the human approves the exact materials and Workspace plan in the browser, send one JSON object per line.

| Operation | Parameters after `operation` and a stable `commandId` |
| --- | --- |
| `join` | The runtime looks up the approved scope. Use the returned session and artifact references for later calls. |
| `sync` | Supply `operationId` to recover a write or advisory reply. Capability pauses include the approval state and Workspace URL. |
| `exec` | Supply `epoch`, `checkpoint`, and the approved `action`. Use the next checkpoint from the receipt. |
| `consult` | Supply `question` and `artifacts` containing exact approved input or guide references. A repeat with the same command ID recovers the original advisory result. |
| `submit_verify` | Use `kind: "submit"` with the current `epoch`, `checkpoint`, and `runbook`. Use `kind: "status"` with the original `submissionId` to check replay. |

The runbook has `version: 1` and the fields `image`, `inputs`, `cmd`, `outputs`, and `assertions`. Use the approved `sha256:<image-digest>`. Each material input binds its artifact ID, version and digest to an `input/` path. For a script generated in the sandbox, declare `kind: "workspace"`, its `sourcePath` under `work/`, the target `input/` path and its SHA-256. Commands are argv arrays such as `["python3","input/reconcile.py"]`. Outputs carry the approved artifact ID, path and SHA-256. Supported assertions are `file`, `bytes`, `sha256` and `json_equals`.

For a capability in an approved sandbox, send JSON on standard input to `zesia-capability`. The internal endpoint accepts registered call IDs and arguments. If a call returns `awaiting_approval`, let the user review it in Workspace, then use the same call ID and parameters. Use `sync` to observe an unknown call.

When verification passes, the runtime checks the files against the sealed manifest, saves them atomically and signs the local receipt. Confirmed cloud cleanup produces `attestation.json` and `SUMMARY.md` under the local Workspace. The original agent can retrieve their paths with `zesia workspace-result <groupId>`. If cleanup is still pending, send `{"operation":"submit_verify","kind":"handback","commandId":"recover-1","deliveryId":"<prior delivery ID>"}`. After an interrupted process, open `zesia workspace --driver-resume <groupId>` and send the same handback request. The local driver signing state is removed after the proof is stored.
