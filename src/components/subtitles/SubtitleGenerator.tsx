'use client'

import { useState, useCallback, useRef } from 'react'

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
}: {
  videoUrl: string
  title: string
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [segments, setSegments] = useState<Segment[]>([])
  const editRef = useRef<Map<number, string>>(new Map())

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

      // Mix down to mono Float32Array
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
        language: null, // auto-detect
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
      editRef.current.clear()
      setPhase({ name: 'done' })
    } catch (e: unknown) {
      setPhase({
        name: 'error',
        message: e instanceof Error ? e.message : 'Transcription failed',
      })
    }
  }, [videoUrl])

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
    const lines = getFinalSegments()
      .map((s, i) =>
        `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}`
      )
      .join('\n\n')
    downloadText(lines, `${title.slice(0, 40)}.srt`, 'text/srt')
  }

  // ── TXT export ───────────────────────────────────────────
  const downloadTXT = () => {
    const text = getFinalSegments().map(s => s.text).join(' ')
    downloadText(text, `${title.slice(0, 40)}-transcript.txt`, 'text/plain')
  }

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
          <div className="flex gap-2">
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
            <button
              onClick={() => { setPhase({ name: 'idle' }); setSegments([]) }}
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
        <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
          {segments.map(s => (
            <div
              key={s.id}
              className="flex gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm hover:border-muted-foreground/30 transition-colors"
            >
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground pt-0.5 w-20">
                {fmtTime(s.start)} →
              </span>
              <div
                contentEditable
                suppressContentEditableWarning
                onBlur={e => onEdit(s.id, e.currentTarget.textContent ?? s.text)}
                className="flex-1 outline-none leading-snug"
              >
                {s.text}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div
        className="h-full bg-primary rounded-full transition-all duration-300"
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

function downloadText(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
