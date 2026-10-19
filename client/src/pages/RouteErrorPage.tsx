import React from 'react'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom'

// Shown for unknown URLs and for errors the router catches, instead of React
// Router's developer error screen. Those errors happen in the browser (a page that
// failed to draw or load), so the server log has nothing on them: the page shows
// the message itself.
export const RouteErrorPage: React.FC<{ notFound?: boolean }> = ({ notFound }) => {
  const error = useRouteError()
  const missing = notFound || (isRouteErrorResponse(error) && error.status === 404)
  if (error && !missing) console.error(error)
  const detail = missing ? '' : error instanceof Error ? error.message
    : isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : ''
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <img src="/cubex.svg" alt="" className="h-10 w-10" />
      <h1 className="text-xl font-semibold text-gray-900">
        {missing ? 'Page not found' : 'Something went wrong'}
      </h1>
      <p className="max-w-sm text-sm text-gray-500">
        {missing
          ? "This page doesn't exist."
          : 'Reload the page. If it keeps happening, the message below says what failed.'}
      </p>
      {detail && (
        <p data-testid="route-error-detail" className="max-w-md break-words font-mono text-xs text-gray-400">
          {detail}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        {!missing && (
          <button type="button" className="btn-primary" onClick={() => window.location.reload()}>Reload</button>
        )}
        <Link to="/" className={missing ? 'btn-primary' : 'btn-secondary'}>Go to your tables</Link>
      </div>
    </div>
  )
}
