import React from 'react'

// OpenRouter's official glyph (Grape, for light backgrounds), downloaded unchanged from
// openrouter.ai/brand and vendored at client/public/openrouter.svg: the CSP locks img-src to
// 'self' + data:. Their guidelines forbid stretching or recolouring it, so it is only ever
// scaled (object-contain: the glyph is wider than tall). Used to name the service we
// integrate with, not to imply endorsement.
const OPENROUTER_LOGO_URL = '/openrouter.svg'

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
    className={`${className} object-contain`}
    loading="lazy"
    decoding="async"
  />
)
