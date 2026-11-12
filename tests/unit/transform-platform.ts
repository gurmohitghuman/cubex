// The one platform check of the transform tests. A case there for size alone (a 300,000-row sheet) runs on Linux
// only: the Windows runner is slower, and the same behaviour is proven there at a size that shows it. On Windows
// such a case is skipped, saying so in one line. Every behaviour case runs on both.
export const onWindows = process.platform === 'win32'

// Whether to run a case there for size: true, except on Windows, which says it skips it.
export function sizeCase(what: string): boolean {
  if (onWindows) console.log(`skip on Windows: ${what} (runs on Linux)`)
  return !onWindows
}
