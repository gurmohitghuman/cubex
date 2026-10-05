import React, { useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Lock, ArrowRight, Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { CubeLogo } from '@/components/CubeLogo'
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '@/lib/constants'

// One page, two modes. On a fresh install (no password yet) whoever opens Cubex
// first chooses the password. After that it's a password-only sign-in.
export const LoginPage: React.FC = () => {
  const { isLoading, isAuthenticated, setupRequired, setup, login, refresh } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  if (isAuthenticated) return <Navigate to="/dashboard" replace />

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center overflow-hidden">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (setupRequired) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        toast.error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
        return
      }
      if (password !== confirm) {
        toast.error("The two passwords don't match.")
        return
      }
    }
    setIsSubmitting(true)
    try {
      // Success flips isAuthenticated, and the <Navigate> above takes over.
      if (setupRequired) await setup(password)
      else await login(password)
    } catch (error: any) {
      // 409: setup finished somewhere else first (or no password exists yet).
      // Re-read the status so the page switches to the right form.
      if (error?.response?.status === 409) await refresh()
      toast.error(error?.response?.data?.error || 'Something went wrong. Try again.')
      setPassword('')
      setConfirm('')
      passwordRef.current?.focus()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="iso-grid min-h-screen max-h-screen overflow-y-auto bg-gray-50 flex items-start justify-center px-4 sm:px-6 lg:px-8 py-8">
      <div className="relative z-10 max-w-md w-full space-y-8">
        <div className="text-center">
          <CubeLogo size="xl" className="mx-auto mb-6" />
          <h2 className="text-display text-gray-900">{setupRequired ? 'Set up Cubex' : 'Sign in to Cubex'}</h2>
          <p className="mt-2 text-sm text-gray-600">
            {setupRequired ? "Choose a password. You'll use it to sign in." : 'Enter your password'}
          </p>
        </div>

        <div className="card p-8">
          <form className="space-y-6" onSubmit={handleSubmit}>
            {/* Cubex has one account and no usernames. This hidden field gives
                password managers something to file the password under. */}
            <input type="text" name="username" autoComplete="username" value="cubex" readOnly hidden />

            <PasswordInput
              ref={passwordRef}
              id="password"
              label="Password"
              autoComplete={setupRequired ? 'new-password' : 'current-password'}
              placeholder={setupRequired ? `At least ${MIN_PASSWORD_LENGTH} characters` : 'Your password'}
              value={password}
              onChange={setPassword}
              autoFocus
            />
            {setupRequired && (
              <PasswordInput
                id="confirm"
                label="Confirm password"
                autoComplete="new-password"
                placeholder="Type it again"
                value={confirm}
                onChange={setConfirm}
              />
            )}

            <button
              type="submit"
              disabled={isSubmitting || !password}
              className="w-full btn-primary flex justify-center items-center space-x-2"
            >
              {isSubmitting
                ? <Loader2 className="h-4 w-4 animate-spin text-white" />
                : (<><span>{setupRequired ? 'Create password' : 'Sign in'}</span><ArrowRight className="h-4 w-4" /></>)}
            </button>

            <p className="text-xs text-gray-500">
              {setupRequired ? "There's no email reset. If you forget it, run " : 'Forgot it? Run '}
              <code className="font-mono text-gray-700 whitespace-nowrap">cubex reset-password</code> on the computer running Cubex
              (<code className="font-mono text-gray-700 whitespace-nowrap">npm run reset-password</code> for Docker or a source install).
            </p>
          </form>
        </div>
      </div>
    </div>
  )
}

interface PasswordInputProps {
  id: string
  label: string
  autoComplete: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(({ id, label, autoComplete, placeholder, value, onChange, autoFocus }, ref) => (
  <div>
    <label htmlFor={id} className="block text-sm font-medium text-gray-700">{label}</label>
    <div className="mt-1 relative">
      <Lock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
      <input
        ref={ref}
        id={id}
        name={id}
        type="password"
        autoComplete={autoComplete}
        required
        maxLength={MAX_PASSWORD_LENGTH}
        className="input pl-10 w-full"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
    </div>
  </div>
))
PasswordInput.displayName = 'PasswordInput'
