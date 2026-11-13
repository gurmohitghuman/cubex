import React from 'react'
import { Link } from 'react-router-dom'
import { Settings } from 'lucide-react'
import { useVersionInfo } from '@/hooks/useVersionInfo'

// The dashboard's Settings button. When a newer Cubex release is out it carries a dot on the corner and
// opens Settings → Account, where the Version card says which release and how to get it.
export const SettingsButton: React.FC = () => {
  const newRelease = useVersionInfo()?.update_available === true
  return (
    <Link to={newRelease ? '/settings/account' : '/settings'} data-testid="open-settings"
      className="relative p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors block"
      title={newRelease ? 'Settings: a new Cubex release is out' : 'Settings'}>
      <Settings className="h-4 w-4" />
      {newRelease && (
        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-cube-black ring-2 ring-white"
          data-testid="settings-update-dot">
          <span className="sr-only">(a new release is out)</span>
        </span>
      )}
    </Link>
  )
}
