import React, { useEffect, useState } from 'react'
import { settingsAPI } from '@/utils/api'
import { SETUP_KIND_LABEL } from '@/utils/api/setups'
import type { UseSetupForm } from './useUseSetupForm'

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'
const MODELS_LIST = 'setup-models'
const RADIO = 'border-gray-300 text-cube-black focus:ring-black'

// The setup fitted to this sheet: a column for each input, a name for each
// column it makes (a name the sheet has already is marked), the AI models, and
// every row or a test on the first ones.
export const SetupFitForm: React.FC<{ form: UseSetupForm; columns: string[] }> = ({ form: f, columns }) => {
  const [modelIds, setModelIds] = useState<string[]>([])
  const hasAi = !!f.setup?.spec.steps.some(s => s.kind === 'ai')
  useEffect(() => {
    if (!hasAi || modelIds.length) return
    settingsAPI.listOpenRouterModels().then(ms => setModelIds(ms.map(m => m.id))).catch(() => { /* typing works */ })
  }, [hasAi, modelIds.length])
  if (!f.setup) return null
  const { setup } = f

  return (
    <div className="space-y-5">
      {setup.inputs.length > 0 && (
        <div>
          <span className={LABEL}>Columns it reads from this sheet</span>
          <div className="space-y-2">
            {setup.inputs.map(input => (
              <label key={input} className="flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 truncate text-gray-800" title={input}>{input}</span>
                <select className={`input flex-1 min-w-0 ${f.estimate.missing.includes(input) ? 'border-red-400' : ''}`}
                  value={f.inputs[input] ?? ''} aria-label={`Column for ${input}`} data-testid="setup-input"
                  onChange={e => f.setInputs({ ...f.inputs, [input]: e.target.value })}>
                  <option value="">Pick a column…</option>
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <span className={LABEL}>Columns it makes</span>
        <div className="space-y-2">
          {setup.steps.map((s, i) => {
            const step = setup.spec.steps[i]
            // Its output columns can be renamed too; an AI step's (Data) column follows its name.
            const outputs = s.columns.slice(1).filter(c => !(s.kind === 'ai' && c.endsWith(' (Data)')))
            const shown = (c: string) => f.names[c] ?? c
            const taken = (c: string) => f.estimate.taken.some(t => t.toLowerCase() === shown(c).toLowerCase())
            const nameInput = (c: string, extra: string) => (
              <input className={`input ${extra} ${taken(c) ? 'border-red-400' : ''}`} value={shown(c)}
                aria-label={`Name for ${c}`} data-testid="setup-name-input"
                onChange={e => f.setNames({ ...f.names, [c]: e.target.value })} />
            )
            return (
              <div key={s.column} className="text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="w-40 shrink-0 text-xs text-gray-500">{SETUP_KIND_LABEL[s.kind]}</span>
                  {nameInput(s.column, 'flex-1 min-w-[10rem]')}
                  {step?.kind === 'ai' && (
                    <input className="input w-56" list={MODELS_LIST} aria-label={`Model for ${s.column}`}
                      placeholder={step.model ?? 'Your default model'} value={f.models[s.column] ?? ''}
                      onChange={e => f.setModels({ ...f.models, [s.column]: e.target.value })} />
                  )}
                </div>
                {outputs.length > 0 && (
                  <div className="ml-[10.75rem] mt-1 flex flex-wrap gap-2">
                    {outputs.map(c => <React.Fragment key={c}>{nameInput(c, 'w-48 py-1 text-xs')}</React.Fragment>)}
                  </div>
                )}
                {[s.column, ...outputs].some(taken) && (
                  <p className="ml-[10.75rem] text-xs text-red-600">This sheet already has a column by that name.</p>
                )}
              </div>
            )
          })}
        </div>
        <datalist id={MODELS_LIST}>{modelIds.map(id => <option key={id} value={id} />)}</datalist>
        {hasAi && (
          <p className="text-xs text-gray-500 mt-1">An AI step keeps its saved model unless you pick another.</p>
        )}
      </div>

      <fieldset>
        <legend className={LABEL}>Rows</legend>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-gray-700">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="setup-rows" checked={!f.test.on}
              onChange={() => f.setTest({ ...f.test, on: false })} className={RADIO} />
            Every row
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="setup-rows" checked={f.test.on} data-testid="setup-test-rows"
              onChange={() => f.setTest({ ...f.test, on: true })} className={RADIO} />
            Test on the first
            <input type="number" min={1} max={1000} className="input w-20 py-1" value={f.test.rows}
              aria-label="Rows to test on"
              onChange={e => f.setTest({ on: true, rows: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} />
            rows
          </label>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          After a run on every row, the auto-runs saved with the setup are turned on. A test doesn&apos;t turn them on.
        </p>
      </fieldset>
    </div>
  )
}
