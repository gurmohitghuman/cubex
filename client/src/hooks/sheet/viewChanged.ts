import toast from 'react-hot-toast'

// A filter save refused because another view became active (switched in
// another tab, server routes/sheets-crud.ts): say so; the caller reloads.
export function viewChanged(error: unknown): boolean {
  const data = (error as { response?: { status?: number; data?: { viewChanged?: boolean; error?: string } } })?.response
  if (data?.status !== 409 || !data.data?.viewChanged) return false
  toast(data.data.error || 'Another view is showing now. Reloading.')
  return true
}
