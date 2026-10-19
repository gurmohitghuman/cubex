import { createContext, useContext } from 'react'
import type { Start } from './tree-model'

// What every node of one JsonTree reads: which containers are open (kept at the
// root by path, so a reload of the same answer keeps what the person opened),
// the columns already mapped, the pick ("Add as column") and copying a path.
export interface TreeState {
  isOpen: (path: string) => boolean
  toggle: (path: string) => void
  // A page shown later opens the way the first did (within the same budget).
  openPage: (starts: Start[]) => void
  // The column a path is already mapped to, compared by what the path reads (readPath.ts pathKey).
  columnFor: (path: string) => string | undefined
  // Omitted: values show without a pick button (read-only).
  onPick?: (jsonPath: string, columnName: string) => void
  pickLabel: string
  copyPath: (path: string) => void
  // A path the browser couldn't copy: it shows under its row to copy by hand.
  manual: string | null
  closeManual: () => void
}

export const TreeContext = createContext<TreeState | null>(null)

export function useTree(): TreeState {
  const t = useContext(TreeContext)
  if (!t) throw new Error('JsonTree node outside its tree')
  return t
}
