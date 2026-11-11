# Packet and continuation

```json
{
  "requester": "actual agent name, e.g. Codex",
  "project": "the user's project",
  "brief": "the exact question to review",
  "context": {
    "goal": "what the user wants to accomplish",
    "originalReply": "relevant verbatim passage, if needed",
    "statements": [
      {"id":"u1","kind":"constraint","origin":"user_statement","text":"A constraint the user actually stated","sourceRef":"actual message reference, or unavailable","sourceQuote":"exact user words, or empty if unavailable"}
    ],
    "materials": [{"id":"code1","content":"Source reference and exact bounded excerpt"}],
    "attempts": [{"action":"what was actually tried","outcome":"observed outcome"}]
  }
}
```

Top-level keys: requester, project, brief, context. Use actual requester and project labels, not authenticated ownership claims. Brief <=8000 characters; goal <=2000; originalReply <=8000. Up to 16 attributed statements (text <=2000); up to 8 materials (each <=6000). Do not duplicate statements in legacy facts/assumptions/constraints arrays. Full packet <=128 KiB; cloud preflight also budgets its system/profile context. The server's returned validation is authoritative. Nothing is automatically truncated.

`kind`: fact / constraint / assumption. `origin`: user_statement / observation / agent_inference. User quotes must be verbatim; never fabricate references. The helper cannot verify quotes against the host transcript.

Follow-up answers JSON is an array, not a new consultation packet:

```json
[
  {"requestId":"the actual followUp request ID","text":"new evidence or user answer","sourceRef":"actual source reference","sourceQuote":"exact user words for user_decision; otherwise omit"}
]
```

One to three answers per round. Reuse the original draft ID for `followup`; the helper carries previous advice, round and actual A2A context. It refuses duplicate continuation and more than three rounds. Accumulated evidence still has the same contract limits.

Configuration: `~/.config/zesia/agent.json`, or ZESIA_CONFIG. State: `~/.local/state/zesia/consult`, or ZESIA_STATE_DIR. Both are local; state includes approved material and full receipts. Helpers return work-relevant result fields without replaying the entire sent packet or routing diagnostics into the conversation. Credentials are sent only to the configured service origin over HTTPS (loopback HTTP is allowed for local tests).
