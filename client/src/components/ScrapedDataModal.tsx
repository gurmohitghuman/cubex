import React, { useState, useEffect, useRef } from 'react';
import { aiAPI } from '../utils/api';
import Modal from './Modal'
import { safeHref } from '../lib/utils'

// A source as ai_results.scraped_data stores it. Search citations carry a title
// and an excerpt; a page a structured run fetched is often just its URL, so
// every part but the URL is optional and shown only when present.
interface ScrapedWebsite {
  title?: string;
  url: string;
  content?: string;
  snippet?: string;
  column_name?: string;
  crawled_at?: string;
}

// The "(Data)" cell whose sources to show; the server finds the run result.
export interface SourcesCell { sheetId: string; rowIndex: number; columnName: string }

interface ScrapedDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  cell: SourcesCell | null;
}

export const ScrapedDataModal: React.FC<ScrapedDataModalProps> = ({
  isOpen,
  onClose,
  cell
}) => {
  const [scrapedData, setScrapedData] = useState<ScrapedWebsite[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic token: only the latest fetch is allowed to write state, so a
  // slow response for a previously-selected result can't clobber the current one.
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    // Clear stale data whenever the target changes so we never show the
    // previous result's websites while the new fetch is in flight.
    setScrapedData(null);
    setError(null);
    if (isOpen && cell) {
      fetchScrapedData();
    }
  }, [isOpen, cell]);

  const fetchScrapedData = async () => {
    if (!cell) return;

    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      const response = await aiAPI.getCellSources(cell.sheetId, cell.rowIndex, cell.columnName);
      if (seq !== fetchSeqRef.current) return; // superseded by a newer fetch
      setScrapedData(response.scrapedData);
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      setError('Failed to fetch scraped data');
      console.error('Error fetching scraped data:', err);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} panelClassName="max-w-4xl w-full max-h-[90vh]">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b">
        <h2 className="text-title text-gray-900">
          Website Data Used for AI Response
        </h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-700"></div>
              <span className="ml-3 text-gray-600">Loading scraped data…</span>
            </div>
          )}

          {error && (
            <div className="text-center py-8">
              <div className="text-red-600 mb-2">⚠️ {error}</div>
              <button
                onClick={fetchScrapedData}
                className="px-4 py-2 bg-cube-black text-white rounded hover:bg-gray-800 transition-colors"
              >
                Try Again
              </button>
            </div>
          )}

          {!loading && !error && scrapedData === null && (
            <div className="text-center py-8 text-gray-600">
              <div className="text-2xl mb-2">📄</div>
              <div>No website data was used for this AI response.</div>
              <div className="text-sm mt-2">This row was processed without web crawling.</div>
            </div>
          )}

          {!loading && !error && scrapedData && scrapedData.length > 0 && (
            <div className="space-y-6">
              <div className="text-sm text-gray-600 mb-4">
                The AI used {scrapedData.length} web page{scrapedData.length !== 1 ? 's' : ''} for this response:
              </div>
              
              {scrapedData.map((website, index) => (
                <div key={index} className="border rounded-lg p-4 bg-gray-50">
                  {/* Website Header */}
                  <div className={`flex items-start justify-between${website.content || website.snippet ? ' mb-3' : ''}`}>
                    <div className="flex-1">
                      {website.title && website.title !== website.url && (
                        <h3 className="font-semibold text-lg text-gray-900 mb-1">{website.title}</h3>
                      )}
                      {website.column_name && (
                        <div className="text-sm text-gray-700 mb-1">
                          <span className="font-medium">Source Column:</span> {website.column_name}
                        </div>
                      )}
                      {safeHref(website.url) ? (
                        <a
                          href={safeHref(website.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-cube-black hover:text-gray-600 break-all"
                        >
                          {website.url}
                        </a>
                      ) : (
                        <span className="text-sm text-gray-500 break-all">{website.url}</span>
                      )}
                    </div>
                    {website.crawled_at && (
                      <div className="text-xs text-gray-500 ml-4">{new Date(website.crawled_at).toLocaleString()}</div>
                    )}
                  </div>

                  {/* Content Preview */}
                  {website.content && (
                    <div className="bg-white rounded p-3 border">
                      <div className="text-sm font-medium text-gray-700 mb-2">Content Used:</div>
                      <div className="text-sm text-gray-600 leading-relaxed max-h-32 overflow-y-auto">
                        {website.content}
                      </div>
                    </div>
                  )}

                  {/* Snippet: the start of the content, so only on its own */}
                  {website.snippet && !website.content && (
                    <div className="mt-3 text-xs text-gray-500">
                      <span className="font-medium">Preview:</span> {website.snippet}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
      </div>

      {/* Footer */}
      <div className="flex justify-end p-6 border-t bg-gray-50">
        <button
          onClick={onClose}
          className="px-4 py-2 bg-gray-300 text-gray-700 rounded hover:bg-gray-400 transition-colors"
        >
          Close
        </button>
      </div>
    </Modal>
  );
};
