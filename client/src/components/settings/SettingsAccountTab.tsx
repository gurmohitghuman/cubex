import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/AuthContext'
import { authAPI } from '@/utils/api'
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '@/lib/constants'

// Cubex has a single account and no email, so this tab is just the password and
// signing out. A forgotten password is reset from the server shell.
export const SettingsAccountTab: React.FC = () => {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (next.length < MIN_PASSWORD_LENGTH) {
      toast.error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (next !== confirm) {
      toast.error("The new passwords don't match.")
      return
    }
    setSaving(true)
    try {
      await authAPI.changePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      toast.success('Password changed. Other browsers have been signed out.')
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not change the password.')
    } finally {
      setSaving(false)
    }
  }

  const handleSignOut = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <>
      <div className="card mb-6">
        <div className="p-6">
          <h3 className="text-title text-gray-900 mb-1">Change password</h3>
          <p className="text-sm text-gray-500 mb-5">
            Changing it signs out every other browser. Forgot it? Run{' '}
            <code className="font-mono text-gray-700 whitespace-nowrap">cubex reset-password</code> on the computer running Cubex
            (<code className="font-mono text-gray-700 whitespace-nowrap">npm run reset-password</code> for Docker or a source install).
          </p>
          <form className="space-y-4 max-w-sm" onSubmit={handleChangePassword}>
            <input type="text" name="username" autoComplete="username" value="cubex" readOnly hidden />
            <Field id="current-password" label="Current password" autoComplete="current-password" value={current} onChange={setCurrent} />
            <Field id="new-password" label="New password" autoComplete="new-password" value={next} onChange={setNext} />
            <Field id="confirm-password" label="Confirm new password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
            <button type="submit" disabled={saving || !current || !next || !confirm} className="btn-primary">
              {saving ? 'Saving…' : 'Change password'}
            </button>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="p-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-gray-900">Sign out</p>
            <p className="text-sm text-gray-500">Signs out every browser, including this one.</p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          >
            Sign out
          </button>
        </div>
      </div>
    </>
  )
}

interface FieldProps {
  id: string
  label: string
  autoComplete: string
  value: string
  onChange: (value: string) => void
}

const Field: React.FC<FieldProps> = ({ id, label, autoComplete, value, onChange }) => (
  <div>
    <label htmlFor={id} className="block text-sm font-medium text-gray-700">{label}</label>
    <input
      id={id}
      name={id}
      type="password"
      autoComplete={autoComplete}
      maxLength={MAX_PASSWORD_LENGTH}
      className="input mt-1 w-full"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  </div>
)
