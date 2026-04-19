'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

interface Segment {
  id: number
  start: number
  end: number
  text: string
}

type Phase =
  | { name: 'idle' }
  | { name: 'loading-model'; progress: number }
  | { name: 'extracting' }
  | { name: 'transcribing'; progress: number }
  | { name: 'done' }
  | { name: 'exporting'; progress: number }
  | { name: 'error'; message: string }

// Singleton pipeline — loaded once, reused
let _pipe: unknown = null

async function getWhisper(onProgress: (p: number) => void) {
  if (_pipe) return _pipe as Awaited<ReturnType<typeof loadPipe>>
  _pipe = await loadPipe(onProgress)
  return _pipe as Awaited<ReturnType<typeof loadPipe>>
}

async function loadPipe(onProgress: (p: number) => void) {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowLocalModels = false

  return pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
    dtype: 'q8',
    progress_callback: (p: { progress?: number }) => {
      if (p.progress != null) onProgress(Math.round(p.progress))
    },
  } as Parameters<typeof pipeline>[2])
}

export function SubtitleGenerator({
  videoUrl,
  title,
  videoRef,
  onSegmentsChange,
  recordingId,
  savedSrt,
}: {
  videoUrl: string
  title: string
  videoRef?: React.RefObject<HTMLVideoElement | null>
  onSegmentsChange?: (segs: Segment[]) => void
  recordingId?: string
  savedSrt?: string | null
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [segments, setSegments] = useState<Segment[]>([])
  const [cuts, setCuts] = useState<Set<number>>(new Set())
  const editRef = useRef<Map<number, string>>(new Map())

  useEffect(() => {
    if (!savedSrt) return
    const parsed = parseSRT(savedSrt)
    setSegments(parsed)
    setPhase({ name: 'done' })
    onSegmentsChange?.(parsed)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSrt])

  const generate = useCallback(async () => {
    try {
      // ── 1. Load model ────────────────────────────────────
      setPhase({ name: 'loading-model', progress: 0 })
      const whisper = await getWhisper(p =>
        setPhase({ name: 'loading-model', progress: p })
      )

      // ── 2. Fetch video → decode audio at 16 kHz ──────────
      setPhase({ name: 'extracting' })
      const res = await fetch(videoUrl, { credentials: 'omit' })
      if (!res.ok) throw new Error('Could not fetch video for transcription')
      const buf = await res.arrayBuffer()
      const ctx = new AudioContext({ sampleRate: 16_000 })
      const decoded = await ctx.decodeAudioData(buf)
      await ctx.close()

      const ch0 = decoded.getChannelData(0)
      const ch1 = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : null
      const audio = ch1
        ? Float32Array.from(ch0, (v, i) => (v + ch1[i]) / 2)
        : ch0

      // ── 3. Transcribe ────────────────────────────────────
      setPhase({ name: 'transcribing', progress: 0 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (whisper as any)(audio, {
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
        task: 'transcribe',
        language: null,
      })

      const chunks = ((result as Record<string, unknown>)?.chunks ?? []) as Array<{
        timestamp: [number, number | null]
        text: string
      }>

      const segs: Segment[] = chunks
        .filter(c => c.text.trim())
        .map((c, i) => ({
          id: i,
          start: c.timestamp[0] ?? 0,
          end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 3,
          text: c.text.trim(),
        }))

      setSegments(segs)
      onSegmentsChange?.(segs)
      setCuts(new Set())
      editRef.current.clear()
      setPhase({ name: 'done' })
    } catch (e: unknown) {
      setPhase({
        name: 'error',
        message: e instanceof Error ? e.message : 'Transcription failed',
      })
    }
  }, [videoUrl])

  // ── Seek on click ─────────────────────────────────────────
  const seekTo = (start: number) => {
    if (!videoRef?.current) return
    videoRef.current.currentTime = start
    videoRef.current.play().catch(() => {})
  }

  // ── Toggle cut ────────────────────────────────────────────
  const toggleCut = (id: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setCuts(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Edit handler ─────────────────────────────────────────
  const onEdit = (id: number, text: string) => {
    editRef.current.set(id, text)
  }

  // ── Merge edits into segments ────────────────────────────
  const getFinalSegments = () =>
    segments.map(s => ({
      ...s,
      text: editRef.current.has(s.id) ? editRef.current.get(s.id)! : s.text,
    }))

  // ── SRT export ───────────────────────────────────────────
  const downloadSRT = () => {
    const kept = getFinalSegments().filter(s => !cuts.has(s.id))
    const lines = kept
      .map((s, i) =>
        `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}`
      )
      .join('\n\n')
    downloadText(lines, `${title.slice(0, 40)}.srt`, 'text/srt')
  }

  // ── Save to DB ───────────────────────────────────────────
  const saveToDB = async () => {
    if (!recordingId) return
    const supabase = createClient()
    const kept = getFinalSegments().filter(s => !cuts.has(s.id))
    const lines = kept.map((s, i) =>
      `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}`
    ).join('\n\n')
    await supabase.from('recordings').update({ subtitle_srt: lines }).eq('id', recordingId)
  }

  // ── TXT export ───────────────────────────────────────────
  const downloadTXT = () => {
    const text = getFinalSegments()
      .filter(s => !cuts.has(s.id))
      .map(s => s.text)
      .join(' ')
    downloadText(text, `${title.slice(0, 40)}-transcript.txt`, 'text/plain')
  }

  // ── Export video without cut segments ────────────────────
  const exportWithoutCuts = useCallback(async () => {
    if (segments.length === 0) return

    const final = getFinalSegments()
    const cutRanges = final
      .filter(s => cuts.has(s.id))
      .map(s => ({ start: s.start, end: s.end }))
      .sort((a, b) => a.start - b.start)

    if (cutRanges.length === 0) return

    setPhase({ name: 'exporting', progress: 0 })

    try {
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.src = videoUrl
      video.muted = false
      video.preload = 'auto'

      await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res()
        video.onerror = () => rej(new Error('Could not load video'))
        setTimeout(() => rej(new Error('Video load timeout')), 15_000)
      })

      const dur = video.duration
      const canvas = document.createElement('canvas')
      canvas.width  = video.videoWidth  || 1280
      canvas.height = video.videoHeight || 720
      const ctx = canvas.getContext('2d')!

      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'

      const stream = canvas.captureStream(30)
      const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
      const chunks: Blob[] = []
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
      mr.start(200)

      // Build keep ranges (inverse of cuts, clamped to [0, dur])
      const keepRanges: Array<{ start: number; end: number }> = []
      let cursor = 0
      for (const cut of cutRanges) {
        if (cursor < cut.start) keepRanges.push({ start: cursor, end: cut.start })
        cursor = cut.end
      }
      if (cursor < dur) keepRanges.push({ start: cursor, end: dur })

      // Play through keep ranges
      for (const range of keepRanges) {
        video.currentTime = range.start
        await new Promise<void>(r => { video.onseeked = () => r() })
        video.play()

        await new Promise<void>(resolve => {
          let raf: number
          const tick = () => {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            const overall = keepRanges.reduce((acc, r, i) => {
              if (i < keepRanges.indexOf(range)) return acc + (r.end - r.start)
              if (i === keepRanges.indexOf(range)) return acc + (video.currentTime - range.start)
              return acc
            }, 0)
            const totalKeep = keepRanges.reduce((a, r) => a + (r.end - r.start), 0)
            setPhase({ name: 'exporting', progress: Math.round((overall / totalKeep) * 100) })

            if (video.currentTime >= range.end - 0.05 || video.ended) {
              video.pause()
              cancelAnimationFrame(raf)
              resolve()
            } else {
              raf = requestAnimationFrame(tick)
            }
          }
          raf = requestAnimationFrame(tick)
        })
      }

      mr.stop()
      await new Promise<void>(r => { mr.onstop = () => r() })

      const blob = new Blob(chunks, { type: mimeType })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `${title.slice(0, 40)}-edited.webm`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 10_000)

      setPhase({ name: 'done' })
    } catch (e: unknown) {
      setPhase({
        name: 'error',
        message: e instanceof Error ? e.message : 'Export failed',
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, cuts, videoUrl, title])

  const cutCount = cuts.size

  return (
    <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Auto Subtitles</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Runs in your browser — free, no API key
          </p>
        </div>
        {phase.name === 'idle' && (
          <button
            onClick={generate}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Generate Subtitles
          </button>
        )}
        {phase.name === 'done' && segments.length > 0 && (
          <div className="flex gap-2 flex-wrap justify-end">
            {cutCount > 0 && (
              <button
                onClick={exportWithoutCuts}
                className="rounded-lg border border-orange-500 bg-orange-500/10 px-3 py-1.5 text-xs font-semibold text-orange-500 hover:bg-orange-500/20 transition-colors"
              >
                ✂ Export ({cutCount} cut{cutCount > 1 ? 's' : ''})
              </button>
            )}
            <button
              onClick={downloadSRT}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted transition-colors"
            >
              ↓ .srt
            </button>
            <button
              onClick={downloadTXT}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted transition-colors"
            >
              ↓ .txt
            </button>
            {recordingId && (
              <button
                onClick={saveToDB}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted transition-colors"
              >
                Save subtitles
              </button>
            )}
            <button
              onClick={() => { setPhase({ name: 'idle' }); setSegments([]); setCuts(new Set()) }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted transition-colors"
            >
              Redo
            </button>
          </div>
        )}
      </div>

      {/* Loading model */}
      {phase.name === 'loading-model' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Downloading Whisper model ({phase.progress}%) — only happens once, cached after
          </p>
          <ProgressBar value={phase.progress} />
        </div>
      )}

      {/* Extracting audio */}
      {phase.name === 'extracting' && (
        <p className="text-xs text-muted-foreground animate-pulse">
          Extracting audio…
        </p>
      )}

      {/* Transcribing */}
      {phase.name === 'transcribing' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Transcribing — this takes roughly the same time as your recording length
          </p>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary rounded-full animate-pulse w-full" />
          </div>
        </div>
      )}

      {/* Exporting */}
      {phase.name === 'exporting' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Exporting edited video… keep this tab open
          </p>
          <ProgressBar value={phase.progress} color="bg-orange-500" />
        </div>
      )}

      {/* Error */}
      {phase.name === 'error' && (
        <div className="space-y-2">
          <p className="text-xs text-destructive">{phase.message}</p>
          <button
            onClick={() => setPhase({ name: 'idle' })}
            className="text-xs text-muted-foreground underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Segments — editable */}
      {phase.name === 'done' && segments.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No speech detected. Try a recording with more audio.
        </p>
      )}

      {segments.length > 0 && (
        <>
          {cutCount > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {cutCount} segment{cutCount > 1 ? 's' : ''} marked for removal. Click ✂ again to restore.
            </p>
          )}
          <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {segments.map(s => {
              const isCut = cuts.has(s.id)
              return (
                <div
                  key={s.id}
                  onClick={() => seekTo(s.start)}
                  className={`group flex gap-3 rounded-lg border px-3 py-2 text-sm cursor-pointer transition-colors
                    ${isCut
                      ? 'border-red-500/40 bg-red-500/10 opacity-60'
                      : 'border-border bg-muted/30 hover:border-muted-foreground/30'
                    }`}
                >
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground pt-0.5 w-20">
                    {fmtTime(s.start)} →
                  </span>
                  <div
                    contentEditable
                    suppressContentEditableWarning
                    onClick={e => e.stopPropagation()}
                    onBlur={e => onEdit(s.id, e.currentTarget.textContent ?? s.text)}
                    className={`flex-1 outline-none leading-snug ${isCut ? 'line-through text-muted-foreground' : ''}`}
                  >
                    {s.text}
                  </div>
                  <button
                    onClick={e => toggleCut(s.id, e)}
                    title={isCut ? 'Restore segment' : 'Cut this segment'}
                    className={`shrink-0 opacity-0 group-hover:opacity-100 rounded px-1.5 py-0.5 text-[11px] font-medium transition-all
                      ${isCut
                        ? 'opacity-100 text-red-400 hover:bg-red-500/20'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                  >
                    {isCut ? '↩' : '✂'}
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────

function ProgressBar({ value, color = 'bg-primary' }: { value: number; color?: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div
        className={`h-full ${color} rounded-full transition-all duration-300`}
        style={{ width: `${value}%` }}
      />
    </div>
  )
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(1).padStart(4, '0')
  return `${m}:${sec}`
}

function srtTime(s: number) {
  const h   = Math.floor(s / 3600)
  const m   = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const ms  = Math.round((s % 1) * 1000)
  return `${pad(h)}:${pad(m)}:${pad(sec)},${String(ms).padStart(3, '0')}`
}

function pad(n: number) { return String(n).padStart(2, '0') }

function parseSRT(srt: string): Segment[] {
  const blocks = srt.trim().split(/\n\n+/)
  return blocks.flatMap((block, i) => {
    const lines = block.trim().split('\n')
    if (lines.length < 3) return []
    const times = lines[1].match(/(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)/)
    if (!times) return []
    const toSec = (h: string, m: string, s: string, ms: string) =>
      Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
    return [{
      id: i,
      start: toSec(times[1], times[2], times[3], times[4]),
      end:   toSec(times[5], times[6], times[7], times[8]),
      text:  lines.slice(2).join(' '),
    }]
  })
}

function downloadText(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
