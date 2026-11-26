import React from 'react'
import { AppSidebar } from './AppSidebar'

// The home, Settings and Trash: the sidebar on the left, the page beside it, which scrolls on its own so the
// sidebar stays put. The sheet page has no shell: the grid takes the whole width.
export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex h-screen bg-white">
    <AppSidebar />
    <main className="min-w-0 flex-1 overflow-auto">{children}</main>
  </div>
)
