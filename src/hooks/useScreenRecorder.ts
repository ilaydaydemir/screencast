'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type { RecordingMode } from '@/lib/constants'
import {
  SUPPORTED_MIME_TYPES,
  VIDEO_FRAME_RATE,
  VIDEO_BITS_PER_SECOND,
  MAX_RECORDING_DURATION_SECONDS,
} from '@/lib/constants'

export type RecordingState =
  | 'idle'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'stopped'

interface RecordingOptions {
  mode: RecordingMode
  cameraDeviceId: string | null
  micDeviceId: string | null
}

interface WebcamPosition {
  x: number
  y: number
}

interface UseScreenRecorderReturn {
  state: RecordingState
  error: string | null
  elapsedSeconds: number
  blob: Blob | null
  previewUrl: string | null
  startRecording: (options: RecordingOptions) => Promise<void>
  pauseRecording: () => void
  resumeRecording: () => void
  stopRecording: () => void
  discardRecording: () => void
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  screenVideoRef: React.RefObject<HTMLVideoElement | null>
  webcamVideoRef: React.RefObject<HTMLVideoElement | null>
  webcamPosition: WebcamPosition
  setWebcamPosition: (pos: WebcamPosition) => void
  webcamSize: number
  setWebcamSize: (size: number) => void
  webcamVisible: boolean
  setWebcamVisible: (visible: boolean) => void
}

function getSupportedMimeType(): string {
  for (const mimeType of SUPPORTED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType
    }
  }
  return 'video/webm'
}

