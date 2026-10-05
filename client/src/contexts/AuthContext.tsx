import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo } from 'react'
import { authAPI } from '@/utils/api'

interface AuthContextType {
  isLoading: boolean
  isAuthenticated: boolean
  // True on a fresh install: no password has been chosen yet.
  setupRequired: boolean
  setup: (password: string) => Promise<void>
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [setupRequired, setSetupRequired] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  // Auth state comes from /auth/status: the server reads the HttpOnly session
  // cookie (JS can't see it) and reports whether it's valid and whether a
  // password exists yet.
  const refresh = useCallback(async () => {
    try {
      const status = await authAPI.status()
      setIsAuthenticated(status.authenticated)
      setSetupRequired(status.setupRequired)
    } catch {
      setIsAuthenticated(false)
    }
  }, [])

  useEffect(() => {
    refresh().finally(() => setIsLoading(false))
  }, [refresh])

  // The server sets the session cookie on success; refresh picks it up.
  const setup = useCallback(async (password: string) => {
    await authAPI.setup(password)
    await refresh()
  }, [refresh])

  const login = useCallback(async (password: string) => {
    await authAPI.login(password)
    await refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    try {
      await authAPI.logout()
    } catch {
      // Server may already consider us signed out; ignore.
    }
    setIsAuthenticated(false)
  }, [])

  const value = useMemo(() => ({
    isLoading, isAuthenticated, setupRequired, setup, login, logout, refresh,
  }), [isLoading, isAuthenticated, setupRequired, setup, login, logout, refresh])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
