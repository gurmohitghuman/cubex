import React from 'react'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom'

// Shown for unknown URLs and for errors the router catches, instead of React
// Router's developer error screen.
export const RouteErrorPage: React.FC<{ notFound?: boolean }> = ({ notFound }) => {
  const error = useRouteError()
  const missing = notFound || (isRouteErrorResponse(error) && error.status === 404)
  if (error && !missing) console.error(error)
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <img src="/cubex.svg" alt="" className="h-10 w-10" />
      <h1 className="text-xl font-semibold text-gray-900">
        {missing ? 'Page not found' : 'Something went wrong'}
      </h1>
      <p className="max-w-sm text-sm text-gray-500">
        {missing ? "This page doesn't exist." : 'Reload the page. If it keeps happening, check the server log (cubex logs).'}
      </p>
      <Link to="/" className="btn-primary mt-2">Go to your tables</Link>
    </div>
  )
}
