import React from 'react'

// treg's mark, vendored unchanged at client/public/treg.svg from treg's own
// repo (plugins/treg/assets/logo.svg, the icon treg ships for other apps'
// UIs). Local because the CSP locks img-src to 'self' + data:. Nominative use:
// it says where enrichments come from, nothing more (no partnership or
// endorsement). Remove it if treg asks.
export const TregLogo: React.FC<{ className?: string }> = ({ className = 'h-4 w-4' }) => (
  <img src="/treg.svg" alt="treg" className={className} loading="lazy" decoding="async" />
)
