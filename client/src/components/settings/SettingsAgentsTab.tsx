import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { AccessToken, settingsAPI } from '@/utils/api'
import { McpConnectCard } from './McpConnectCard'
import { AccessTokensSection } from './AccessTokensSection'
import { TabLoading, TabLoadFailed } from './TabLoading'

// Agent access: how to connect (MCP endpoint + Claude Code command) and the
// personal access tokens that authenticate it.
export const SettingsAgentsTab: React.FC = () => {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const loadTokens = async () => {
    try {
      setTokens(await settingsAPI.getAccessTokens())
      setLoadFailed(false)
    } catch (error) {
      toast.error('Failed to load access tokens')
      console.error('Load access tokens error:', error)
      setLoadFailed(true)
    }
  }
  useEffect(() => { loadTokens() }, [])

  // The connect card is static — always show it; only the token list gates.
  return (
    <>
      <McpConnectCard />
      {tokens === null
        ? (loadFailed ? <TabLoadFailed what="access tokens" onRetry={loadTokens} /> : <TabLoading />)
        : <AccessTokensSection tokens={tokens} reloadTokens={loadTokens} />}
    </>
  )
}
