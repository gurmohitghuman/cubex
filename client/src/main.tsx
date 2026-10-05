import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import { createPortal } from 'react-dom'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './index.css'
import { PrivateRoute } from './components/PrivateRoute'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { SettingsPage } from './pages/SettingsPage'
import { RouteErrorPage } from './pages/RouteErrorPage'

// SheetPage is the only page that pulls in AG Grid (~300KB gzip, >half the JS
// payload). Lazy-load it so login/dashboard/settings don't download that chunk
// on first paint — it arrives only when the user opens a table.
const SheetPage = lazy(() => import('./pages/SheetPage').then(m => ({ default: m.SheetPage })))

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'dashboard', element: <PrivateRoute><DashboardPage /></PrivateRoute> },
      {
        path: 'table/:tableId/:sheetId?',
        element: (
          <PrivateRoute>
            <Suspense fallback={<div className="flex h-screen items-center justify-center text-cube-grey">Loading…</div>}>
              <SheetPage />
            </Suspense>
          </PrivateRoute>
        ),
      },
      { path: 'settings/:tab?', element: <PrivateRoute><SettingsPage /></PrivateRoute> },
      { index: true, element: <PrivateRoute><DashboardPage /></PrivateRoute> },
      { path: '*', element: <RouteErrorPage notFound /> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} future={{ v7_startTransition: true }} />
    {/* Rendered straight under <body>: while a drawer or dialog is open, Headless UI
        makes #root inert, so a toast inside it let clicks through to the buttons
        below and counted as a click outside the dialog (closing it). z-index sits
        above the drawers and dialogs (z-[20000], nested z-[20010]), which an error
        toast raised from inside an open drawer used to render behind. */}
    {createPortal(<Toaster
      // Top centre: drawers and dialogs keep their action buttons bottom-right,
      // and a hovered toast pauses, so a bottom-right one sat on top of them.
      position="top-center"
      containerStyle={{ zIndex: 20100 }}
      toastOptions={{
        duration: 4000,
        className: '',
        // Match the unified monochrome brand palette: cube-black #252626
        // (from the logo's dark face) on white text. Was generic #363636.
        style: {
          background: '#252626',
          color: '#FFFFFF',
          borderRadius: '8px',
        },
      }}
    />, document.body)}
  </React.StrictMode>,
)
