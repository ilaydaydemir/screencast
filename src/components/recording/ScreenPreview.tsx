'use client'

import type { RefObject } from 'react'

interface ScreenPreviewProps {
  canvasRef: RefObject<HTMLCanvasElement | null>
  screenVideoRef: RefObject<HTMLVideoElement | null>
  webcamVideoRef: RefObject<HTMLVideoElement | null>
  isActive: boolean
}

export function ScreenPreview({
  canvasRef,
  screenVideoRef,
  webcamVideoRef,
  isActive,
}: ScreenPreviewProps) {
  return (
    <div className="relative w-full overflow-hidden rounded-lg bg-black">
      {/* Hidden video elements used as sources for canvas drawing */}
      <video
        ref={screenVideoRef}
        autoPlay
        playsInline
        muted
        className="hidden"
      />
      <video
        ref={webcamVideoRef}
        autoPlay
        playsInline
        muted
        className="hidden"
      />
      {/* The visible canvas */}
      <canvas
        ref={canvasRef}
        className={`w-full ${isActive ? 'aspect-video' : 'aspect-video bg-muted'}`}
      />
      {!isActive && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <p className="text-lg">Select a recording mode and click Start</p>
        </div>
      )}
    </div>
  )
}
