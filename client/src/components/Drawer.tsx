import React, { Fragment, ReactNode } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { X } from 'lucide-react'

interface DrawerProps {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  /** Width/shape of the sliding panel. Defaults to max-w-md. Mirrors Modal's panelClassName. */
  panelClassName?: string
}

// Reusable slide-over panel (slides in from the right). Owns the chrome only:
// overlay, slide animation, the Dialog.Panel box, focus trap, Escape-to-close,
// backdrop-click-to-close, and body scroll lock (all from Headless Dialog).
// Mirrors Modal's prop conventions (isOpen / onClose / children / panelClassName)
// and shares its z-[20000] + Transition.Root API. Compose with DrawerHeader and
// DrawerBody for the standard header bar + scrollable body, or pass raw children
// for a custom layout. Right-side only by design — a `side` prop is intentionally
// deferred (YAGNI); add -translate-x-full + left-0 swaps if a left drawer is ever
// needed. Extracted from WebhookDrawer (the original one-off).
export const Drawer: React.FC<DrawerProps> = ({ isOpen, onClose, children, panelClassName }) => {
  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[20000]" onClose={onClose}>
        <Transition.Child as={Fragment}
          enter="ease-out duration-200" enterFrom="opacity-0" enterTo="opacity-100"
          leave="ease-in duration-150" leaveFrom="opacity-100" leaveTo="opacity-0">
          <div className="fixed inset-0 bg-black/30" />
        </Transition.Child>
        <div className="fixed inset-0 overflow-hidden">
          <div className="absolute inset-y-0 right-0 flex max-w-full">
            <Transition.Child as={Fragment}
              enter="transform transition ease-out duration-200" enterFrom="translate-x-full" enterTo="translate-x-0"
              leave="transform transition ease-in duration-150" leaveFrom="translate-x-0" leaveTo="translate-x-full">
              <Dialog.Panel className={`w-screen ${panelClassName || 'max-w-md'} bg-white shadow-xl flex flex-col h-full`}>
                {children}
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  )
}

// Standard drawer header bar: leading icon + title (+ optional description) on the
// left, optional headerRight content then the close button on the right. flex-shrink-0
// so it stays pinned while DrawerBody scrolls. The close button calls onClose (same
// handler the Dialog uses for Escape/backdrop). `headerRight` is the slot for
// per-feature controls (e.g. AI/HTTP run pause/resume/cancel) — keeps Drawer generic
// while letting content-heavy drawers carry a richer header. When `description` is set
// the bar grows past h-14 to fit the subtitle, so it uses min-height, not fixed height.
export function DrawerHeader({
  icon, title, description, headerRight, onClose,
}: {
  icon?: ReactNode
  title: string
  description?: string
  headerRight?: ReactNode
  onClose: () => void
}) {
  return (
    <div className="flex items-center justify-between border-b border-gray-200 px-4 min-h-14 py-2 flex-shrink-0">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          {description && <p className="text-xs text-gray-600">{description}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {headerRight}
        <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// Scrollable drawer body. flex-1 so it fills the panel below the header and
// scrolls on overflow; p-4 space-y-5 gives the standard padding + section rhythm.
export function DrawerBody({ children }: { children: ReactNode }) {
  return <div className="flex-1 overflow-y-auto p-4 space-y-5">{children}</div>
}

export default Drawer
