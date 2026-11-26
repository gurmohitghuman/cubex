import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Bookmark, BookOpen, Bot, LogOut, PanelLeftClose, PanelLeftOpen, Settings, Table2, Trash2, Webhook,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { CubeLogo } from '@/components/CubeLogo'
import { useVersionInfo } from '@/hooks/useVersionInfo'
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed'

// Where the docs are: those of the release that runs (its tag), else main's.
const DOCS = 'https://github.com/gurmohitghuman/cubex/tree'

interface Item { to: string; label: string; icon: LucideIcon; testId?: string; current: (path: string) => boolean }

// The pages a person goes to most, top first; Setups, Agent access and Run webhooks are Settings tabs.
const TOP: Item[] = [
  { to: '/', label: 'Tables', icon: Table2, testId: 'nav-tables', current: p => p === '/' || p === '/dashboard' },
  { to: '/settings/setups', label: 'Setups', icon: Bookmark, current: p => p === '/settings/setups' },
  { to: '/settings/agents', label: 'Agent access', icon: Bot, current: p => p === '/settings/agents' },
  { to: '/settings/run-webhooks', label: 'Run webhooks', icon: Webhook, current: p => p === '/settings/run-webhooks' },
]
const IN_TOP = new Set(TOP.map(i => i.to))

const ROW = 'relative flex items-center gap-3 rounded-md px-2.5 h-9 text-sm transition-colors'
const rowClass = (on: boolean) => `${ROW} ${on
  ? 'bg-white text-gray-900 font-medium shadow-[0_0_0_1px_theme(colors.gray.200)]'
  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`

const NavLink: React.FC<{ item: Item; on: boolean; collapsed: boolean; children?: React.ReactNode }> = (
  { item, on, collapsed, children },
) => (
  <Link to={item.to} title={collapsed ? item.label : undefined} aria-current={on ? 'page' : undefined}
    data-testid={item.testId} className={rowClass(on)}>
    <item.icon className="h-4 w-4 flex-shrink-0" />
    <span className={collapsed ? 'sr-only' : 'truncate'}>{item.label}</span>
    {children}
  </Link>
)

// The left sidebar of the home, Settings and Trash (the sheet page keeps its full width for the grid): the pages,
// then at the bottom Trash, Settings, the docs, a new release when one is out, the version and Sign out. Collapsed
// it shows its icons only (hooks/useSidebarCollapsed.ts).
export const AppSidebar: React.FC = () => {
  const { pathname } = useLocation()
  const { logout } = useAuth()
  const version = useVersionInfo()
  const { collapsed, narrow, toggle } = useSidebarCollapsed()
  const newRelease = version?.update_available === true ? version.latest_release?.version ?? null : null
  const settings: Item = {
    to: newRelease ? '/settings/account' : '/settings', label: 'Settings', icon: Settings, testId: 'open-settings',
    current: p => p.startsWith('/settings') && !IN_TOP.has(p),
  }
  const trash: Item = { to: '/trash', label: 'Trash', icon: Trash2, testId: 'open-trash', current: p => p === '/trash' }
  return (
    <aside data-testid="app-sidebar" data-collapsed={collapsed ? 'true' : 'false'}
      className={`flex h-screen flex-shrink-0 flex-col border-r border-gray-200 bg-gray-50 ${
        collapsed ? 'w-14' : 'w-56'}`}>
      <div className={`flex h-14 items-center gap-2 border-b border-gray-200 ${collapsed ? 'justify-center' : 'px-3'}`}>
        <Link to="/" className="flex min-w-0 items-center gap-2" title="Tables">
          <CubeLogo size="md" />
          {!collapsed && <span className="truncate text-base font-brand-semibold text-gray-900">Cubex</span>}
        </Link>
        {!collapsed && (
          <button type="button" onClick={toggle} aria-label="Collapse the sidebar" title="Collapse the sidebar"
            data-testid="sidebar-toggle"
            className="ml-auto rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav aria-label="Main" className="flex flex-col gap-0.5 p-2">
        {TOP.map(item => <NavLink key={item.to} item={item} on={item.current(pathname)} collapsed={collapsed} />)}
      </nav>
      <nav aria-label="More" className="mt-auto flex flex-col gap-0.5 border-t border-gray-200 p-2">
        {collapsed && !narrow && (
          <button type="button" onClick={toggle} aria-label="Expand the sidebar" title="Expand the sidebar"
            data-testid="sidebar-toggle" className={rowClass(false)}>
            <PanelLeftOpen className="h-4 w-4 flex-shrink-0" />
          </button>
        )}
        <NavLink item={trash} on={trash.current(pathname)} collapsed={collapsed} />
        <NavLink item={settings} on={settings.current(pathname)} collapsed={collapsed}>
          {newRelease && (
            <span className={`h-2 w-2 rounded-full bg-cube-black ${
              collapsed ? 'absolute right-1.5 top-1.5' : 'ml-auto'}`}
              data-testid="settings-update-dot">
              <span className="sr-only">(a new release is out)</span>
            </span>
          )}
        </NavLink>
        <a href={`${DOCS}/${version?.version ?? 'main'}/docs`} target="_blank" rel="noopener noreferrer"
          title={collapsed ? 'Docs' : undefined} className={rowClass(false)} data-testid="open-docs">
          <BookOpen className="h-4 w-4 flex-shrink-0" />
          <span className={collapsed ? 'sr-only' : 'truncate'}>Docs</span>
        </a>
        {newRelease && !collapsed && (
          <Link to="/settings/account" data-testid="sidebar-new-release"
            className={'mx-1 my-1 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-xs text-gray-700 '
              + 'hover:border-gray-300'}>
            Cubex {newRelease} is out. <span className="underline">How to update</span>
          </Link>
        )}
        {!collapsed && version?.version && (
          <p className="px-2.5 py-1 text-xs text-gray-400 tabular-nums" data-testid="sidebar-version">
            Cubex {version.version}
          </p>
        )}
        <button type="button" onClick={logout} aria-label="Sign out" title="Sign out" className={rowClass(false)}>
          <LogOut className="h-4 w-4 flex-shrink-0" />
          <span className={collapsed ? 'sr-only' : 'truncate'}>Sign out</span>
        </button>
      </nav>
    </aside>
  )
}
