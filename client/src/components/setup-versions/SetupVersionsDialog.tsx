import React, { useEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import Modal from '@/components/Modal'
import { useSetupVersions } from './useSetupVersions'
import { VersionList } from './VersionList'
import { VersionPlan } from './VersionPlan'

interface Props {
  sheetId: string | null
  sheetName: string
  onClose: () => void
  onRestored: (sheetId: string) => void
}

// A sheet's setup versions (the sheet tab's menu, the Setups menu): save the
// setup as it is now, compare a version with the sheet, restore it. A version
// keeps how columns are set up, never what's in them; restoring runs nothing.
export const SetupVersionsDialog: React.FC<Props> = ({ sheetId, sheetName, onClose, onRestored }) => {
  const s = useSetupVersions(sheetId, onRestored)
  const v = s.view
  const close = () => { if (!s.busy) onClose() }
  // The button that opened a view goes with it: focus moves to the way back.
  const backRef = useRef<HTMLButtonElement>(null)
  // Opened, it waits for a name: the box to type one in has focus. Again once the menu that opened it has
  // closed (it hides the page while it closes), unless focus is in the dialog already.
  const nameRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!sheetId) return
    const t = setTimeout(() => {
      if (!document.activeElement?.closest('[data-testid="setup-versions-dialog"]')) nameRef.current?.focus()
    }, 250)
    return () => clearTimeout(t)
  }, [sheetId])
  useEffect(() => { if (v.kind !== 'list') backRef.current?.focus() }, [v.kind])
  const plan = v.kind === 'compare' ? v.plan : null
  return (
    <Modal isOpen={!!sheetId} onClose={close} initialFocus={nameRef as React.MutableRefObject<HTMLElement | null>}
      panelClassName={`${v.kind === 'list' ? 'max-w-3xl' : 'max-w-5xl'} w-full`}>
      <div data-testid="setup-versions-dialog">
        <div className="px-6 pt-5 pb-4 border-b border-gray-200">
          {v.kind === 'list' ? (
            <>
              <h3 className="text-title text-gray-900 truncate">Setup versions: {sheetName}</h3>
              <p className="text-sm text-gray-600 mt-1">
                Save how this sheet's columns are set up (prompts, requests, formulas, cleaners, lookups, rules,
                auto-run, descriptions and column order) and put it back later. Cell values are never saved or
                changed.
              </p>
            </>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <button type="button" ref={backRef} className="btn-secondary px-2" onClick={s.back} disabled={s.busy}
                aria-label="All versions" data-testid="setup-versions-back">
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
              <h3 className="text-title text-gray-900 truncate">
                {v.kind === 'done' ? `Restored: ${v.answer.version.name}` : v.version.name}
              </h3>
            </div>
          )}
        </div>
        {s.error && (
          <p className="mx-6 mt-3 text-sm text-red-700 bg-red-50 rounded px-3 py-2" role="alert"
            data-testid="setup-versions-error">{s.error}</p>
        )}
        {v.kind === 'list' && (
          <VersionList versions={s.versions} busy={s.busy} onSave={s.save} onCompare={s.compare}
            onRename={s.rename} onDelete={s.remove} nameRef={nameRef} />
        )}
        {v.kind === 'compare' && (plan ? <VersionPlan plan={plan} />
          : <p className="px-6 py-8 text-sm text-gray-500">Comparing with the sheet…</p>)}
        {v.kind === 'done' && <VersionPlan plan={v.answer} />}
        {plan?.blocked && (
          <p className="mx-6 mb-3 text-sm text-amber-900 bg-amber-50 rounded px-3 py-2" role="status"
            data-testid="setup-version-blocked">{plan.blocked}</p>
        )}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center gap-3">
          {plan && !plan.nothing && !plan.blocked ? (
            <p className="text-xs text-gray-600 flex-1">
              Nothing runs, nothing is billed, and no cell changes. Your current setup is saved as a version first,
              so you can switch back.
            </p>
          ) : <div className="flex-1" />}
          {v.kind === 'compare' ? (
            <>
              <button type="button" className="btn-secondary" onClick={s.back} disabled={s.busy}>Back</button>
              {!plan?.nothing && (
                <button type="button" className="btn-primary whitespace-nowrap" data-testid="setup-version-restore"
                  disabled={s.busy || !plan || !!plan.blocked} onClick={() => void s.restore(v.version)}>
                  {s.busy && plan ? 'Restoring…' : 'Restore this version'}
                </button>
              )}
            </>
          ) : (
            <button type="button" className="btn-secondary" onClick={close} disabled={s.busy}
              data-testid="setup-versions-close">{v.kind === 'done' ? 'Done' : 'Close'}</button>
          )}
        </div>
      </div>
    </Modal>
  )
}
