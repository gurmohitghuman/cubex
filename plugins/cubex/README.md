# Cubex plugin

Cubex's MCP connection and skills for Claude Code, Codex and Cursor. Setup, the skills and what each agent needs: [docs/agent-plugin.md](../../docs/agent-plugin.md).

- `.claude-plugin/plugin.json` and `.mcp.json`: Claude Code (the server reads `CUBEX_URL` and `CUBEX_TOKEN` from the environment).
- `.codex-plugin/plugin.json`: Codex (skills; the server is added with `codex mcp add ... --bearer-token-env-var CUBEX_TOKEN`).
- `.cursor-plugin/plugin.json` and `mcp.json`: Cursor (the server reads its `CUBEX_URL` and `CUBEX_TOKEN` settings).
- `skills/`: one folder per skill, shared by all three.

The marketplaces that list it are at the repository root: `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` (Codex) and `.cursor-plugin/marketplace.json`.
