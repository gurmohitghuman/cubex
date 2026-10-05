import React, { ReactNode, useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'

interface PrivateRouteProps {
  children: ReactNode
}

export const PrivateRoute: React.FC<PrivateRouteProps> = ({ children }) => {
  const { isAuthenticated, isLoading, refresh } = useAuth()
  const location = useLocation()

  // bfcache (back-forward cache) guard. After logout → navigate to /login
  // → browser Back button, Chrome restores the previous /dashboard page
  // from a memory snapshot WITHOUT re-running React effects or the auth
  // check. The in-memory auth context still says 'logged in,' so the
  // dashboard renders even though the session cookie is gone. Refresh then
  // triggers a real auth check and bounces to /login — confusing, looks
  // like a security leak even though the API still rejects requests.
  //
  // Fix: listen for the pageshow event. When event.persisted === true,
  // the page came from bfcache. Force-reload so the auth check runs again
  // against the real server state. The reload is invisible to legitimate
  // users (forward-navigated pages have persisted=false and skip this).
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        // Re-fetch auth state; if logged out, refresh() clears `user` and
        // the !isAuthenticated branch below kicks in to redirect.
        refresh().catch(() => { window.location.reload() })
      }
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [refresh])

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center overflow-hidden">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}
