'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Undo2, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatDuration } from '@/lib/format'
import type { Database } from '@/lib/supabase/types'

type Recording = Database['public']['Tables']['recordings']['Row']

interface Annotation {
  id: string
  tool: 'pen' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'blur' | 'eraser'
  color: string
  size: number
  startTime: number
  endTime: number
  points?: { x: number; y: number }[]
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  text?: string
}

type DrawTool = Annotation['tool']

// ── Constants ──────────────────────────────────────────────────────────────────

const COLORS = [
  { label: 'Red',    value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green',  value: '#22c55e' },
  { label: 'Blue',   value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'White',  value: '#ffffff' },
  { label: 'Black',  value: '#000000' },
]

const TOOLS: { id: DrawTool; label: string; icon: React.ReactNode }[] = [
  {
    id: 'pen',
    label: 'Pen',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
        <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
  },
  {
    id: 'arrow',
    label: 'Arrow',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
        <line x1="5" y1="19" x2="19" y2="5" /><polyline points="9 5 19 5 19 15" />
      </svg>
    ),
  },
  {
    id: 'rect',
    label: 'Rect',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      </svg>
    ),
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
        <ellipse cx="12" cy="12" rx="10" ry="6" />
      </svg>
    ),
  },
  {
    id: 'text',
    label: 'Text',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
        <polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    ),
  },
  {
    id: 'blur',
    label: 'Blur',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
        <circle cx="12" cy="12" r="3" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2" strokeDasharray="3 3" />
      </svg>
    ),
  },
  {
    id: 'eraser',
    label: 'Eraser',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
        <path d="M20 20H7L3 16l11-11 6 6-5.5 5.5" /><line x1="6" y1="21" x2="21" y2="21" />
      </svg>
    ),
  },
]

// ── Drawing helpers ────────────────────────────────────────────────────────────

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  size: number,
) {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const headLen = Math.max(12, size * 4)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: Annotation,
  videoEl: HTMLVideoElement | null,
) {
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'

  if (ann.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.strokeStyle = 'rgba(0,0,0,1)'
    ctx.lineWidth = ann.size * 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (ann.points && ann.points.length > 0) {
      ctx.beginPath()
      ann.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y))
      ctx.stroke()
    }
  } else if (ann.tool === 'pen') {
    ctx.strokeStyle = ann.color
    ctx.lineWidth = ann.size
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (ann.points && ann.points.length > 0) {
      ctx.beginPath()
      ann.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y))
      ctx.stroke()
    }
  } else if (ann.tool === 'arrow') {
    ctx.strokeStyle = ann.color
    ctx.fillStyle = ann.color
    ctx.lineWidth = ann.size
    ctx.lineCap = 'round'
    if (ann.x1 !== undefined && ann.y1 !== undefined && ann.x2 !== undefined && ann.y2 !== undefined) {
      drawArrow(ctx, ann.x1, ann.y1, ann.x2, ann.y2, ann.size)
    }
  } else if (ann.tool === 'rect') {
    ctx.strokeStyle = ann.color
    ctx.lineWidth = ann.size
    ctx.lineCap = 'square'
    if (ann.x1 !== undefined && ann.y1 !== undefined && ann.x2 !== undefined && ann.y2 !== undefined) {
      ctx.strokeRect(ann.x1, ann.y1, ann.x2 - ann.x1, ann.y2 - ann.y1)
    }
  } else if (ann.tool === 'ellipse') {
    ctx.strokeStyle = ann.color
    ctx.lineWidth = ann.size
    if (ann.x1 !== undefined && ann.y1 !== undefined && ann.x2 !== undefined && ann.y2 !== undefined) {
      const cx = (ann.x1 + ann.x2) / 2
      const cy = (ann.y1 + ann.y2) / 2
      const rx = Math.abs(ann.x2 - ann.x1) / 2
      const ry = Math.abs(ann.y2 - ann.y1) / 2
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
  } else if (ann.tool === 'text') {
    ctx.fillStyle = ann.color
    ctx.font = `bold ${Math.max(14, ann.size * 4)}px sans-serif`
    if (ann.text && ann.x1 !== undefined && ann.y1 !== undefined) {
      ctx.fillText(ann.text, ann.x1, ann.y1)
    }
  } else if (ann.tool === 'blur') {
    if (
      videoEl &&
      ann.x1 !== undefined && ann.y1 !== undefined &&
      ann.x2 !== undefined && ann.y2 !== undefined
    ) {
      const x = Math.min(ann.x1, ann.x2)
      const y = Math.min(ann.y1, ann.y2)
      const w = Math.abs(ann.x2 - ann.x1)
      const h = Math.abs(ann.y2 - ann.y1)
      if (w > 2 && h > 2) {
        ctx.filter = 'blur(12px)'
        ctx.drawImage(videoEl, x, y, w, h, x, y, w, h)
        ctx.filter = 'none'
      }
    }
  }

  ctx.restore()
}

