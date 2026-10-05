import React, { useState } from 'react'
import { Bot, Copy } from 'lucide-react'
import toast from 'react-hot-toast'

// The MCP front door, structured like the Smartlead/Instantly MCP guides the
// owner pointed at: plain-words intro, the two things you need, per-client
// setup, then example prompts. No unexplained jargon and no em dashes in
// user-facing copy (owner preference).
//
// The token box exists because the old "<your-token>" placeholder caused a real
// first-contact failure: a user pasted their token WITH the angle brackets, got
// a 401 from the MCP server, and reasonably concluded the product was broken.
// Rendering the real token inline leaves nothing to substitute.
const copyText = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error('Could not copy. Select and copy manually.')
  }
}

const CopyRow: React.FC<{ value: string; what: string }> = ({ value, what }) => (
  <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
    <code className="text-xs text-gray-800 whitespace-pre-wrap break-all flex-1">{value}</code>
    <button
      onClick={() => copyText(value, what)}
      className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors shrink-0"
      title={`Copy ${what.toLowerCase()}`}
    >
      <Copy className="h-4 w-4" />
    </button>
  </div>
)

const EXAMPLE_PROMPTS = [
  'Create a table called Leads and import the CSV I paste next.',
  'Add an AI column that classifies each company by industry.',
  'Which rows failed enrichment? Re-run just those.',
]

// Heal the ways people actually paste a token: a leading "Bearer ", the old
// placeholder's angle brackets, quotes, stray whitespace or newlines. Real
// tokens are cubex_pat_ plus hex, so stripping these characters anywhere in the
// string can never damage a valid token.
const sanitizeToken = (raw: string) =>
  raw.replace(/^\s*Bearer\s+/i, '').replace(/[<>"'\s]/g, '')

const TOKEN_SHAPE = /^cubex_pat_[0-9a-f]{64}$/

export const McpConnectCard: React.FC = () => {
  // Local state only. The token is never persisted or sent anywhere by this
  // page; it exists to render ready-to-copy commands.
  const [token, setToken] = useState('')
  const tokenValid = TOKEN_SHAPE.test(token)
  const tokenLooksWrong = token !== '' && !tokenValid
  // Only ever interpolate a token that MATCHES the cubex_pat shape into a shell
  // command. Otherwise fall back to the literal placeholder. This is a security
  // gate, not just cosmetics: these strings are pasted into a terminal, and a
  // value containing `$(...)`, backticks, `;`, etc. would be shell-evaluated on
  // paste (double quotes do NOT stop command substitution). The sanitizer strips
  // the common paste mistakes, but the shape gate is the hard guarantee that only
  // a known-safe token ever reaches a command.
  const tok = tokenValid ? token : 'YOUR_TOKEN'

  const endpoint = `${window.location.origin}/mcp`
  const claudeCmd = `claude mcp add --scope user --transport http cubex ${endpoint} --header "Authorization: Bearer ${tok}"`
  // Codex reads the bearer token from an env var, never inline (verified
  // against `codex mcp add --help`: --url + --bearer-token-env-var).
  const codexCmd = `export CUBEX_TOKEN="${tok}"\ncodex mcp add cubex --url ${endpoint} --bearer-token-env-var CUBEX_TOKEN`
  const cursorConfig = JSON.stringify(
    { mcpServers: { cubex: { url: endpoint, headers: { Authorization: `Bearer ${tok}` } } } },
    null, 2,
  )

  return (
    <div className="card mb-6">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <div className="bg-gray-100 p-2 rounded-sm"><Bot className="h-5 w-5 text-cube-black" /></div>
          <div>
            <h3 className="text-title text-gray-900">Connect an AI agent</h3>
            <p className="text-sm text-gray-600">
              Work in Cubex by chatting with Claude, Cursor, or another AI assistant
              instead of clicking through the app.
            </p>
          </div>
        </div>
      </div>
      <div className="p-6 space-y-5">
        <p className="text-sm text-gray-600">
          Cubex supports MCP (Model Context Protocol), an open standard that lets AI
          assistants securely use other apps. Once connected, your assistant can create
          tables, import CSVs, edit rows, and run AI and HTTP enrichment for you.
        </p>

        <div>
          <p className="text-sm font-medium text-gray-900 mb-1.5">What you&apos;ll need</p>
          <ol className="text-sm text-gray-600 list-decimal ml-5 space-y-1">
            <li>The Cubex MCP endpoint (below).</li>
            <li>
              An access token: create one in the section below, then paste it into the
              token box here. The setup commands fill in for you. Treat the token like a
              password. It is shown only once.
            </li>
          </ol>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-900 mb-1.5">MCP endpoint</p>
          <CopyRow value={endpoint} what="Endpoint" />
        </div>

        <div>
          <p className="text-sm font-medium text-gray-900 mb-1.5">Your access token</p>
          <input
            value={token}
            onChange={(e) => setToken(sanitizeToken(e.target.value))}
            placeholder="cubex_pat_..."
            className="input w-full font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
            aria-label="Access token"
          />
          {tokenLooksWrong ? (
            <p className="text-xs text-amber-600 mt-1.5">
              That does not look like a Cubex token. Tokens start with cubex_pat_ followed
              by 64 hexadecimal characters (0-9, a-f). Copy it again from the token you
              created below. Until it matches, the commands keep the YOUR_TOKEN placeholder.
            </p>
          ) : (
            <p className="text-xs text-gray-400 mt-1.5">
              {token
                ? 'Filled into the commands below, ready to copy. The token stays on this page and is never saved.'
                : 'Paste a token here and the commands below fill in automatically.'}
            </p>
          )}
        </div>

        <div>
          <p className="text-sm font-medium text-gray-900 mb-1.5">Claude Code</p>
          <p className="text-sm text-gray-500 mb-1.5">
            Run this once in a terminal. <code className="bg-gray-100 px-1 rounded text-xs">--scope user</code> makes
            Cubex available in every folder, not just the one you run it in.
          </p>
          <CopyRow value={claudeCmd} what="Command" />
          <p className="text-xs text-gray-400 mt-1.5">
            Replacing a token? Run <code className="bg-gray-100 px-1 rounded">claude mcp remove --scope user cubex</code> first.
          </p>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-900 mb-1.5">Codex</p>
          <p className="text-sm text-gray-500 mb-1.5">
            Codex reads the token from an environment variable. Add the export line to
            your shell profile so it persists, then run:
          </p>
          <CopyRow value={codexCmd} what="Command" />
        </div>

        <div>
          <p className="text-sm font-medium text-gray-900 mb-1.5">Cursor</p>
          <p className="text-sm text-gray-500 mb-1.5">
            Add this to <code className="bg-gray-100 px-1 rounded text-xs">~/.cursor/mcp.json</code> to use it in
            every project (or to one project&apos;s <code className="bg-gray-100 px-1 rounded text-xs">.cursor/mcp.json</code>):
          </p>
          <CopyRow value={cursorConfig} what="Config" />
          <p className="text-xs text-gray-400 mt-1.5">
            Other MCP clients work too: point them at the endpoint over HTTP with an
            Authorization header.
          </p>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-900 mb-1.5">Then try asking</p>
          <ul className="space-y-1.5">
            {EXAMPLE_PROMPTS.map(p => (
              <li key={p} className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
                &ldquo;{p}&rdquo;
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
