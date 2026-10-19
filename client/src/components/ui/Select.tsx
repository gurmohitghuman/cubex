import React from 'react'
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react'
import { Check, ChevronDown } from 'lucide-react'

type Value = string | number
export interface SelectOption<T extends Value> { value: T; label: string; disabled?: boolean }
export interface SelectGroup<T extends Value> { label: string; options: Array<SelectOption<T>> }

interface Props<T extends Value> {
  value: T
  onChange: (value: T) => void
  // A flat list, or named groups of options.
  options?: Array<SelectOption<T>>
  groups?: Array<SelectGroup<T>>
  // What a screen reader calls it (and what the e2e specs find it by).
  label: string
  // For a <label htmlFor> beside it.
  id?: string
  // Shown when the value matches no option.
  placeholder?: string
  // field: the app's .input box, in forms and drawers; compact / tiny: the small ones in panels and bars.
  variant?: 'field' | 'compact' | 'tiny'
  // Width and flex behaviour, or a smaller padding.
  className?: string
  disabled?: boolean
  title?: string
  testId?: string
  // A pick-to-do-something list ("Insert a column…", "+ Add"): the value stays '' and the
  // placeholder is its words, so nothing in it shows as chosen.
  action?: boolean
  // Inside a Radix menu (the column header's): the options stay in its DOM, so its focus trap
  // and outside-click handling count them as inside it.
  inline?: boolean
}

const LOOK = {
  field: 'input gap-2 pr-2.5',
  compact: 'rounded border border-gray-300 bg-white py-1 pl-2 pr-1.5 text-sm hover:border-gray-400 '
    + 'focus:outline-none data-[focus]:border-cube-black data-[open]:border-cube-black gap-1',
  tiny: 'rounded border border-gray-300 bg-white py-0.5 pl-1.5 pr-1 text-xs hover:border-gray-400 '
    + 'focus:outline-none data-[focus]:border-cube-black data-[open]:border-cube-black gap-1',
}

// A dropdown drawn like the app's menus (the browser's own list looked out of
// place and differed in every browser). Headless UI's Listbox: arrow keys,
// type to jump, Escape, and a listbox screen readers announce. The options
// float above the page (above dialogs and drawers too), so a narrow panel never
// cuts them off; they grow to fit their labels. They open and close at once, as the
// browser's do (a fade left a moment where Escape or a quick next step went astray).
// The button and each option carry the value as data-value (the e2e specs pick and
// check by it).
export function Select<T extends Value>({
  value, onChange, options, groups, label, id, placeholder = '', variant = 'field', className = '', disabled,
  title, testId, action, inline,
}: Props<T>) {
  // Empty groups are left out (no heading over nothing).
  const shown = groups?.filter(g => g.options.length > 0)
  const all = shown ? shown.flatMap(g => g.options) : options ?? []
  const current = all.find(o => o.value === value)
  const item = (o: SelectOption<T>) => (
    <ListboxOption key={String(o.value)} value={o.value} disabled={o.disabled} data-value={String(o.value)}
      title={o.label}
      className={'group flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-gray-900 '
        + 'data-[focus]:bg-gray-100 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50'}>
      <Check className="invisible h-3.5 w-3.5 shrink-0 group-data-[selected]:visible" aria-hidden="true" />
      <span className="truncate">{o.label}</span>
    </ListboxOption>
  )
  return (
    // A pick of what's already chosen changes nothing, as on the browser's select (Listbox calls
    // onChange on every pick, and some handlers reset what depends on the value).
    <Listbox value={value} onChange={(v: T) => { if (v !== value) onChange(v) }} disabled={disabled}>
      <ListboxButton id={id} aria-label={label} data-testid={testId} data-value={String(value)}
        data-action={action || undefined}
        title={title ?? current?.label}
        className={'flex min-w-0 items-center justify-between text-left text-gray-900 '
          + `disabled:cursor-not-allowed disabled:opacity-50 ${LOOK[variant]} ${className}`}>
        {/* min-h: an empty value keeps the button as tall as the others. */}
        <span className={`min-h-[1lh] truncate ${current ? '' : 'text-gray-500'}`}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden="true" />
      </ListboxButton>
      {/* data-select-options: a menu this sits in can ignore clicks and focus here (isSelectOptions). */}
      <ListboxOptions anchor={{ to: 'bottom start', gap: 4 }} portal={!inline} data-select-options
        className={'z-[30000] max-h-72 w-max min-w-[max(var(--button-width),11rem)] '
          + 'max-w-[max(var(--button-width),20rem)] overflow-y-auto rounded-md border border-gray-200 bg-white p-1 '
          + 'pointer-events-auto text-sm shadow-lg focus:outline-none'}>
        {/* A group without a name is set apart by a thin line instead of a heading. */}
        {shown ? shown.map((g, i) => (
          <div key={`${i}:${g.label}`} role="group" aria-label={g.label || undefined}
            className={i > 0 && !g.label ? 'mt-1 border-t border-gray-100 pt-1' : ''}>
            {g.label && (
              <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500"
                aria-hidden="true">{g.label}</div>
            )}
            {g.options.map(item)}
          </div>
        )) : all.map(item)}
      </ListboxOptions>
    </Listbox>
  )
}

// For a Radix menu or popover holding a Select: its options float outside it,
// so a click or focus there must not count as leaving it (onInteractOutside).
export const isSelectOptions = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest('[data-select-options]')
