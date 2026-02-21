'use client'

import { UserMenu } from './UserMenu'

export function Header() {
  return (
    <header className="flex h-14 items-center justify-between border-b px-6">
      <div />
      <UserMenu />
    </header>
  )
}
