'use client'

import { useState } from 'react'
import { formatDuration } from '@/lib/format'

interface WatchPlayerProps {
  videoUrl: string | null
  title: string
  duration: number
  shareId: string
}

export function WatchPlayer({ videoUrl, title, duration, shareId }: WatchPlayerProps) {
  const [copied, setCopied] = useState(false)

  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/watch/${shareId}`
    : ''

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!videoUrl) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-2xl bg-muted">
        <p className="text-muted-foreground">Video unavailable</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Video */}
      <div className="overflow-hidden rounded-2xl bg-black shadow-2xl">
        <video
          src={videoUrl}
          controls
          className="block w-full"
          style={{ maxHeight: '70vh' }}
          playsInline
        />
      </div>

      {/* Meta + share */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold leading-snug">{title}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatDuration(duration)} recording
          </p>
        </div>

        <button
          onClick={copyLink}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
        >
          {copied ? (
            <><span className="text-green-500">✓</span> Copied!</>
          ) : (
            <><span>🔗</span> Copy link</>
          )}
        </button>
      </div>

      {/* Share link box */}
      <div
        onClick={copyLink}
        className="cursor-pointer rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
      >
        <span className="font-medium text-foreground">Share link: </span>
        <span className="break-all">{shareUrl}</span>
      </div>
    </div>
  )
}
