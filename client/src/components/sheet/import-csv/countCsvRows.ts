// How many data rows a CSV file holds (the header row not counted), read in
// chunks so a big file never sits in memory at once. Line breaks inside a
// quoted cell don't end a row, as in the server's parser. Past `maxBytes` the
// rest is scaled by size, so a big file answers fast: `exact` says which.
// Used for the import's auto-run notice ("about" is fine; a malformed file is
// the server's to refuse).
export async function countCsvRows(
  file: Blob, maxBytes = Number.POSITIVE_INFINITY,
): Promise<{ rows: number; exact: boolean }> {
  const decoder = new TextDecoder()
  const reader = file.stream().getReader()
  let inQuotes = false
  let lines = 0
  let pending = false   // the current line has content not yet counted
  let read = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (value) read += value.byteLength
    const text = done ? decoder.decode() : decoder.decode(value, { stream: true })
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '"') inQuotes = !inQuotes
      else if (ch === '\n' && !inQuotes) { if (pending) lines++; pending = false; continue }
      if (ch !== '\r') pending = true
    }
    if (done) break
    if (read >= maxBytes && read < file.size) {
      await reader.cancel()
      return { rows: Math.max(0, Math.round((lines * file.size) / read) - 1), exact: false }
    }
  }
  if (pending) lines++
  return { rows: Math.max(0, lines - 1), exact: true }
}
