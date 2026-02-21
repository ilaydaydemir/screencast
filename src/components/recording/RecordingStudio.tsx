'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useScreenRecorder } from '@/hooks/useScreenRecorder'
import { useMediaDevices } from '@/hooks/useMediaDevices'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { SetupPanel } from './SetupPanel'
import { ScreenPreview } from './ScreenPreview'
import { RecordingControls } from './RecordingControls'
import { CountdownOverlay } from './CountdownOverlay'
import { Input } from '@/components/ui/input'
import { THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from '@/lib/constants'
import type { RecordingMode } from '@/lib/constants'

export function RecordingStudio() {
  const [mode, setMode] = useState<RecordingMode>('full-screen')
  const [title, setTitle] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)

  const {
    cameras,
    microphones,
    selectedCamera,
    selectedMic,
    setSelectedCamera,
    setSelectedMic,
    requestPermissions,
    permissionGranted,
  } = useMediaDevices()

  const recorder = useScreenRecorder()
  const { user } = useAuth()
  const router = useRouter()
  const supabase = createClient()

  const handleStart = useCallback(async () => {
    if (!permissionGranted) {
      const granted = await requestPermissions()
      if (!granted) return
    }

    await recorder.startRecording({
      mode,
      cameraDeviceId: selectedCamera,
      micDeviceId: selectedMic,
    })
  }, [mode, selectedCamera, selectedMic, recorder, permissionGranted, requestPermissions])

  const handleDownload = useCallback(() => {
    if (!recorder.blob) return
    const url = URL.createObjectURL(recorder.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title || 'recording'}.webm`
    a.click()
    URL.revokeObjectURL(url)
  }, [recorder.blob, title])

  const handleUpload = useCallback(async () => {
    if (!recorder.blob || !user) return
    setUploading(true)
    setUploadProgress(0)

    try {
      // 1. Generate thumbnail
      let thumbnailBlob: Blob | null = null
      if (recorder.previewUrl) {
        thumbnailBlob = await generateThumbnail(recorder.previewUrl)
      }

      // 2. Create recording metadata
      const { data: recording, error: insertError } = await supabase
        .from('recordings')
        .insert({
          user_id: user.id,
          title: title || 'Untitled Recording',
          duration: recorder.elapsedSeconds,
          file_size: recorder.blob.size,
          mime_type: recorder.blob.type || 'video/webm',
          recording_mode: mode === 'camera-only' ? 'camera_only' : 'screen',
          status: 'processing',
        })
        .select()
        .single()

      if (insertError || !recording) throw insertError || new Error('Failed to create recording')

      setUploadProgress(20)

      // 3. Upload video to Supabase Storage
      const videoPath = `${user.id}/${recording.id}.webm`
      const { error: uploadError } = await supabase.storage
        .from('recordings')
        .upload(videoPath, recorder.blob, {
          contentType: 'video/webm',
          upsert: false,
        })

      if (uploadError) throw uploadError
      setUploadProgress(70)

      // 4. Upload thumbnail
      let thumbnailPath: string | null = null
      if (thumbnailBlob) {
        thumbnailPath = `${user.id}/${recording.id}-thumb.png`
        await supabase.storage
          .from('recordings')
          .upload(thumbnailPath, thumbnailBlob, {
            contentType: 'image/png',
            upsert: false,
          })
      }
      setUploadProgress(85)

      // 5. Update recording with storage paths and mark as ready
      await supabase
        .from('recordings')
        .update({
          storage_path: videoPath,
          thumbnail_path: thumbnailPath,
          status: 'ready',
        })
        .eq('id', recording.id)

      setUploadProgress(100)

      // Navigate to dashboard
      router.push('/dashboard')
    } catch (err) {
      console.error('Upload failed:', err)
      alert('Upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }, [recorder.blob, recorder.previewUrl, recorder.elapsedSeconds, user, title, mode, supabase, router])

  const isActive =
    recorder.state === 'countdown' ||
    recorder.state === 'recording' ||
    recorder.state === 'paused'

  return (
    <div className="flex gap-6">
      {/* Main area */}
      <div className="flex-1 space-y-4">
        <ScreenPreview
          canvasRef={recorder.canvasRef}
          screenVideoRef={recorder.screenVideoRef}
          webcamVideoRef={recorder.webcamVideoRef}
          isActive={isActive || recorder.state === 'stopped'}
        />

        {/* Preview video after recording stops */}
        {recorder.state === 'stopped' && recorder.previewUrl && (
          <div className="space-y-3">
            <video
              src={recorder.previewUrl}
              controls
              className="w-full rounded-lg"
            />
            <Input
              placeholder="Recording title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            {uploading && (
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* Recording controls */}
        <RecordingControls
          state={recorder.state}
          elapsedSeconds={recorder.elapsedSeconds}
          onPause={recorder.pauseRecording}
          onResume={recorder.resumeRecording}
          onStop={recorder.stopRecording}
          onDownload={handleDownload}
          onUpload={handleUpload}
          onDiscard={recorder.discardRecording}
          uploading={uploading}
        />

        {recorder.error && (
          <p className="text-sm text-destructive">{recorder.error}</p>
        )}

        {/* Countdown overlay */}
        {recorder.state === 'countdown' && (
          <CountdownOverlay onComplete={() => {}} />
        )}
      </div>

      {/* Setup panel (shown before recording starts) */}
      {recorder.state === 'idle' && (
        <SetupPanel
          mode={mode}
          onModeChange={setMode}
          cameras={cameras}
          microphones={microphones}
          selectedCamera={selectedCamera}
          selectedMic={selectedMic}
          onCameraChange={setSelectedCamera}
          onMicChange={setSelectedMic}
          onStart={handleStart}
        />
      )}
    </div>
  )
}

async function generateThumbnail(videoUrl: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.src = videoUrl
    video.muted = true

    video.onloadeddata = () => {
      // Seek to 10% of the video
      video.currentTime = video.duration * 0.1
    }

    video.onseeked = () => {
      const canvas = document.createElement('canvas')
      canvas.width = THUMBNAIL_WIDTH
      canvas.height = THUMBNAIL_HEIGHT
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(null)
        return
      }
      ctx.drawImage(video, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
      canvas.toBlob(
        (blob) => {
          resolve(blob)
        },
        'image/png'
      )
    }

    video.onerror = () => resolve(null)

    // Timeout fallback
    setTimeout(() => resolve(null), 5000)
  })
}
