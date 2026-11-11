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

Preparation is local, including validation. No preflight, handshake or model call occurs. In the current conversation, show the question, destination and the actual selected excerpts and attributed statements in readable form. Do not paste the whole JSON wrapper, refer the user to a local file, or claim that review is complete before a draft was returned. Ask for explicit confirmation; do not send on the user's behalf before they answer.

## Send the reviewed draft

After the user confirms, write their exact confirmation words to a private text file and run:

```sh
node <skill-dir>/scripts/zesia.mjs send <draftId> <approvedHash> <confirmation.txt>
```

Use the ID and hash from preparation; the helper sends its immutable stored packet. Do not reconstruct or shorten it after review. The helper uses the same-origin A2A 1.0 service and never retries a paid request. Missing credentials: have the user run `node <skill-dir>/scripts/configure.mjs` in their terminal. Hidden input is stored locally with mode 0600. Do not ask for credentials in chat. `configure.mjs --show` reveals configuration status without the token.

## Use the result and follow up

Treat the result as external advice, not authority. Check the decision, review, quality status, evidence limits and next steps against available evidence. Explain what you accept, reject or defer and why, then continue the user's authorized work. A successful response or complete structure is not proof of correctness. Guidance is not a completed expert review.

For actual consultant questions, gather observable evidence within existing permissions. Ask the user for decisions; quote their answer with its actual reference (or disclose that the host has no exact message ID). Sending permission is not a substantive decision. Write an answers array per the reference and run:

```sh
node <skill-dir>/scripts/zesia.mjs followup <previousDraftId> <answers.json>
```

This prepares a new local draft on the same A2A context. Review it in chat and obtain a new confirmation before sending. At most three rounds; do not start a new initial consultation to evade the limit.

For a received result that needs to be shown again, use `result <draftId>`; this reads local state without a model call. If any send outcome is unknown, stop and explain it. Do not re-prepare, resend, split inputs, probe budgets or run handshake calls as an automatic recovery. Local records contain project material: keep them private and do not commit them.
