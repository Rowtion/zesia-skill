# Zesia portable Skill

For agents without a native Zesia adapter. Install through https://zesia.dev/install.md. Development: `npm ci --ignore-scripts`, `npm run build`, `npm test`, `npm run package`. The archive contains the Skill and bundled Node scripts, no private checkout, SDK build or administrator privileges required.

The agent prepares a local draft; the user reviews the packet and approves before `send`. Configuration stays in `~/.config/zesia/agent.json`; drafts/results stay local. Cloud consultation uses A2A. Do not retry unknown send outcomes. This extraction preserves current behavior; see SKILL.md for the command contract.
