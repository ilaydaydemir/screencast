'use client'

import { Pause, Play, Square, Download, Upload, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RecordingTimer } from './RecordingTimer'
import type { RecordingState } from '@/hooks/useScreenRecorder'

interface RecordingControlsProps {
  state: RecordingState
  elapsedSeconds: number
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onDownload: () => void
  onUpload: () => void
  onDiscard: () => void
  uploading?: boolean
}

export function RecordingControls({
  state,
  elapsedSeconds,
  onPause,
  onResume,
  onStop,
  onDownload,
  onUpload,
  onDiscard,
  uploading,
}: RecordingControlsProps) {
  if (state === 'recording' || state === 'paused') {
    return (
      <div className="flex items-center gap-4">
        <RecordingTimer
          seconds={elapsedSeconds}
          isRecording={state === 'recording'}
        />
        {state === 'recording' ? (
          <Button variant="outline" size="sm" onClick={onPause}>
            <Pause className="mr-2 h-4 w-4" />
            Pause
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onResume}>
            <Play className="mr-2 h-4 w-4" />
            Resume
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={onStop}>
          <Square className="mr-2 h-4 w-4" />
          Stop
        </Button>
      </div>
    )
  }

  if (state === 'stopped') {
    return (
      <div className="flex items-center gap-3">
        <RecordingTimer seconds={elapsedSeconds} isRecording={false} />
        <Button variant="outline" size="sm" onClick={onDownload}>
          <Download className="mr-2 h-4 w-4" />
          Download
        </Button>
        <Button size="sm" onClick={onUpload} disabled={uploading}>
          <Upload className="mr-2 h-4 w-4" />
          {uploading ? 'Uploading...' : 'Save & Share'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          <Trash2 className="mr-2 h-4 w-4" />
          Discard
        </Button>
      </div>
    )
  }

  return null
}
