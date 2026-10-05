import React, { useLayoutEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import Modal from './Modal'

interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm: () => void
  onCancel: () => void
  isDestructive?: boolean
  isLoading?: boolean
  // Raise above another open overlay (e.g. a drawer): see Modal's zClassName.
  zClassName?: string
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  isDestructive = false,
  isLoading = false,
  zClassName,
}) => {
  // The Modal keeps the panel mounted through its ~150ms leave animation. Callers
  // usually derive title/message from the SAME state that toggles isOpen (e.g.
  // `${selectedRows.length} selected row(s)`), and clear that state in onConfirm —
  // so without this, the panel would re-render mid-fade showing stale content like
  // "0 selected row(s)". We render a committed SNAPSHOT of the display props while
  // closed, so the exit animation shows the last live text. Snapshot ONLY display
  // props — onConfirm/onCancel must stay current — and update it in an effect (not
  // a render-phase ref mutation, which is unsafe under StrictMode/concurrent render).
  const [snapshot, setSnapshot] = useState({ title, message, confirmText, cancelText, isDestructive })
  useLayoutEffect(() => {
    if (isOpen) setSnapshot({ title, message, confirmText, cancelText, isDestructive })
  }, [isOpen, title, message, confirmText, cancelText, isDestructive])
  const display = isOpen ? { title, message, confirmText, cancelText, isDestructive } : snapshot

  return (
    <Modal isOpen={isOpen} onClose={onCancel} panelClassName="max-w-md w-full" zClassName={zClassName}>
      <div className="p-6">
        <div className="flex items-start space-x-4">
          <div className={`flex-shrink-0 p-2 ${
            display.isDestructive ? 'bg-cube-black' : 'bg-white border border-cube-black'
          }`}>
            <AlertTriangle className={`h-6 w-6 ${
              display.isDestructive ? 'text-white' : 'text-cube-black'
            }`} />
          </div>

          <div className="flex-1">
            <h3 className="text-title text-gray-900 mb-2">
              {display.title}
            </h3>
            <p className="text-gray-600 text-sm whitespace-pre-wrap">
              {display.message}
            </p>
          </div>
        </div>

        <div className="flex justify-end space-x-3 mt-6">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="btn-secondary"
          >
            {display.cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className={`flex items-center space-x-2 ${
              display.isDestructive ? 'btn-danger' : 'btn-primary'
            }`}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-white" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            <span>{display.confirmText}</span>
          </button>
        </div>
      </div>
    </Modal>
  )
}