function redrawCanvas(
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  currentTime: number,
  videoEl: HTMLVideoElement | null,
  activeAnnotation: Partial<Annotation> | null,
) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)

  // Draw visible annotations for current time
  for (const ann of annotations) {
    if (currentTime >= ann.startTime && currentTime <= ann.endTime) {
      drawAnnotation(ctx, ann, videoEl)
    }
  }

  // Draw active in-progress stroke on top
  if (activeAnnotation && activeAnnotation.tool) {
    drawAnnotation(ctx, activeAnnotation as Annotation, videoEl)
  }
}

// ── cleanPath helper ───────────────────────────────────────────────────────────

function cleanPath(p: string | null | undefined): string {
  return p?.startsWith('recordings/') ? p.slice('recordings/'.length) : (p ?? '')
}

// ── Page component ─────────────────────────────────────────────────────────────

export default function AnnotatePage() {
  const router = useRouter()
  const params = useParams()
  const id = params.id as string

  const [recording, setRecording] = useState<Recording | null>(null)
  const [loading, setLoading] = useState(true)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [saving, setSaving] = useState(false)

  // Video state
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  // Tool state
  const [tool, setTool] = useState<DrawTool>('pen')
  const [color, setColor] = useState('#ef4444')
  const [size, setSize] = useState(4)
  const [annotationDuration, setAnnotationDuration] = useState(5)

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tlRef = useRef<HTMLDivElement>(null)
  const drawingRef = useRef(false)
  const activeRef = useRef<Partial<Annotation> | null>(null)
  const annotationsRef = useRef<Annotation[]>([])
  const currentTimeRef = useRef(0)
  const toolRef = useRef<DrawTool>('pen')
  const colorRef = useRef('#ef4444')
  const sizeRef = useRef(4)
  const annotationDurationRef = useRef(5)
  const rafRef = useRef<number | null>(null)

  // Keep refs in sync
  useEffect(() => { annotationsRef.current = annotations }, [annotations])
  useEffect(() => { currentTimeRef.current = currentTime }, [currentTime])
  useEffect(() => { toolRef.current = tool }, [tool])
  useEffect(() => { colorRef.current = color }, [color])
  useEffect(() => { sizeRef.current = size }, [size])
  useEffect(() => { annotationDurationRef.current = annotationDuration }, [annotationDuration])

  // Load recording
  useEffect(() => {
    const supabase = createClient()
    async function load() {
      const { data } = await supabase
        .from('recordings')
        .select('*')
        .eq('id', id)
        .single()
      if (data) {
        setRecording(data)
        if (data.annotations && Array.isArray(data.annotations)) {
          setAnnotations(data.annotations as unknown as Annotation[])
        }
      }
      setLoading(false)
    }
    load()
  }, [id])

  const supabase = createClient()
  const videoUrl = recording?.storage_path
    ? supabase.storage.from('recordings').getPublicUrl(cleanPath(recording.storage_path)).data.publicUrl
    : null

  // Video events
  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoUrl) return
    v.src = videoUrl
    const onMeta = () => {
      if (!isFinite(v.duration) || v.duration < 0.1) {
        const onDurationFix = () => {
          setDuration(v.duration)
          v.currentTime = 0
          v.removeEventListener('seeked', onDurationFix)
        }
        v.addEventListener('seeked', onDurationFix)
        v.currentTime = 1e101
      } else {
        setDuration(v.duration)
      }
    }
    const onTime = () => setCurrentTime(v.currentTime)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnd = () => { setPlaying(false); v.currentTime = 0 }
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('ended', onEnd)
    return () => {
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('ended', onEnd)
    }
  }, [videoUrl])

  // Canvas resize observer
  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const sync = () => {
      const rect = video.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
        canvas.width = Math.round(rect.width)
        canvas.height = Math.round(rect.height)
        const ctx = canvas.getContext('2d')
        if (ctx) redrawCanvas(ctx, annotationsRef.current, currentTimeRef.current, video, activeRef.current)
      }
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(video)
    return () => ro.disconnect()
  }, [videoUrl])

  // rAF loop — continuously redraw canvas to show/hide time-sensitive annotations
  useEffect(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop)
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas || !video) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      redrawCanvas(ctx, annotationsRef.current, currentTimeRef.current, video, activeRef.current)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // ── Drawing ──────────────────────────────────────────────────────────────────

  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const t = toolRef.current
    const c = colorRef.current
    const sz = sizeRef.current
    const ct = currentTimeRef.current
    const pos = getCanvasPos(e)

    // Pause video when drawing starts
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause()
    }

    if (t === 'text') {
      const text = window.prompt('Enter annotation text:')
      if (!text) return
      const ann: Annotation = {
        id: crypto.randomUUID(),
        tool: 'text',
        color: c,
        size: sz,
        startTime: ct,
        endTime: ct + annotationDurationRef.current,
        x1: pos.x,
        y1: pos.y,
        text,
      }
      const next = [...annotationsRef.current, ann]
      setAnnotations(next)
      annotationsRef.current = next
      return
    }

    drawingRef.current = true

    if (t === 'pen' || t === 'eraser') {
      activeRef.current = {
        id: crypto.randomUUID(),
        tool: t,
        color: c,
        size: sz,
        startTime: ct,
        endTime: ct + annotationDurationRef.current,
        points: [pos],
      }
    } else {
      // arrow, rect, ellipse, blur
      activeRef.current = {
        id: crypto.randomUUID(),
        tool: t,
        color: c,
        size: sz,
        startTime: ct,
        endTime: ct + annotationDurationRef.current,
        x1: pos.x,
        y1: pos.y,
        x2: pos.x,
        y2: pos.y,
      }
    }
  }, [getCanvasPos])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !activeRef.current) return
    const pos = getCanvasPos(e)
    const s = activeRef.current

    if (s.tool === 'pen' || s.tool === 'eraser') {
      if (s.points) s.points.push(pos)
    } else {
      s.x2 = pos.x
      s.y2 = pos.y
    }
    // rAF loop will redraw on next frame
  }, [getCanvasPos])

  const onMouseUp = useCallback(() => {
    if (!drawingRef.current || !activeRef.current) return
    drawingRef.current = false
    const s = activeRef.current
    activeRef.current = null

    // Discard tiny drag on shape tools
    if (
      (s.tool === 'rect' || s.tool === 'ellipse' || s.tool === 'arrow' || s.tool === 'blur') &&
      s.x1 !== undefined && s.y1 !== undefined && s.x2 !== undefined && s.y2 !== undefined &&
      Math.abs(s.x2 - s.x1) < 3 && Math.abs(s.y2 - s.y1) < 3
    ) return

    const ann = s as Annotation
    const next = [...annotationsRef.current, ann]
    setAnnotations(next)
    annotationsRef.current = next
  }, [])

  const undo = () => {
    const next = annotationsRef.current.slice(0, -1)
    setAnnotations(next)
    annotationsRef.current = next
  }

  const clearAll = () => {
    setAnnotations([])
    annotationsRef.current = []
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (playing) v.pause()
    else v.play()
  }

  const seek = (t: number) => {
    if (videoRef.current) videoRef.current.currentTime = t
    setCurrentTime(t)
  }

  const onTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration || !tlRef.current) return
    const rect = tlRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    seek(pct * duration)
  }, [duration])

  // ── Save ─────────────────────────────────────────────────────────────────────

  const save = async () => {
    if (!recording) return
    setSaving(true)
    const supabase = createClient()
    await supabase
      .from('recordings')
      .update({ annotations: annotations as unknown as Database['public']['Tables']['recordings']['Update']['annotations'] })
      .eq('id', recording.id)
    setSaving(false)
    router.push(`/dashboard/recordings/${recording.id}`)
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  )
  if (!recording) return (
    <div className="text-center py-24 text-muted-foreground">Recording not found</div>
  )

  const cursor = tool === 'eraser' ? 'cell' : tool === 'text' ? 'text' : 'crosshair'

  return (
    <div className="mx-auto max-w-5xl pb-16 text-white">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => router.push(`/dashboard/recordings/${id}`)}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <h1 className="text-sm font-medium text-zinc-300 truncate max-w-xs">
          Annotations — {recording.title}
        </h1>
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-60 px-4 py-2 text-sm font-medium transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Main area */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Left: Video + Canvas */}
        <div className="flex-1 min-w-0 space-y-2">
          {/* Video container */}
          <div className="relative bg-black rounded-xl overflow-hidden flex items-center justify-center" style={{ minHeight: 300 }}>
            <video
              ref={videoRef}
              crossOrigin="anonymous"
              className="max-h-[420px] w-full object-contain"
              playsInline
            />
            {/* Canvas overlay */}
            <canvas
              ref={canvasRef}
              style={{
                cursor,
                position: 'absolute',
                inset: 0,
                pointerEvents: 'all',
                zIndex: 10,
              }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
            />
          </div>

          {/* Play controls */}
          <div className="flex items-center gap-3 px-1">
            <button
              onClick={togglePlay}
              className="flex items-center justify-center h-8 w-8 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white transition-colors"
            >
              {playing
                ? <svg className="h-3.5 w-3.5 fill-white" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                : <svg className="h-3.5 w-3.5 fill-white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              }
            </button>
            <span className="font-mono text-xs text-zinc-400 min-w-[90px]">
              {formatDuration(Math.floor(currentTime))} / {formatDuration(Math.floor(duration))}
            </span>
          </div>

          {/* Timeline */}
          <div
            ref={tlRef}
            onClick={onTimelineClick}
            className="relative h-10 rounded-lg bg-zinc-800 cursor-pointer overflow-hidden"
          >
            {/* Annotation bars */}
            {annotations.map(ann => (
              <div
                key={ann.id}
                className="absolute top-1 bottom-1 rounded-sm opacity-70"
                style={{
                  backgroundColor: ann.tool === 'blur' ? '#94a3b8' : ann.color,
                  left: duration ? `${(ann.startTime / duration) * 100}%` : '0%',
                  width: duration ? `${Math.max(0.5, ((ann.endTime - ann.startTime) / duration) * 100)}%` : '4px',
                }}
              />
            ))}
            {/* Playhead */}
            <div
              className="absolute inset-y-0 w-0.5 bg-white z-10"
              style={{ left: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
            />
          </div>
        </div>

        {/* Right: Toolbar */}
        <div className="w-full lg:w-64 rounded-xl bg-zinc-900 border border-zinc-700 p-4 space-y-4 self-start">
          {/* Tools grid */}
          <div>
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Tool</p>
            <div className="grid grid-cols-2 gap-1">
              {TOOLS.map(t => (
                <button
                  key={t.id}
                  title={t.label}
                  onClick={() => setTool(t.id)}
                  className={`
                    flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors
                    ${tool === t.id
                      ? 'bg-primary text-primary-foreground shadow'
                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'}
                  `}
                >
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Color swatches */}
          <div>
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Color</p>
            <div className="flex flex-wrap gap-2">
              {COLORS.map(c => (
                <button
                  key={c.value}
                  title={c.label}
                  onClick={() => setColor(c.value)}
                  style={{ background: c.value }}
                  className={`
                    h-6 w-6 rounded-full transition-transform
                    ${color === c.value ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-900 scale-110' : 'hover:scale-110'}
                    ${c.value === '#ffffff' ? 'border border-zinc-600' : ''}
                  `}
                />
              ))}
            </div>
          </div>

          {/* Size slider */}
          <div>
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
              Size: {size}px
            </p>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={2}
                max={20}
                value={size}
                onChange={e => setSize(Number(e.target.value))}
                className="flex-1 accent-primary"
              />
              <span
                className="inline-block rounded-full flex-shrink-0"
                style={{
                  width: Math.max(4, size),
                  height: Math.max(4, size),
                  background: color,
                }}
              />
            </div>
          </div>

          {/* Timestamp controls */}
          {!drawingRef.current && (
            <div>
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Timing</p>
              <div className="space-y-2 text-xs text-zinc-400">
                <div className="flex items-center justify-between">
                  <span>Appears at</span>
                  <span className="font-mono text-zinc-200">{formatDuration(Math.floor(currentTime))}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="ann-duration">Duration (s)</label>
                  <input
                    id="ann-duration"
                    type="number"
                    min={1}
                    max={999}
                    value={annotationDuration}
                    onChange={e => setAnnotationDuration(Math.max(1, Number(e.target.value)))}
                    className="w-16 rounded bg-zinc-800 border border-zinc-600 px-2 py-1 text-zinc-200 text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Undo / Clear */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={undo}
              disabled={annotations.length === 0}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Undo
            </button>
            <button
              onClick={clearAll}
              disabled={annotations.length === 0}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs text-red-400 hover:text-red-300 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>

          {/* Annotation count hint */}
          <p className="text-xs text-zinc-600 text-center">
            {annotations.length === 0
              ? 'Draw on the video to add annotations'
              : `${annotations.length} annotation${annotations.length !== 1 ? 's' : ''}`}
          </p>
        </div>
      </div>
    </div>
  )
}
