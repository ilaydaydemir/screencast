'use client'

import { useState } from 'react'
import { formatDuration } from '@/lib/format'
import { SocialExport } from '@/components/export/SocialExport'
import { SubtitleGenerator } from '@/components/subtitles/SubtitleGenerator'

interface WatchPlayerProps {
  videoUrl: string | null
  title: string
  duration: number
  shareId: string
}

export function WatchPlayer({ videoUrl, title, duration, shareId }: WatchPlayerProps) {
  const [copied, setCopied] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showSubs, setShowSubs] = useState(false)

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
          crossOrigin="anonymous"
        />
      </div>

      {/* Meta + actions */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold leading-snug">{title}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatDuration(duration)} recording
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => { setShowSubs(v => !v); setShowExport(false) }}
            className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors
              ${showSubs
                ? 'border-blue-500 bg-blue-500/10 text-blue-500'
                : 'border-border bg-card hover:bg-muted'
              }`}
          >
            {showSubs ? '✕' : '💬'} Subtitles
          </button>
          <button
            onClick={() => { setShowExport(v => !v); setShowSubs(false) }}
            className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors
              ${showExport
                ? 'border-red-500 bg-red-500/10 text-red-500'
                : 'border-border bg-card hover:bg-muted'
              }`}
          >
            {showExport ? '✕' : '📤'} Export
          </button>
          <button
            onClick={copyLink}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
          >
            {copied ? <><span className="text-green-500">✓</span> Copied!</> : <><span>🔗</span> Share</>}
          </button>
        </div>
      </div>

      {/* Share link */}
      <div
        onClick={copyLink}
        className="cursor-pointer rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
      >
        <span className="font-medium text-foreground">Share link: </span>
        <span className="break-all">{shareUrl}</span>
      </div>

      {/* Subtitle panel */}
      {showSubs && (
        <SubtitleGenerator videoUrl={videoUrl} title={title} />
      )}

      {/* Social export panel */}
      {showExport && (
        <SocialExport videoUrl={videoUrl} title={title} />
      )}
    </div>
  )
}
