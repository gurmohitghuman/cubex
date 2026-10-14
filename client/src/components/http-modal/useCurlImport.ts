import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { curlAPI, settingsAPI } from '@/utils/api'
import type { CurlKeyChoice, CurlKeyFinding, ImportedRequest } from '@/utils/api'
import { CURL_MAX_CHARS } from '@/lib/constants'
import type { HTTPAPIConfig } from './types'

// One key's answer in the "Keys in this command" panel, as typed so far.
export interface KeyDraft {
  action: 'save' | 'use' | 'drop'
  name: string // the new saved key's name
  useName: string // the saved key to use instead
  value: string // a key the command only names ($OPENAI_API_KEY): pasted here
  user: string // the same for Basic sign-in
  password: string
}

const KEY_NAME_RE = /^[A-Za-z0-9_-]+$/

// "Paste a cURL command": the server reads the command (POST /api/http/curl). If
// it holds keys, the panel asks what to do with each and the command goes again
// with the answers; the reply fills method, URL, query, headers and body. Keys
// are never put in the form: the server swaps each for {{saved_key_name}}.
// formKey changes on every fill, so the form remounts with those sections open.
export function useCurlImport(sheetId: string, isOpen: boolean, updateConfig: (u: Partial<HTTPAPIConfig>) => void) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keys, setKeys] = useState<CurlKeyFinding[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, KeyDraft>>({})
  const [savedKeyNames, setSavedKeyNames] = useState<string[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [formKey, setFormKey] = useState(0)

  const reset = () => {
    setOpen(false); setText(''); setBusy(false); setError(null); setKeys(null); setDrafts({}); setNotes([])
  }
  useEffect(() => { reset(); setFormKey(0) }, [isOpen, sheetId])

  const fill = (r: ImportedRequest) => {
    updateConfig({
      method: r.method,
      endpointUrl: r.query ? r.endpoint : r.url,
      queryParams: r.query ?? [],
      headers: r.headers,
      body: r.body ?? '',
    })
    setFormKey(k => k + 1)
  }

  const send = async (curl: string, choices?: Record<string, CurlKeyChoice>) => {
    if (curl.length > CURL_MAX_CHARS) {
      setError(`That command is longer than ${CURL_MAX_CHARS.toLocaleString('en-US')} characters.`)
      return
    }
    setBusy(true); setError(null)
    try {
      const reply = await curlAPI.importCurl(sheetId, curl, choices)
      if (reply.needsKeys) {
        setKeys(reply.keys); setDrafts(defaultDrafts(reply.keys)); setNotes(reply.notes)
        settingsAPI.getAPIKeys().then(list => setSavedKeyNames(list.map(k => k.name))).catch(() => setSavedKeyNames([]))
        return
      }
      fill(reply.request)
      setKeys(null); setDrafts({}); setOpen(false); setText(''); setNotes(reply.notes)
      const saved = reply.savedKeys
      const what = saved.length > 1 ? 'keys' : 'a key'
      toast.success(saved.length ? `Filled in from cURL. Saved ${saved.join(', ')} as ${what}.`
        : 'Filled in from cURL.')
    } catch (e: any) {
      setError(e?.response?.data?.error || "Couldn't read that command.")
    } finally {
      setBusy(false)
    }
  }

  return {
    open, text, busy, error, keys, drafts, savedKeyNames, notes, formKey,
    setText,
    start: () => { setOpen(true); setError(null) },
    close: reset,
    dismissNotes: () => setNotes([]),
    submit: () => { if (text.trim()) void send(text) },
    // A curl command pasted into the URL field goes the same way.
    pasteFromUrl: (pasted: string) => { setOpen(true); setText(pasted); setKeys(null); void send(pasted) },
    setDraft: (id: string, patch: Partial<KeyDraft>) => setDrafts(d => ({ ...d, [id]: { ...d[id], ...patch } })),
    backToCommand: () => { setKeys(null); setDrafts({}); setError(null) },
    confirmKeys: () => {
      const choices = toChoices(keys ?? [], drafts)
      if (typeof choices === 'string') { setError(choices); return }
      void send(text, choices)
    },
  }
}

// A key already saved is used; a cookie (a browser session) is left out; the
// rest are saved under the suggested name.
function defaultDrafts(keys: CurlKeyFinding[]): Record<string, KeyDraft> {
  return Object.fromEntries(keys.map(k => [k.id, {
    action: k.existingKey ? 'use' : k.cookie && k.canDrop ? 'drop' : 'save',
    name: k.suggestedName, useName: k.existingKey ?? '', value: '', user: '', password: '',
  } satisfies KeyDraft]))
}

function toChoices(keys: CurlKeyFinding[], drafts: Record<string, KeyDraft>): Record<string, CurlKeyChoice> | string {
  const out: Record<string, CurlKeyChoice> = {}
  for (const k of keys) {
    const d = drafts[k.id]
    if (!d) return `Choose what to do with the key in the ${k.where}.`
    if (d.action === 'drop') { out[k.id] = { drop: true }; continue }
    if (d.action === 'use') {
      if (!d.useName) return `Pick a saved key for the ${k.where}.`
      out[k.id] = { use: d.useName }
      continue
    }
    const name = d.name.trim()
    if (!KEY_NAME_RE.test(name)) return 'Key names can use letters, numbers, _ and - only.'
    if (k.kind === 'value') { out[k.id] = { save: name }; continue }
    const value = k.basic ? (d.user || d.password ? `${d.user}:${d.password}` : '') : d.value.trim()
    if (!value) return `Paste the key for the ${k.where}.`
    out[k.id] = { save: name, value }
  }
  return out
}
