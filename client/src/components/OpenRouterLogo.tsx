import React from 'react'

// OpenRouter's brand mark, vendored at client/public/openrouter.png. Was
// previously hot-linked from cdn.brandfetch.io, but the CSP locks img-src to
// 'self' + data: so the external load was blocked. Local file dodges CSP and
// removes a runtime dependency on a third-party CDN. Use is nominative fair
// use — identifying a service we integrate with, not implying endorsement.
const OPENROUTER_LOGO_URL = '/openrouter.png'

interface OpenRouterLogoProps {
  className?: string
  alt?: string
}

export const OpenRouterLogo: React.FC<OpenRouterLogoProps> = ({
  className = 'h-5 w-5',
  alt = 'OpenRouter',
}) => (
  <img
    src={OPENROUTER_LOGO_URL}
    alt={alt}
    className={className}
    loading="lazy"
    decoding="async"
  />
)
