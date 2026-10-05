import { HTTPAPIConfig } from './types'

// Apply a /reference (or {{key}}) to whichever input field triggered the
// suggestions dropdown. Replaces the partial token (everything after the last
// `/`) with the chosen reference. Used by the suggestions hook in
// HTTPAPIColumnModal — split out so the parent modal stays under the
// 200-line cap.
export function insertReferenceInto(
  config: HTTPAPIConfig,
  updateConfig: (updates: Partial<HTTPAPIConfig>) => void,
  reference: string,
  target: string,
): void {
  const replaceLastSlash = (s: string) => {
    const idx = s.lastIndexOf('/')
    return (idx >= 0 ? s.substring(0, idx) : s) + reference
  }
  if (target.startsWith('queryParam_')) {
    const i = parseInt(target.split('_')[1])
    updateConfig({
      queryParams: config.queryParams.map((p, idx) => idx === i ? { ...p, value: replaceLastSlash(p.value) } : p),
    })
  } else if (target.startsWith('header_')) {
    const i = parseInt(target.split('_')[1])
    updateConfig({
      headers: config.headers.map((p, idx) => idx === i ? { ...p, value: replaceLastSlash(p.value) } : p),
    })
  } else if (target === 'endpointUrl') {
    updateConfig({ endpointUrl: replaceLastSlash(config.endpointUrl) })
  } else if (target === 'body') {
    updateConfig({ body: replaceLastSlash(config.body || '') })
  }
}
