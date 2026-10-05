import React, { Fragment, ReactNode } from 'react'
import { Dialog, Transition } from '@headlessui/react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  panelClassName?: string
  // z-index class for the Dialog. Defaults to z-[20000] (the app's standard overlay
  // layer). Override when a modal must stack ABOVE another z-[20000] overlay — e.g.
  // the HTTP template browser opens on top of the HTTP API drawer, so it passes
  // z-[20010]. Without this both share z-[20000] and the nested one can render behind.
  zClassName?: string
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, children, panelClassName, zClassName }) => {
  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className={`relative ${zClassName || 'z-[20000]'}`} onClose={onClose}>
        {/* Overlay */}
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/40 backdrop-blur-[1px]" />
        </Transition.Child>

        {/* Panel */}
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 translate-y-1 scale-95"
              enterTo="opacity-100 translate-y-0 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 translate-y-0 scale-100"
              leaveTo="opacity-0 translate-y-1 scale-95"
            >
              <Dialog.Panel className={
                `w-full transform overflow-hidden bg-white text-left align-middle transition-all flex flex-col ${
                  panelClassName || 'max-w-lg'
                }`
              }>
                {children}
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  )
}

export default Modal
