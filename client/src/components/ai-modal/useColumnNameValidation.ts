import { useEffect, useState } from 'react'

const NO_LETTER_OR_DIGIT = 'A column name needs at least one letter A-Z or digit 0-9, which Cubex uses '
  + 'to reference it as /name (for example "城市 city" works, "城市" alone does not work yet).'
export const NAME_TAKEN = 'A column with this name already exists'

// Case-insensitive uniqueness against existing columns, skipping the column the
// user opened to edit (`editingName`). Names are Google-Sheets-permissive
// ("# Revenue" is fine) — the server is authoritative; the client only flags the
// two things the user can fix inline: a name with no letter/number at all
// (symbol-only → no /token), and a duplicate. '' = fine.
export function columnNameError(
  columnName: string, columnSuggestions: Array<{ name: string }>, editingName: string | null,
): string {
  const name = columnName.trim()
  if (!name) return ''
  if (!/[A-Za-z0-9]/.test(name)) return NO_LETTER_OR_DIGIT
  const lower = name.toLowerCase()
  if (editingName && editingName.toLowerCase() === lower) return ''
  return columnSuggestions.some(c => c.name.toLowerCase() === lower) ? NAME_TAKEN : ''
}

// editingName comes from the modal's own state, set when an edit opens. It used
// to be re-read from the one-shot 'ai_modal_initial' payload, which the open
// already consumed, so editing a column always reported its own name as taken.
export const useColumnNameValidation = (
  columnName: string,
  columnSuggestions: Array<{ name: string }>,
  editingName: string | null,
) => {
  const [nameError, setNameError] = useState('')
  useEffect(() => {
    setNameError(columnNameError(columnName, columnSuggestions, editingName))
  }, [columnName, columnSuggestions, editingName])
  return nameError
}
