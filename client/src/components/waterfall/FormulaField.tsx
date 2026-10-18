import React, { useRef } from 'react'

interface Props {
  formula: string
  names: string[]            // what {{…}} can name: the input keys (and "value" for a check)
  label: string
  placeholder: string
  onChange: (formula: string) => void
}

// A formula over {{name}} refs (JavaScript, worked out in a sandbox on the
// server): a formula step's, or a check's over {{value}}. The chips insert a
// reference where the cursor is.
export const FormulaField: React.FC<Props> = ({ formula, names, label, placeholder, onChange }) => {
  const box = useRef<HTMLTextAreaElement>(null)
  const insert = (name: string) => {
    const el = box.current
    const at = el ? el.selectionStart : formula.length
    onChange(`${formula.slice(0, at)}{{${name}}}${formula.slice(at)}`)
  }
  return (
    <div className="space-y-1">
      <textarea ref={box} className="input w-full h-16 font-mono text-xs" value={formula} aria-label={label}
        placeholder={placeholder} onChange={e => onChange(e.target.value)} />
      <div className="flex flex-wrap gap-1">
        {names.map(n => (
          <button key={n} type="button" onClick={() => insert(n)}
            className="px-1.5 py-0.5 text-[11px] border border-gray-300 text-gray-600 hover:border-gray-500">
            {`{{${n}}}`}
          </button>
        ))}
      </div>
    </div>
  )
}
