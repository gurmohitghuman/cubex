import React from 'react'
import { PHONE_FORMATS, DEFAULT_PHONE_COUNTRY, type PhoneFormat } from '@/lib/cleaners'

interface Props {
  format: PhoneFormat
  onFormat: (format: PhoneFormat) => void
  country: string
  onCountry: (country: string) => void
}

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'

// The phone cleaner's options: how every number is written, and the country
// whose numbers are read when a number has no country code.
export const CleanPhoneOptions: React.FC<Props> = ({ format, onFormat, country, onCountry }) => (
  <div className="flex flex-wrap items-start gap-x-6 gap-y-3" data-testid="clean-phone-options">
    <fieldset className="space-y-1.5">
      <legend className={LABEL}>Format</legend>
      {PHONE_FORMATS.map(f => (
        <label key={f.id} className="flex items-center gap-2 text-sm text-gray-700">
          <input type="radio" name="clean-phone-format" checked={format === f.id} onChange={() => onFormat(f.id)}
            className="border-gray-300 text-cube-black focus:ring-black" />
          {f.label}
          <span className="text-gray-500">{f.example}</span>
        </label>
      ))}
    </fieldset>
    <div className="max-w-[12rem]">
      <label htmlFor="clean-phone-country" className={LABEL}>Country</label>
      <input id="clean-phone-country" className="input w-16" value={country} maxLength={2}
        placeholder={DEFAULT_PHONE_COUNTRY} onChange={e => onCountry(e.target.value)} />
      <p className="text-xs text-gray-500 mt-1">
        Two letters, like US or GB: how numbers without a country code are read.
      </p>
    </div>
  </div>
)
