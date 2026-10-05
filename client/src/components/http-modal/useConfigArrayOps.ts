import { HTTPAPIConfig } from './types'

// Tiny helper hook that owns the add/remove/update array operations on the
// HTTPAPIConfig's queryParams, headers, and responseMapping arrays. Lives
// here so HTTPAPIColumnModal stays under the 200-line cap.
export function useConfigArrayOps(
  config: HTTPAPIConfig,
  updateConfig: (updates: Partial<HTTPAPIConfig>) => void,
) {
  const updateArr = <T,>(arr: T[], i: number, fn: (item: T) => T) => arr.map((p, idx) => idx === i ? fn(p) : p)

  return {
    addQueryParam: () => updateConfig({ queryParams: [...config.queryParams, { key: '', value: '' }] }),
    removeQueryParam: (i: number) => updateConfig({ queryParams: config.queryParams.filter((_, idx) => idx !== i) }),
    updateQueryParam: (i: number, field: 'key' | 'value', value: string) =>
      updateConfig({ queryParams: updateArr(config.queryParams, i, p => ({ ...p, [field]: value })) }),
    addHeader: () => updateConfig({ headers: [...config.headers, { key: '', value: '' }] }),
    removeHeader: (i: number) => updateConfig({ headers: config.headers.filter((_, idx) => idx !== i) }),
    updateHeader: (i: number, field: 'key' | 'value', value: string) =>
      updateConfig({ headers: updateArr(config.headers, i, p => ({ ...p, [field]: value })) }),
    addResponseMapping: () => updateConfig({ responseMapping: [...config.responseMapping, { jsonPath: '$', columnName: '' }] }),
    removeResponseMapping: (i: number) => updateConfig({ responseMapping: config.responseMapping.filter((_, idx) => idx !== i) }),
    updateResponseMapping: (i: number, field: 'jsonPath' | 'columnName', value: string) =>
      updateConfig({ responseMapping: updateArr(config.responseMapping, i, p => ({ ...p, [field]: value })) }),
  }
}
