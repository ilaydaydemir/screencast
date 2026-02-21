'use client'

import { useEffect, useRef, useState } from 'react'

interface AudioLevelMeterProps {
  deviceId: string | null
}

export function AudioLevelMeter({ deviceId }: AudioLevelMeterProps) {
  const [level, setLevel] = useState(0)
  const animationRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    if (!deviceId) {
      setLevel(0)
      return
    }

    let cancelled = false

    async function startMonitoring() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId! } },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream

        const audioContext = new AudioContext()
        contextRef.current = audioContext
        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)

        const dataArray = new Uint8Array(analyser.frequencyBinCount)

        const tick = () => {
          if (cancelled) return
          analyser.getByteFrequencyData(dataArray)
          const avg =
            dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length
          setLevel(Math.min(100, (avg / 128) * 100))
          animationRef.current = requestAnimationFrame(tick)
        }
        tick()
      } catch {
        // mic unavailable
      }
    }

    startMonitoring()

    return () => {
      cancelled = true
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      contextRef.current?.close()
    }
  }, [deviceId])

  return (
    <div className="flex items-center gap-1.5 h-4">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="w-1 rounded-full transition-all duration-75"
          style={{
            height: `${Math.max(4, (level / 100) * 16)}px`,
            backgroundColor:
              i < (level / 100) * 12
                ? i < 8
                  ? '#22c55e'
                  : i < 10
                    ? '#eab308'
                    : '#ef4444'
                : '#e5e7eb',
          }}
        />
      ))}
    </div>
  )
}
