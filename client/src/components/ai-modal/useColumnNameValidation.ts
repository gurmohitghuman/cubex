import { useEffect, useState } from 'react'

// Case-insensitive uniqueness against existing columns (skips the column the user is
// editing). Names are Google-Sheets-permissive ("# Revenue" is fine) — the server is
// authoritative; the client only flags the two things the user can fix inline: a name
// with no letter/number at all (symbol-only → no /token), and a duplicate.
export const useColumnNameValidation = (
  columnName: string,
  columnSuggestions: Array<{ name: string }>,
) => {
  const [nameError, setNameError] = useState('')
  useEffect(() => {
    const name = columnName.trim()
    if (!name) { setNameError(''); return }
    if (!/[A-Za-z0-9]/.test(name)) {
      setNameError('A column name needs at least one letter A-Z or digit 0-9, which Cubex uses to reference it as /name (for example "城市 city" works, "城市" alone does not work yet).')
      return
    }
    const initial = (() => { try { return JSON.parse(localStorage.getItem('ai_modal_initial') || 'null') } catch { return null } })()
    const editingSame = initial?.mode === 'edit' && initial?.columnName && initial.columnName.toLowerCase() === name.toLowerCase()
    const exists = !editingSame && columnSuggestions.some(c => c.name.toLowerCase() === name.toLowerCase())
    if (exists) { setNameError('A column with this name already exists'); return }
    setNameError('')
  }, [columnName, columnSuggestions])
  return nameError
}
