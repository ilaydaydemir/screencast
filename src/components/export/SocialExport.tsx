'use client'

import { useState } from 'react'

const PRESETS = [
  { id: 'tiktok',    label: 'TikTok',      emoji: '🎵', w: 1080, h: 1920, ratio: '9:16', note: 'Vertical' },
  { id: 'instagram', label: 'Instagram',   emoji: '📸', w: 1080, h: 1080, ratio: '1:1',  note: 'Square'   },
  { id: 'linkedin',  label: 'LinkedIn',    emoji: '💼', w: 1920, h: 1080, ratio: '16:9', note: 'Landscape' },
  { id: 'twitter',   label: 'X / Twitter', emoji: '𝕏',  w: 1280, h: 720,  ratio: '16:9', note: 'Landscape' },
  { id: 'youtube',   label: 'YouTube',     emoji: '▶',  w: 1920, h: 1080, ratio: '16:9', note: 'Landscape' },
] as const

type Preset = typeof PRESETS[number]
type ExportState =
  | { phase: 'idle' }
  | { phase: 'encoding'; preset: string; progress: number; duration: number }
  | { phase: 'done'; preset: string }
  | { phase: 'error'; message: string }

export function SocialExport({ videoUrl, title, segments = [] }: { videoUrl: string; title: string; segments?: Array<{ id: number; start: number; end: number; text: string }> }) {
  const [state, setState] = useState<ExportState>({ phase: 'idle' })

  async function run(preset: Preset) {
    setState({ phase: 'encoding', preset: preset.id, progress: 0, duration: 0 })

    try {
      // ── 1. Load video ──────────────────────────────────────
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.src = videoUrl
      video.muted = true
      video.preload = 'auto'

      await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res()
        video.onerror = () => rej(new Error('Could not load video. CORS may be blocking it.'))
        setTimeout(() => rej(new Error('Video load timeout')), 15_000)
      })

      const srcW = video.videoWidth  || 1920
      const srcH = video.videoHeight || 1080
      const dur  = video.duration

      setState(s => s.phase === 'encoding' ? { ...s, duration: Math.round(dur) } : s)

      // ── 2. Canvas setup ────────────────────────────────────
      // Scale down for performance (max 1080 on longest side)
      const maxSide = 1080
      const factor  = Math.min(1, maxSide / Math.max(preset.w, preset.h))
      const cW = Math.round(preset.w * factor)
      const cH = Math.round(preset.h * factor)

      const canvas = document.createElement('canvas')
      canvas.width  = cW
      canvas.height = cH
      const ctx = canvas.getContext('2d')!

      // Fit video inside canvas (letterbox)
      const fitScale = Math.min(cW / srcW, cH / srcH)
      const drawW  = srcW * fitScale
      const drawH  = srcH * fitScale
      const drawX  = (cW - drawW) / 2
      const drawY  = (cH - drawH) / 2
      const hasBars = drawW < cW - 4 || drawH < cH - 4

      // ── 3. MediaRecorder ───────────────────────────────────
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'

      const stream = canvas.captureStream(30)
      const mr     = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
      const chunks: Blob[] = []
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
      mr.start(200)

      // ── 4. Render loop ─────────────────────────────────────
      video.currentTime = 0
      await new Promise<void>(r => { video.onseeked = () => r() })
      video.play()

      await new Promise<void>(resolve => {
        let raf: number
        const tick = () => {
          // Background
          if (hasBars) {
            // Blurred & scaled version fills the frame
            ctx.save()
            ctx.filter = 'blur(24px) brightness(0.5)'
            const bgS  = Math.max(cW / srcW, cH / srcH) * 1.15
            const bgW  = srcW * bgS, bgH = srcH * bgS
            ctx.drawImage(video, (cW - bgW) / 2, (cH - bgH) / 2, bgW, bgH)
            ctx.restore()
          } else {
            ctx.fillStyle = '#000'
            ctx.fillRect(0, 0, cW, cH)
          }
          // Main video
          ctx.drawImage(video, drawX, drawY, drawW, drawH)

          // Draw subtitle if segments provided
          if (segments.length > 0) {
            const t = video.currentTime
            const seg = segments.find(s => t >= s.start && t <= s.end)
            if (seg) {
              const fontSize = Math.round(cH * 0.045)
              ctx.font = `bold ${fontSize}px sans-serif`
              ctx.textAlign = 'center'
              const maxW = cW * 0.85
              const words = seg.text.split(' ')
              const lines: string[] = []
              let cur = ''
              for (const w of words) {
                const test = cur ? `${cur} ${w}` : w
                if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w }
                else cur = test
              }
              if (cur) lines.push(cur)
              const lh = fontSize * 1.35
              const totalH = lines.length * lh
              const baseY = cH * 0.88
              lines.forEach((line, i) => {
                const y = baseY - totalH + i * lh
                ctx.fillStyle = 'rgba(0,0,0,0.7)'
                const tw = ctx.measureText(line).width
                ctx.fillRect(cW / 2 - tw / 2 - 8, y - fontSize, tw + 16, fontSize + 6)
                ctx.fillStyle = '#ffffff'
                ctx.fillText(line, cW / 2, y)
              })
            }
          }

          const pct = Math.min(99, Math.round((video.currentTime / dur) * 100))
          setState(s => s.phase === 'encoding' ? { ...s, progress: pct } : s)

          if (!video.ended && video.currentTime < dur - 0.05) {
            raf = requestAnimationFrame(tick)
          } else {
            cancelAnimationFrame(raf)
            resolve()
          }
        }
        raf = requestAnimationFrame(tick)
        video.onended = () => { cancelAnimationFrame(raf); resolve() }
      })

      video.pause()
      mr.stop()
      await new Promise<void>(r => { mr.onstop = () => r() })

      // ── 5. Download ────────────────────────────────────────
      const blob = new Blob(chunks, { type: mimeType })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `${title.slice(0, 40)}-${preset.label.toLowerCase().replace(/[^a-z0-9]/g, '-')}.webm`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 10_000)

      setState({ phase: 'done', preset: preset.id })
      setTimeout(() => setState({ phase: 'idle' }), 3000)
    } catch (e: unknown) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : 'Export failed' })
      setTimeout(() => setState({ phase: 'idle' }), 5000)
    }
  }

  const busy = state.phase === 'encoding'

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <h2 className="mb-1 text-sm font-semibold">Export for Social Media</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Converts your video to the right size — vertical bars get a blurred background fill.
      </p>

      <div className="grid grid-cols-5 gap-2">
        {PRESETS.map(p => {
          const isThis  = state.phase === 'encoding' && state.preset === p.id
          const isDone  = state.phase === 'done'     && state.preset === p.id
          return (
            <button
              key={p.id}
              onClick={() => run(p)}
              disabled={busy}
              className={`
                flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center
                transition-all text-xs font-medium
                ${busy && !isThis ? 'cursor-not-allowed opacity-40 border-border' : ''}
                ${isThis  ? 'border-red-500 bg-red-500/10 text-red-400' : ''}
                ${isDone  ? 'border-green-500 bg-green-500/10 text-green-400' : ''}
                ${!busy && !isDone ? 'border-border hover:border-muted-foreground/60 hover:bg-muted/40 text-foreground' : ''}
              `}
            >
              <span className="text-xl">{p.emoji}</span>
              <span className="font-semibold">{p.label}</span>
              <span className="text-[10px] text-muted-foreground">{p.ratio}</span>
              {isThis && (
                <span className="text-[10px] text-red-400">{state.phase === 'encoding' ? `${state.progress}%` : ''}</span>
              )}
              {isDone && <span className="text-[10px]">✓ Done</span>}
            </button>
          )
        })}
      </div>

      {segments.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">✓ Subtitles will be burned into exported video</p>
      )}

      {/* Encoding progress bar */}
      {state.phase === 'encoding' && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Encoding for {PRESETS.find(p => p.id === state.preset)?.label}
              {state.duration > 0 && ` · ${fmtSec(state.duration)} video`}
            </span>
            <span>{state.progress}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-red-500 transition-all duration-200"
              style={{ width: `${state.progress}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Encoding happens in real-time in your browser — keep this tab open.
          </p>
        </div>
      )}

      {state.phase === 'error' && (
        <p className="mt-3 text-xs text-destructive">{state.message}</p>
      )}
    </div>
  )
}

function fmtSec(s: number) {
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}