export function useScreenRecorder(): UseScreenRecorderReturn {
  const [state, setState] = useState<RecordingState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [webcamPosition, setWebcamPosition] = useState<WebcamPosition>({ x: 20, y: 20 })
  const [webcamSize, setWebcamSize] = useState(150)
  const [webcamVisible, setWebcamVisible] = useState(true)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const screenVideoRef = useRef<HTMLVideoElement | null>(null)
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const webcamStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const rafIdRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const recordingModeRef = useRef<RecordingMode>('full-screen')

  // Refs for webcam overlay position (avoid stale closures in rAF)
  const webcamPosRef = useRef(webcamPosition)
  const webcamSizeRef = useRef(webcamSize)
  const webcamVisibleRef = useRef(webcamVisible)

  useEffect(() => { webcamPosRef.current = webcamPosition }, [webcamPosition])
  useEffect(() => { webcamSizeRef.current = webcamSize }, [webcamSize])
  useEffect(() => { webcamVisibleRef.current = webcamVisible }, [webcamVisible])

  const cleanup = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
    }
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((t) => t.stop())
      webcamStreamRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    mediaRecorderRef.current = null
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startRecording = useCallback(
    async (options: RecordingOptions) => {
      setError(null)
      recordingModeRef.current = options.mode

      try {
        // 1. Acquire screen stream (unless camera-only)
        let screenStream: MediaStream | null = null
        if (options.mode !== 'camera-only') {
          const displayMediaOptions: DisplayMediaStreamOptions = {
            video: {
              frameRate: VIDEO_FRAME_RATE,
            },
            audio: true,
          }

          // Hint the display surface type
          if (options.mode === 'full-screen') {
            (displayMediaOptions.video as MediaTrackConstraints).displaySurface = 'monitor'
          } else if (options.mode === 'window') {
            (displayMediaOptions.video as MediaTrackConstraints).displaySurface = 'window'
          } else if (options.mode === 'tab') {
            // @ts-expect-error preferCurrentTab is not in all TS defs yet
            displayMediaOptions.preferCurrentTab = true;
            (displayMediaOptions.video as MediaTrackConstraints).displaySurface = 'browser'
          }

          screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions)
          screenStreamRef.current = screenStream

          // Listen for user clicking browser's "Stop Sharing" button
          const videoTrack = screenStream.getVideoTracks()[0]
          if (videoTrack) {
            videoTrack.onended = () => {
              stopRecording()
            }
          }
        }

        // 2. Acquire webcam + mic stream
        let webcamStream: MediaStream | null = null
        const hasCamera = options.cameraDeviceId !== null
        const hasMic = options.micDeviceId !== null

        if (hasCamera || hasMic) {
          const constraints: MediaStreamConstraints = {}
          if (hasCamera) {
            constraints.video = {
              deviceId: { exact: options.cameraDeviceId! },
              width: { ideal: 640 },
              height: { ideal: 480 },
            }
          }
          if (hasMic) {
            constraints.audio = {
              deviceId: { exact: options.micDeviceId! },
            }
          }
          webcamStream = await navigator.mediaDevices.getUserMedia(constraints)
          webcamStreamRef.current = webcamStream
        }

        // 3. Set up video elements
        if (screenStream && screenVideoRef.current) {
          screenVideoRef.current.srcObject = screenStream
          await screenVideoRef.current.play()
        }
        if (webcamStream && webcamVideoRef.current && hasCamera) {
          webcamVideoRef.current.srcObject = webcamStream
          await webcamVideoRef.current.play()
        }

        // 4. Show countdown
        setState('countdown')

        // Wait for countdown (handled by component, we use a timeout here)
        await new Promise((resolve) => setTimeout(resolve, 3000))

        // 5. Set up canvas
        const canvas = canvasRef.current
        if (!canvas) throw new Error('Canvas not available')

        let canvasWidth = 1920
        let canvasHeight = 1080

        if (screenStream) {
          const videoTrack = screenStream.getVideoTracks()[0]
          const settings = videoTrack?.getSettings()
          if (settings?.width && settings?.height) {
            canvasWidth = settings.width
            canvasHeight = settings.height
          }
        } else if (webcamStream && hasCamera) {
          // Camera only mode
          canvasWidth = 1280
          canvasHeight = 720
        }

        canvas.width = canvasWidth
        canvas.height = canvasHeight
        const ctx = canvas.getContext('2d')!

        // 6. Start rAF compositing loop
        const drawFrame = () => {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, canvasWidth, canvasHeight)

          // Draw screen
          if (screenVideoRef.current && screenStream) {
            ctx.drawImage(
              screenVideoRef.current,
              0,
              0,
              canvasWidth,
              canvasHeight
            )
          }

          // Draw webcam bubble or full frame
          if (webcamVideoRef.current && hasCamera) {
            if (options.mode === 'camera-only') {
              // Full frame
              ctx.drawImage(
                webcamVideoRef.current,
                0,
                0,
                canvasWidth,
                canvasHeight
              )
            } else if (webcamVisibleRef.current) {
              // Circle bubble overlay
              const size = webcamSizeRef.current
              const pos = webcamPosRef.current
              const centerX = canvasWidth - pos.x - size / 2
              const centerY = canvasHeight - pos.y - size / 2

              ctx.save()
              ctx.beginPath()
              ctx.arc(centerX, centerY, size / 2, 0, Math.PI * 2)
              ctx.closePath()
              ctx.clip()
              ctx.drawImage(
                webcamVideoRef.current,
                centerX - size / 2,
                centerY - size / 2,
                size,
                size
              )
              ctx.restore()

              // Draw border ring
              ctx.beginPath()
              ctx.arc(centerX, centerY, size / 2, 0, Math.PI * 2)
              ctx.strokeStyle = '#fff'
              ctx.lineWidth = 3
              ctx.stroke()
            }
          }

          rafIdRef.current = requestAnimationFrame(drawFrame)
        }
        drawFrame()

        // 7. Create composite stream with mixed audio
        const canvasStream = canvas.captureStream(VIDEO_FRAME_RATE)
        const compositeStream = new MediaStream()

        // Add canvas video track
        canvasStream.getVideoTracks().forEach((t) => compositeStream.addTrack(t))

        // Mix audio tracks
        const audioContext = new AudioContext()
        audioContextRef.current = audioContext
        const destination = audioContext.createMediaStreamDestination()

        if (screenStream?.getAudioTracks().length) {
          const screenAudioSource = audioContext.createMediaStreamSource(
            new MediaStream(screenStream.getAudioTracks())
          )
          screenAudioSource.connect(destination)
        }

        if (webcamStream?.getAudioTracks().length) {
          const micAudioSource = audioContext.createMediaStreamSource(
            new MediaStream(webcamStream.getAudioTracks())
          )
          micAudioSource.connect(destination)
        }

        destination.stream
          .getAudioTracks()
          .forEach((t) => compositeStream.addTrack(t))

        // 8. Start MediaRecorder
        const mimeType = getSupportedMimeType()
        const mediaRecorder = new MediaRecorder(compositeStream, {
          mimeType,
          videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        })
        mediaRecorderRef.current = mediaRecorder
        chunksRef.current = []

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }

        mediaRecorder.onstop = () => {
          const recordedBlob = new Blob(chunksRef.current, {
            type: mimeType,
          })
          setBlob(recordedBlob)
          const url = URL.createObjectURL(recordedBlob)
          setPreviewUrl(url)
          cleanup()
          setState('stopped')
        }

        mediaRecorder.start(1000)

        // 9. Start timer
        setElapsedSeconds(0)
        timerRef.current = setInterval(() => {
          setElapsedSeconds((prev) => {
            if (prev + 1 >= MAX_RECORDING_DURATION_SECONDS) {
              stopRecording()
              return prev
            }
            return prev + 1
          })
        }, 1000)

        setState('recording')
      } catch (err) {
        cleanup()
        setState('idle')
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setError('Permission denied. Please allow screen/camera access.')
        } else {
          setError(err instanceof Error ? err.message : 'Failed to start recording')
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cleanup]
  )

  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      mediaRecorderRef.current.stop()
    }
  }, [])

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.pause()
      if (timerRef.current) clearInterval(timerRef.current)
      setState('paused')
    }
  }, [])

  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'paused') {
      mediaRecorderRef.current.resume()
      timerRef.current = setInterval(() => {
        setElapsedSeconds((prev) => {
          if (prev + 1 >= MAX_RECORDING_DURATION_SECONDS) {
            stopRecording()
            return prev
          }
          return prev + 1
        })
      }, 1000)
      setState('recording')
    }
  }, [stopRecording])

  const discardRecording = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setBlob(null)
    setPreviewUrl(null)
    setElapsedSeconds(0)
    setError(null)
    setState('idle')
  }, [previewUrl])

  return {
    state,
    error,
    elapsedSeconds,
    blob,
    previewUrl,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    discardRecording,
    canvasRef,
    screenVideoRef,
    webcamVideoRef,
    webcamPosition,
    setWebcamPosition,
    webcamSize,
    setWebcamSize,
    webcamVisible,
    setWebcamVisible,
  }
}
