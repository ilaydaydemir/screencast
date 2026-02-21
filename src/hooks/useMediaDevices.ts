'use client'

import { useState, useEffect, useCallback } from 'react'

interface MediaDeviceInfo {
  deviceId: string
  label: string
  kind: MediaDeviceKind
}

interface UseMediaDevicesReturn {
  cameras: MediaDeviceInfo[]
  microphones: MediaDeviceInfo[]
  selectedCamera: string | null
  selectedMic: string | null
  setSelectedCamera: (id: string | null) => void
  setSelectedMic: (id: string | null) => void
  permissionGranted: boolean
  requestPermissions: () => Promise<boolean>
}

export function useMediaDevices(): UseMediaDevicesReturn {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null)
  const [selectedMic, setSelectedMic] = useState<string | null>(null)
  const [permissionGranted, setPermissionGranted] = useState(false)

  const enumerateDevices = useCallback(async () => {
    if (typeof window === 'undefined' || !navigator.mediaDevices) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${d.deviceId.slice(0, 8)}`,
          kind: d.kind,
        }))
      const audioDevices = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          kind: d.kind,
        }))

      setCameras(videoDevices)
      setMicrophones(audioDevices)

      if (videoDevices.length > 0 && !selectedCamera) {
        setSelectedCamera(videoDevices[0].deviceId)
      }
      if (audioDevices.length > 0 && !selectedMic) {
        setSelectedMic(audioDevices[0].deviceId)
      }
    } catch {
      // Devices not available
    }
  }, [selectedCamera, selectedMic])

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined' || !navigator.mediaDevices) return false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      })
      // Stop all tracks immediately - we just needed the permission
      stream.getTracks().forEach((t) => t.stop())
      setPermissionGranted(true)
      await enumerateDevices()
      return true
    } catch {
      return false
    }
  }, [enumerateDevices])

  useEffect(() => {
    enumerateDevices()
  }, [enumerateDevices])

  useEffect(() => {
    navigator.mediaDevices?.addEventListener('devicechange', enumerateDevices)
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', enumerateDevices)
    }
  }, [enumerateDevices])

  return {
    cameras,
    microphones,
    selectedCamera,
    selectedMic,
    setSelectedCamera,
    setSelectedMic,
    permissionGranted,
    requestPermissions,
  }
}
