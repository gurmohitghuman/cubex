import { useRef } from 'react'

// Stable colId per column name. AG Grid's column matching across columnDef updates uses
// colId (or field if no colId). We give each column a colId that's INDEPENDENT of its
// current name, so renaming `Foo` -> `FooBar` keeps the same colId and AG Grid sees it
// as the same column at the same position. The map persists across renders.
//
// This stable colId pattern is load-bearing.
// The lastRenamedColumn signal must arrive in the SAME render batch as the columnDefs
// change, otherwise AG Grid does its remove+add dance first.
export const useColIdMap = (lastRenamedColumn: { from: string; to: string; at: number } | null) => {
  const nameToColIdRef = useRef<Map<string, string>>(new Map())
  const lastRenameAtRef = useRef<number>(0)

  // When SheetPage signals a rename, move the existing colId from the old name to the
  // new one BEFORE the next columnDef rebuild. AG Grid then sees the column's identity
  // unchanged across the field rename — no remove/add cycle, no end-positioning.
  if (lastRenamedColumn && lastRenamedColumn.at !== lastRenameAtRef.current) {
    lastRenameAtRef.current = lastRenamedColumn.at
    const map = nameToColIdRef.current
    const existingColId = map.get(lastRenamedColumn.from)
    if (existingColId) {
      map.delete(lastRenamedColumn.from)
      map.set(lastRenamedColumn.to, existingColId)
    }
  }

  const colIdFor = (name: string): string => {
    const map = nameToColIdRef.current
    let id = map.get(name)
    if (!id) {
      // Generate once on first sighting; never changes again.
      id = `col_${Math.random().toString(36).slice(2, 11)}_${Date.now().toString(36)}`
      map.set(name, id)
    }
    return id
  }

  return { nameToColIdRef, colIdFor }
}
