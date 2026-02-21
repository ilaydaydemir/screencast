'use client'

import { useRecordings } from '@/hooks/useRecordings'
import { RecordingCard } from './RecordingCard'
import { RecordingEmptyState } from './RecordingEmptyState'

export function RecordingGrid() {
  const { recordings, loading, deleteRecording } = useRecordings()

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="aspect-video animate-pulse rounded-lg bg-muted"
          />
        ))}
      </div>
    )
  }

  if (recordings.length === 0) {
    return <RecordingEmptyState />
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {recordings.map((recording) => (
        <RecordingCard
          key={recording.id}
          recording={recording}
          onDelete={deleteRecording}
        />
      ))}
    </div>
  )
}
