# Cubex plugin for Claude Code, Codex and Cursor

The Cubex plugin connects a coding agent to your Cubex and teaches it the jobs people ask for most. It holds Cubex's MCP connection and six skills. Claude Code and Codex read your Cubex address and access token from environment variables, so the token is never written into a config file; Cursor keeps them in its own plugin settings, or reads them from the environment if you set the server up yourself (see Cursor below).

| Skill | What the agent does |
|---|---|
| `onboard` | Checks the connection (Cubex up, token working), lists your tables and explains a sheet: what fills each column, what's failing. |
| `clean-and-dedupe` | Cleans names, companies, emails, domains and phone numbers into new columns and removes duplicate rows, for free, with a dry run first. |
| `fix-failed-rows` | Finds the rows where an AI, HTTP API or enrichment run failed, groups the reasons, fixes the cause and reruns only those rows. |
| `enrich-with-cost-control` | Picks the cheapest way to fill a column, estimates first, tests on a few rows, sets spend limits and respects the daily limit. |
| `trace-a-value` | Explains where a cell's value came from: the run, prompt, API, provider, formula, cleaner or other sheet, and what it cost. |
| `check-limits` | Rows and columns left, money left, auto-run caps and request limits, before a big job. |

## The quick way

Paste this into Claude Code, Codex or Cursor:

```text
Set up Cubex by following https://raw.githubusercontent.com/gurmohitghuman/cubex/main/docs/agent-plugin.md
```

The agent reads this page, installs the plugin for itself and shows you how to set your token. It never asks you to paste the token into the chat.

## What you need

- Cubex running somewhere your computer can reach: `http://localhost:3002` on the same computer, or your own address.
- An access token: in Cubex, **Settings → Agent access → Access tokens**. It is shown once. Pick its scopes: `read` to look, `write` to change data, `run` to start runs (they spend money), `secrets` to use saved API keys. See [Connect an AI agent](mcp.md) for what each allows.

## 1. Set CUBEX_URL and CUBEX_TOKEN

Claude Code and Codex read two environment variables (and so does Cursor when you set its server up from the environment): `CUBEX_URL`, your Cubex address without `/mcp` (Claude Code uses `http://localhost:3002` when it isn't set), and `CUBEX_TOKEN`. Keep the token in your system's password store and load it into the environment, so it never sits in a plain file.

**macOS** (Keychain). Save the token once, in your terminal:

```bash
security add-generic-password -a "$USER" -s cubex-token -w   # asks for the token
```

Then add to `~/.zshrc`:

```bash
export CUBEX_URL="http://localhost:3002"
export CUBEX_TOKEN="$(security find-generic-password -a "$USER" -s cubex-token -w)"
```

**Linux** (Secret Service). Save the token once:

```bash
secret-tool store --label="Cubex token" service cubex-token   # asks for the token
```

Then add to `~/.bashrc` or `~/.zshrc`:

```bash
export CUBEX_URL="http://localhost:3002"
export CUBEX_TOKEN="$(secret-tool lookup service cubex-token)"
```

**One session only**, nothing saved: run `read -rs CUBEX_TOKEN && export CUBEX_TOKEN` (it reads the token without showing it), then start your agent from that terminal.

Open a new terminal (or `source` the file) before installing, so the agent starts with the variables set.

## 2. Install

### Claude Code

```bash
claude plugin marketplace add gurmohitghuman/cubex --sparse .claude-plugin plugins
claude plugin install cubex@cubex
```

`--sparse` fetches only the plugin, not the whole Cubex source. If you added Cubex by hand before (`claude mcp add ... cubex`), remove that one so the agent sees one Cubex: `claude mcp remove --scope user cubex`. Start Claude Code again. `/mcp` lists `plugin:cubex:cubex`, and the skills run as `/cubex:onboard`, `/cubex:fix-failed-rows` and so on, or on their own when your request matches. To update later: `claude plugin marketplace update cubex`, then `claude plugin update cubex@cubex`.

### Codex

```bash
codex plugin marketplace add gurmohitghuman/cubex
codex plugin add cubex@cubex
codex mcp add cubex --url "$CUBEX_URL/mcp" --bearer-token-env-var CUBEX_TOKEN
```

The plugin brings the skills. Codex can't read an address from the environment in a plugin, so the last command adds the Cubex server itself: it saves the address and only the variable's name in `~/.codex/config.toml`, and Codex reads the token from `CUBEX_TOKEN` each time it starts. Start Codex again. To update later: `codex plugin marketplace upgrade`.

### Cursor

In Cursor's chat, run `/add-plugin` and give it this repository, `https://github.com/gurmohitghuman/cubex` (it has a `.cursor-plugin/marketplace.json`). A team can add the repository as a team marketplace instead. Or install it from a local folder:

```bash
git clone --depth 1 https://github.com/gurmohitghuman/cubex /tmp/cubex
mkdir -p ~/.cursor/plugins/local && cp -R /tmp/cubex/plugins/cubex ~/.cursor/plugins/local/cubex
```

Reload Cursor. The plugin asks for two settings, `CUBEX_URL` and `CUBEX_TOKEN`, in Cursor's plugin settings. If your Cursor doesn't ask, add the server to `~/.cursor/mcp.json` so it reads both from the environment:

```json
{
  "mcpServers": {
    "cubex": {
      "url": "${env:CUBEX_URL}/mcp",
      "headers": { "Authorization": "Bearer ${env:CUBEX_TOKEN}" }
    }
  }
}
```

To update later, copy the folder again.

## 3. Check it

Ask the agent: "Check my Cubex connection and show me my tables." It runs the `onboard` skill: Cubex's health, the token, then your tables and what fills each column of the sheet you pick.

If it fails:

- **Cubex isn't answering**: start it (`cubex start` after the one-line install), or check `CUBEX_URL`.
- **401**: the token is wrong or was revoked. Make a new one and save it again.
- **No Cubex tools**: the agent started before the variables were set, or the plugin isn't installed. Open a new terminal, check `echo $CUBEX_URL`, start the agent again.

## For the agent doing the setup

You are an AI agent and the user asked you to set up Cubex with this page. Follow these steps in order.

1. **Know which agent you are**: Claude Code, Codex or Cursor. Use only that agent's install steps above.
2. **Never handle the token.** Don't ask the user to paste it into the chat, don't print it, don't write it into any file, and don't run commands that would show it. The user saves it themselves.
3. **Ask for the address** if `CUBEX_URL` isn't set: where does Cubex run? Most people on the same computer use `http://localhost:3002`. Check it answers: `curl -fsS "<address>/api/health"` should say `"status":"ok"`.
4. **Check the variables** without showing the token: `test -n "$CUBEX_URL" && echo url set`, `test -n "$CUBEX_TOKEN" && echo token set`. If one is missing, show the user step 1 for their system (ask which system if you can't tell), tell them to make a token in Cubex first (Settings → Agent access → Access tokens; suggest `read`, `write` and, if they want runs, `run`), and wait until they say it's done. Variables set in their terminal after you started don't reach you: they need to open a new terminal and start you again from it. Offer to finish the install first so the restart covers both.
5. **Install** with the commands for your agent in step 2. For Codex, run `codex mcp add` with `--bearer-token-env-var CUBEX_TOKEN`, never with the token itself. For Claude Code, if `claude mcp list` already shows a `cubex` server the user added by hand, ask before removing it.
6. **Tell the user to restart you**, and what to ask next: "Check my Cubex connection and show me my tables." After the restart, the `onboard` skill takes over.
