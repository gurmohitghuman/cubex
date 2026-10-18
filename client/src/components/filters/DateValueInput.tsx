import React from 'react'

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

// A date filter's value: the browser's date picker, which always gives
// YYYY-MM-DD. A value saved in another format (through the API: "Jan 31,
// 2024") stays in a text box, so opening the filter never loses it; the
// server reads either (lib/row-filter/dates.ts). Cleared, or typed as
// YYYY-MM-DD, the text box turns back into the picker.
export const DateValueInput: React.FC<{
  value: string
  onChange: (value: string) => void
  onCommit?: () => void
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void
  className?: string
  autoFocus?: boolean
}> = ({ value, onChange, onCommit, onBlur, className, autoFocus }) => {
  const [picker, setPicker] = React.useState(() => value === '' || ISO_DAY.test(value))
  return (
    <input type={picker ? 'date' : 'text'} value={value} autoFocus={autoFocus} aria-label="Date"
      placeholder={picker ? undefined : 'A date, like 2024-01-31'}
      onChange={e => {
        if (!picker && (e.target.value === '' || ISO_DAY.test(e.target.value))) setPicker(true)
        onChange(e.target.value)
      }} onBlur={onBlur}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onCommit?.() } }}
      className={className} />
  )
}
