import React from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Bot, Globe, Sparkles, UserRound } from 'lucide-react'
import { SettingsAiTab } from '@/components/settings/SettingsAiTab'
import { SettingsEnrichmentTab } from '@/components/settings/SettingsEnrichmentTab'
import { SettingsAgentsTab } from '@/components/settings/SettingsAgentsTab'
import { SettingsAccountTab } from '@/components/settings/SettingsAccountTab'

// Settings shell: route-backed tabs (/settings/:tab — refresh, back button,
// and deep links like /settings/ai all work), one mental model per tab. Each
// tab component loads its own data with its own loading state, so the shell
// renders instantly and a slow fetch in one area never gates another.
const TABS = [
  { slug: 'ai', label: 'AI', icon: Sparkles, element: <SettingsAiTab /> },
  { slug: 'http-enrichment', label: 'HTTP Enrichment', icon: Globe, element: <SettingsEnrichmentTab /> },
  { slug: 'agents', label: 'Agent access', icon: Bot, element: <SettingsAgentsTab /> },
  { slug: 'account', label: 'Account', icon: UserRound, element: <SettingsAccountTab /> },
] as const

export const SettingsPage: React.FC = () => {
  const navigate = useNavigate()
  const { tab } = useParams<{ tab: string }>()

  const active = TABS.find(t => t.slug === tab)
  // /settings and any unknown slug land on the first-run critical path.
  if (!active) return <Navigate to="/settings/ai" replace />

  return (
    <div className="h-screen bg-white overflow-auto">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center space-x-4 mb-6">
          <button onClick={() => navigate('/dashboard')} className="p-2 text-gray-400 hover:text-gray-600 transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-title text-gray-900">Settings</h1>
            <p className="text-gray-600 text-sm">Configure your Cubex workspace</p>
          </div>
        </div>

        {/* The grey rule is an inset shadow, not a border, so the active tab's
            underline can cover it without poking out of the row: overflow-x-auto
            also turns on vertical scrolling, and a 1px overhang showed a scrollbar. */}
        <nav
          className="flex gap-1 mb-8 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_theme(colors.gray.200)]"
          aria-label="Settings sections"
        >
          {TABS.map(({ slug, label, icon: Icon }) => {
            const isActive = slug === active.slug
            return (
              <Link
                key={slug}
                to={`/settings/${slug}`}
                aria-current={isActive ? 'page' : undefined}
                className={`flex items-center gap-2 px-4 py-2.5 border-b-2 text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? 'border-cube-black text-cube-black font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-800'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            )
          })}
        </nav>

        {active.element}
      </div>
    </div>
  )
}
