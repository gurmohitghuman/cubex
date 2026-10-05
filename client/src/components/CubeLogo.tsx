import React from 'react'

interface CubeLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

// Single source for the Cubex brand mark across the app. Sized by tailwind
// utility classes per the `size` prop; consumers don't need to know the
// underlying asset path.
export const CubeLogo: React.FC<CubeLogoProps> = ({ size = 'md', className = '' }) => {
  const sizeClasses = {
    sm: 'w-5 h-5',
    md: 'w-7 h-7',
    lg: 'w-10 h-10',
    xl: 'w-14 h-14',
  }

  return (
    <div className={`${sizeClasses[size]} ${className} flex-shrink-0`}>
      <img
        src="/cubex.svg"
        alt="Cubex"
        className="w-full h-full object-contain"
      />
    </div>
  )
}
