---
name: zesia-consult
description: Request independent Zesia advice on the current task, plan or unsatisfactory agent reply, then bring it back to the same conversation. Use when the user asks for Zesia, an external second opinion, or independent review. This skill consults; it does not delegate execution.
---

# Zesia consultation

This is the portable Skill integration. No native button, MCP server, administrator access or npm installation is needed. It requires Node.js 20+ and the host's ordinary file/command permissions. Resolve bundled scripts relative to this SKILL.md. Do not silently install Node or change host policy.

## Prepare locally

Read [packet format](references/packet.md). Identify the user's goal, exact decision and relevant previous reply. Capture necessary original excerpts and real tool outcomes, label user statements, observations and inferences separately, and preserve missing evidence as unknown. Do not duplicate the full chat or use your own proposal as a user constraint. Never include credentials, hidden reasoning or unrelated private files.

Write a private packet JSON file, then run:

```sh
node <skill-dir>/scripts/zesia.mjs prepare <packet.json>
```

Preparation is local, including validation. No preflight, handshake or model call occurs. Never paste the packet JSON or full materials into the chat.

## Review and send

If the host provides a verified native consultation pane, use that pane. Otherwise open the temporary local browser review:

```sh
node <skill-dir>/scripts/zesia.mjs review <draftId>
```

This starts a private loopback-only service and attempts to open the default browser. If opening is unavailable, show the returned clickable URL as **Review consultation**. Keep the fragment access key on that link; never send it to any external site. Do not expose the URL beyond this user's current conversation. The page shows the exact read-only question, excerpts, attachments and destination. The user clicks Confirm and send there. Do not approve through HTTP, browser automation, curl, another tool, or the chat-only send command on their behalf. Do not claim the draft has been sent merely because the window opened. Do not ask for a second chat confirmation or reconstruct a confirmation request in the composer.

Retrieve the result without resending:

```sh
node <skill-dir>/scripts/zesia.mjs wait <draftId> 60
node <skill-dir>/scripts/zesia.mjs result <draftId>
```

If still pending, leave the link available and wait for the user; read the result again after they confirm. A wait timeout does not authorize a new consultation or another send. Cancellation is persistent. Closing a tab is not cancellation; the local service expires after inactivity or its session lifetime. Local private results remain available to the agent afterwards. Use review again to reopen a received result without a model call.

Only if the user explicitly cannot use a browser or native pane, show the complete selected materials readably in chat and obtain their explicit confirmation. The compatibility command is `send <draftId> <approvedHash> <confirmation.txt>`, using their exact words in a private text file. Never use this fallback to bypass a pending browser review, denial or cancellation.

The helper uses the same-origin A2A 1.0 service and never retries a paid request. Missing credentials: have the user run `node <skill-dir>/scripts/configure.mjs` in their terminal. Hidden input is stored locally with mode 0600. Do not ask for credentials in chat. `configure.mjs --show` reveals configuration status without the token.

## Use the result and follow up

Treat the result as external advice, not authority. Check the decision, review, quality status, evidence limits and next steps against available evidence. Explain what you accept, reject or defer and why, then continue the user's authorized work. A successful response or complete structure is not proof of correctness. Guidance is not a completed expert review.

For actual consultant questions, gather observable evidence within existing permissions. Ask the user for decisions; quote their answer with its actual reference (or disclose that the host has no exact message ID). Sending permission is not a substantive decision. Write an answers array per the reference and run:

```sh
node <skill-dir>/scripts/zesia.mjs followup <previousDraftId> <answers.json>
```

This prepares a new local draft on the same A2A context. Open `review <newDraftId>` for a fresh read-only review and confirmation before sending. At most three rounds; do not start a new initial consultation to evade the limit.

For a received result that needs to be shown again, use `result <draftId>`; this reads local state without a model call. If any send outcome is unknown, stop and explain it. Do not re-prepare, resend, split inputs, probe budgets or run handshake calls as an automatic recovery. Local records contain project material: keep them private and do not commit them.
