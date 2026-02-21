'use client'

import { useEffect, useState } from 'react'

interface CountdownOverlayProps {
  onComplete: () => void
}

export function CountdownOverlay({ onComplete }: CountdownOverlayProps) {
  const [count, setCount] = useState(3)

  useEffect(() => {
    if (count <= 0) {
      onComplete()
      return
    }
    const timer = setTimeout(() => setCount((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [count, onComplete])

  if (count <= 0) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="animate-pulse text-8xl font-bold text-white">{count}</div>
    </div>
  )
}
