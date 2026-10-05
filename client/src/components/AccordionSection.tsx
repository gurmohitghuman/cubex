import React, { ReactNode } from 'react'
import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react'
import { ChevronDown, ChevronRight } from 'lucide-react'

// One collapsible section of a Clay-style config accordion (used by the HTTP API and
// AI Column drawers). Built on Headless UI's Disclosure (accessible button semantics,
// keyboard, ARIA state for free) with the codebase's ChevronRight/ChevronDown idiom
// inside the button. Sections are INDEPENDENT (multiple can be open at once) — config
// editing is cross-referential, so users keep related sections open together
//. `summary` is a compact right-aligned hint shown whether
// open or closed (e.g. a count or a truncated URL) so the collapsed drawer reads as a
// workspace, not a slideshow.
export function AccordionSection({
  title, summary, defaultOpen = false, children,
}: {
  title: string
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <Disclosure defaultOpen={defaultOpen}>
      {({ open }) => (
        <div className="border border-gray-200 rounded">
          <DisclosureButton className="flex w-full items-center justify-between px-3 py-2 hover:bg-gray-50 text-left">
            <span className="flex items-center gap-2 text-sm font-medium text-gray-700">
              {open ? <ChevronDown className="h-4 w-4 flex-shrink-0" /> : <ChevronRight className="h-4 w-4 flex-shrink-0" />}
              {title}
            </span>
            {summary != null && (
              <span className="text-xs text-gray-400 truncate ml-2 max-w-[55%]">{summary}</span>
            )}
          </DisclosureButton>
          <DisclosurePanel className="border-t border-gray-200 px-3 py-3 space-y-4">
            {children}
          </DisclosurePanel>
        </div>
      )}
    </Disclosure>
  )
}
