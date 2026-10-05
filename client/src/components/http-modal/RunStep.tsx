import React from 'react'
import { CheckCircle, Loader2 } from 'lucide-react'
import { HTTPResult, HTTPRun } from '@/utils/api'

interface Props {
  currentRun: HTTPRun
  runResults: HTTPResult[]
  onViewResults: () => void
}

export const RunStep: React.FC<Props> = ({ currentRun, runResults, onViewResults }) => (
  <div className="p-4 space-y-4">
    <div className="bg-gray-50 border border-gray-200 p-3">
      <div className="flex items-start space-x-2">
        <Loader2 className="h-4 w-4 text-cube-black animate-spin flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="text-sm font-medium text-gray-800">HTTP API Run Progress</h4>
          <p className="text-xs text-gray-700 mt-1">Processing rows with your HTTP API configuration…</p>
          <div className="mt-2">
            <div className="flex justify-between text-xs text-gray-700 mb-1">
              <span>Progress</span>
              <span>{currentRun.processed_rows} of {currentRun.total_rows}</span>
            </div>
            <div className="w-full bg-gray-300 h-1.5">
              <div className="bg-cube-black h-1.5 transition-all duration-300"
                style={{ width: `${currentRun.total_rows > 0 ? (currentRun.processed_rows / currentRun.total_rows) * 100 : 0}%` }} />
            </div>
          </div>
          <div className="flex items-center space-x-4 mt-2 text-xs text-gray-700">
            <span className="flex items-center">
              Status: <span className={`ml-1 font-medium ${
                currentRun.status === 'running' ? 'text-green-600' :
                currentRun.status === 'paused' ? 'text-yellow-600' :
                currentRun.status === 'cancelled' ? 'text-cube-black' : 'text-cube-black'
              }`}>
                {currentRun.status.charAt(0).toUpperCase() + currentRun.status.slice(1)}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>

    {runResults.length > 0 && (
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-gray-900">Latest Results</h4>
        <div className="max-h-64 overflow-y-auto space-y-2">
          {runResults.slice(-5).map((result) => (
            <div key={result.id} className="border border-gray-200 p-2 text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-gray-700">Row {result.row_index + 1}</span>
                <span className={`px-2 py-0.5 text-xs ${
                  result.status === 'completed' ? 'bg-cube-black text-white' :
                  result.status === 'failed' ? 'bg-white text-cube-black border border-cube-black' :
                  'bg-gray-100 text-gray-800'
                }`}>{result.status}</span>
              </div>
              {result.status === 'completed' && (
                <div className="text-gray-600">
                  Fields extracted: {Object.keys(JSON.parse(result.extracted_fields || '{}')).length}
                </div>
              )}
              {result.status === 'failed' && result.error_message && (
                <div className="text-cube-black">Error: {result.error_message}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    )}

    {(currentRun.status === 'completed' || currentRun.status === 'cancelled') && (
      <div className="flex justify-center">
        <button onClick={onViewResults} className="btn-primary-lg flex items-center gap-2">
          <CheckCircle className="h-4 w-4" /><span>View Results</span>
        </button>
      </div>
    )}
  </div>
)
