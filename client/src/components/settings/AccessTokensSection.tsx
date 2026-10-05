import React, { useState } from 'react'
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { AccessToken, settingsAPI } from '@/utils/api'
import { AccessTokenCreateModal } from './AccessTokenCreateModal'
import { ConfirmDialog } from '../ConfirmDialog'

interface Props {
  tokens: AccessToken[]
  reloadTokens: () => Promise<void>
}

// SQLite timestamps are UTC without a zone marker — append Z before parsing
// (same pattern as WebhookDeliveries).
const fmtDate = (d: string | null) => (d ? new Date(d + 'Z').toLocaleDateString() : null)

export const AccessTokensSection: React.FC<Props> = ({ tokens, reloadTokens }) => {
  const [showCreate, setShowCreate] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<AccessToken | null>(null)

  const handleRevoke = async (token: AccessToken) => {
    setRevokingId(token.id)
    try {
      await settingsAPI.revokeAccessToken(token.id)
      await reloadTokens()
      toast.success(`Token "${token.name}" revoked`)
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to revoke access token')
    } finally { setRevokingId(null) }
  }

  return (
    <>
      <ConfirmDialog
        isOpen={!!confirmRevoke}
        title="Revoke access token?"
        message={`Anything using "${confirmRevoke?.name ?? ''}" stops working right away. This can't be undone.`}
        confirmText="Revoke" isDestructive
        onConfirm={() => { const t = confirmRevoke; setConfirmRevoke(null); if (t) handleRevoke(t) }}
        onCancel={() => setConfirmRevoke(null)}
      />
      <div className="card mb-6">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="bg-gray-100 p-2 rounded-sm"><KeyRound className="h-5 w-5 text-cube-black" /></div>
              <div>
                <h3 className="text-title text-gray-900">Access tokens</h3>
                <p className="text-sm text-gray-600">Authenticate AI agents (MCP) and scripts to your Cubex account</p>
              </div>
            </div>
            <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center space-x-2 text-sm px-4 py-2">
              <Plus className="h-4 w-4" /><span>Create token</span>
            </button>
          </div>
        </div>

        <div className="p-6">
          {tokens.length === 0 ? (
            <div className="text-center py-8">
              <KeyRound className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h4 className="text-lg font-medium text-gray-900 mb-2">No access tokens yet</h4>
              <p className="text-gray-500 mb-4">
                Create a token to connect Claude or another agent, or to use Cubex from scripts.
                Not the same as external service keys, which are for outbound HTTP enrichment.
              </p>
              <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center space-x-2 mx-auto">
                <Plus className="h-4 w-4" /><span>Create first token</span>
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {tokens.map((token) => (
                <div key={token.id} className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-900">{token.name}</span>
                      <code className="bg-gray-100 px-1 rounded text-xs text-gray-600">{token.token_prefix}…</code>
                      {token.scopes.split(',').map((s) => (
                        <span
                          key={s}
                          className={`px-2 py-0.5 text-xs rounded ${
                            s === 'secrets'
                              ? 'bg-amber-100 text-amber-800 border border-amber-300'
                              : 'bg-gray-100 text-cube-black'
                          }`}
                        >{s}</span>
                      ))}
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      Created {fmtDate(token.created_at)}
                      {token.last_used_at ? ` · Last used ${fmtDate(token.last_used_at)}` : ' · Never used'}
                      {token.expires_at ? ` · Expires ${fmtDate(token.expires_at)}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => setConfirmRevoke(token)}
                    disabled={revokingId === token.id}
                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
                    title="Revoke token (immediate: anything using it stops working)"
                  >
                    {revokingId === token.id ? (
                      <Loader2 className="h-4 w-4 animate-spin text-cube-black" />
                    ) : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AccessTokenCreateModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={reloadTokens}
      />
    </>
  )
}
