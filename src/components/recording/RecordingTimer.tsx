'use client'

import { formatDuration } from '@/lib/format'

interface RecordingTimerProps {
  seconds: number
  isRecording: boolean
}

export function RecordingTimer({ seconds, isRecording }: RecordingTimerProps) {
  return (
    <div className="flex items-center gap-2">
      {isRecording && (
        <div className="h-3 w-3 animate-pulse rounded-full bg-red-500" />
      )}
      <span className="font-mono text-sm font-medium">
        {formatDuration(seconds)}
      </span>
    </div>
  )
}
