import React from 'react'
import { Box } from 'lucide-react'
import { CubeLogo } from './CubeLogo'

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  message?: string
  className?: string
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ 
  size = 'md', 
  message,
  className = ''
}) => {
  const sizeClasses = {
    sm: 'h-6 w-6',
    md: 'h-12 w-12',
    lg: 'h-16 w-16'
  }

  return (
    <div className={`flex flex-col items-center justify-center ${className}`}>
      <div className="relative">
        <div className={`animate-spin rounded-full border-2 border-gray-200 ${sizeClasses[size]}`}></div>
        <div className={`animate-spin rounded-full border-t-2 border-cube-black absolute inset-0 ${sizeClasses[size]}`}></div>
      </div>
      {message && (
        <p className="text-gray-600 mt-3 text-sm animate-pulse">
          {message}
        </p>
      )}
    </div>
  )
}

export const FullPageLoader: React.FC<{ message?: string }> = ({ message = 'Loading…' }) => {
  return (
    <div className="h-screen flex items-center justify-center bg-gray-50 overflow-hidden">
      <div className="text-center">
        <div className="animate-pulse mb-6">
          <CubeLogo size="xl" className="mx-auto" />
        </div>
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-cube-black border-t-transparent mx-auto mb-4"></div>
        <p className="text-lg font-medium text-gray-900">{message}</p>
        <p className="text-sm text-gray-500 mt-2">Processing your request…</p>
      </div>
    </div>
  )
}
