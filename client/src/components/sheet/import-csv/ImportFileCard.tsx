import React from 'react'
import { FileText } from 'lucide-react'

interface Props {
  file: File
  importing: boolean
  progress: number
  onRemove: () => void
}

// The chosen CSV file, and the upload's progress once the import starts.
export const ImportFileCard: React.FC<Props> = ({ file, importing, progress, onRemove }) => (
  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-3">
        <FileText className="h-8 w-8 text-cube-black" />
        <div>
          <p className="text-sm font-medium text-gray-900">{file.name}</p>
          <p className="text-xs text-gray-500">
            {file.size >= 1024 * 1024
              ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
              : `${(file.size / 1024).toFixed(1)} KB`}
          </p>
        </div>
      </div>
      {!importing && (
        <button onClick={onRemove} className="text-gray-400 hover:text-gray-600">
          <span className="sr-only">Remove file</span>
          ✕
        </button>
      )}
    </div>

    {importing && (
      <div className="mt-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-gray-600">Uploading…</span>
          <span className="text-gray-900 font-medium">{Math.round(progress)}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div className="bg-cube-black h-2 rounded-sm transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }} />
        </div>
      </div>
    )}
  </div>
)
