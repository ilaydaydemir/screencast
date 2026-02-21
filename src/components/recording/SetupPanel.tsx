'use client'

import { useEffect, useRef } from 'react'
import {
  Monitor,
  AppWindow,
  PanelTop,
  Camera,
  CameraOff,
  Mic,
  MicOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AudioLevelMeter } from './AudioLevelMeter'
import { cn } from '@/lib/utils'
import type { RecordingMode } from '@/lib/constants'
import { RECORDING_MODES } from '@/lib/constants'

const MODE_ICONS = {
  Monitor,
  AppWindow,
  PanelTop,
  Camera,
}

interface SetupPanelProps {
  mode: RecordingMode
  onModeChange: (mode: RecordingMode) => void
  cameras: { deviceId: string; label: string }[]
  microphones: { deviceId: string; label: string }[]
  selectedCamera: string | null
  selectedMic: string | null
  onCameraChange: (id: string | null) => void
  onMicChange: (id: string | null) => void
  onStart: () => void
  disabled?: boolean
}

export function SetupPanel({
  mode,
  onModeChange,
  cameras,
  microphones,
  selectedCamera,
  selectedMic,
  onCameraChange,
  onMicChange,
  onStart,
  disabled,
}: SetupPanelProps) {
  const previewRef = useRef<HTMLVideoElement>(null)
  const previewStreamRef = useRef<MediaStream | null>(null)

  // Live webcam preview
  useEffect(() => {
    let cancelled = false

    async function startPreview() {
      // Stop previous preview
      previewStreamRef.current?.getTracks().forEach((t) => t.stop())
      previewStreamRef.current = null

      if (!selectedCamera || !previewRef.current) return

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: selectedCamera } },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        previewStreamRef.current = stream
        previewRef.current.srcObject = stream
      } catch {
        // Camera unavailable
      }
    }

    startPreview()

    return () => {
      cancelled = true
      previewStreamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [selectedCamera])

  return (
    <div className="flex flex-col gap-6 rounded-xl border bg-card p-6 shadow-lg w-80">
      {/* Recording Mode */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          Recording Mode
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {RECORDING_MODES.map((m) => {
            const Icon = MODE_ICONS[m.icon as keyof typeof MODE_ICONS]
            return (
              <button
                key={m.id}
                onClick={() => onModeChange(m.id)}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                  mode === m.id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border hover:bg-accent'
                )}
              >
                <Icon className="h-4 w-4" />
                {m.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Camera Preview + Selector */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Camera</h3>
        {selectedCamera && (
          <div className="relative overflow-hidden rounded-lg bg-black aspect-video">
            <video
              ref={previewRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover mirror"
              style={{ transform: 'scaleX(-1)' }}
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <Select
            value={selectedCamera ?? 'none'}
            onValueChange={(v) => onCameraChange(v === 'none' ? null : v)}
          >
            <SelectTrigger className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                <span className="flex items-center gap-2">
                  <CameraOff className="h-4 w-4" />
                  No Camera
                </span>
              </SelectItem>
              {cameras.map((cam) => (
                <SelectItem key={cam.deviceId} value={cam.deviceId}>
                  <span className="flex items-center gap-2">
                    <Camera className="h-4 w-4" />
                    {cam.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Mic Selector + Level */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          Microphone
        </h3>
        <div className="flex items-center gap-2">
          <Select
            value={selectedMic ?? 'none'}
            onValueChange={(v) => onMicChange(v === 'none' ? null : v)}
          >
            <SelectTrigger className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                <span className="flex items-center gap-2">
                  <MicOff className="h-4 w-4" />
                  No Microphone
                </span>
              </SelectItem>
              {microphones.map((mic) => (
                <SelectItem key={mic.deviceId} value={mic.deviceId}>
                  <span className="flex items-center gap-2">
                    <Mic className="h-4 w-4" />
                    {mic.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <AudioLevelMeter deviceId={selectedMic} />
      </div>

      {/* Start Button */}
      <Button
        size="lg"
        onClick={onStart}
        disabled={disabled}
        className="w-full bg-red-500 hover:bg-red-600 text-white"
      >
        Start Recording
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        5 min recording limit
      </p>
    </div>
  )
}
