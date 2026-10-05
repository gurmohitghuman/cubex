import { useRef, useState } from 'react'
import { useAccountDefaultModel } from './useAccountDefaultModel'

// Owns the modal's model provenance (file-size split from AIColumnModal):
// the current value — NO hardcoded default, '' until hydrated (draft > sheet
// default > account default) or picked, with Preview/Run disabled while empty —
// the account-wide fallback, and whether the user picked from THIS session's
// dropdown. The pick itself persists as the sheet default immediately (in
// ConfigureTab); the picked flag here protects the pick from async clobbers
// (late-arriving defaults, stale draft hydration).
export function useModelSelection(
  isOpen: boolean,
  onDefaultModelChanged?: (model: string | null) => void,
) {
  const [model, setModel] = useState('')
  const accountDefaultModel = useAccountDefaultModel(isOpen)
  const pickedRef = useRef(false)
  // Bound by the modal AFTER useAIModalInit runs (init needs setModel first —
  // late binding breaks the cycle). Marks the model explicit on pick, so an
  // async-arriving sheet/account default can't overwrite a fresh pick — the
  // run would then save the WRONG model as the sheet default.
  const noteExplicitModel = useRef<() => void>(() => {})

  return {
    model, setModel, accountDefaultModel, noteExplicitModel,
    pickedThisSession: () => pickedRef.current,
    resetPicked: () => { pickedRef.current = false },
    onModelPicked: () => { pickedRef.current = true; noteExplicitModel.current() },
    // Clearing un-marks any earlier pick — the run started after "Use account
    // default" must not re-pin the sheet to the account model.
    onSheetDefaultCleared: () => { pickedRef.current = false; onDefaultModelChanged?.(null) },
  }
}
