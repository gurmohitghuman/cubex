import React from 'react'

// A structured row's answer: each output column and what it got (empty when the model didn't know).
export const PreviewFields: React.FC<{ fields: Record<string, string> }> = ({ fields }) => (
  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-sm" data-testid="preview-fields">
    {Object.entries(fields).map(([name, value]) => (
      <React.Fragment key={name}>
        <dt className="text-gray-500">{name}</dt>
        <dd className={value ? 'text-gray-800 whitespace-pre-wrap' : 'text-gray-400'}>{value || 'empty'}</dd>
      </React.Fragment>
    ))}
  </dl>
)
