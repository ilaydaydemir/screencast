'use client'

import { VideoPlayer } from '@/components/playback/VideoPlayer'
import { formatDuration } from '@/lib/format'

interface WatchPlayerProps {
  videoUrl: string | null
  title: string
  duration: number
}

export function WatchPlayer({ videoUrl, title, duration }: WatchPlayerProps) {
  if (!videoUrl) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-lg bg-muted">
        <p className="text-muted-foreground">Video unavailable</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <VideoPlayer src={videoUrl} title={title} />
      <div>
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {formatDuration(duration)} recording
        </p>
      </div>
    </div>
  )
}
