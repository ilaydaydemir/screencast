'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { Undo2, Trash2 } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

type DrawTool = 'pen' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'eraser'

interface FreeStroke {
  tool: 'pen' | 'eraser'
  color: string
  size: number
  points: { x: number; y: number }[]
}

interface ShapeStroke {
  tool: 'arrow' | 'rectangle' | 'ellipse'
  color: string
  size: number
  x1: number; y1: number; x2: number; y2: number
}

interface TextStroke {
  tool: 'text'
  color: string
  size: number
  x: number; y: number
  text: string
}

type Stroke = FreeStroke | ShapeStroke | TextStroke

export interface Segment { id: number; start: number; end: number; text: string }

// ── Return type of useAnnotationEditor ───────────────────────────────────────

export interface AnnotationEditorState {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  strokes: Stroke[]
  strokesRef: React.MutableRefObject<Stroke[]>
  tool: DrawTool
  setTool: (t: DrawTool) => void
  color: string
  setColor: (c: string) => void
  size: number
  setSize: (s: number) => void
  cursor: string
  onMouseDown: (e: React.MouseEvent<HTMLCanvasElement>) => void
  onMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => void
  onMouseUp: () => void
  undo: () => void
  clearAll: () => void
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COLORS = [
  { label: 'Red',    value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green',  value: '#22c55e' },
  { label: 'Blue',   value: '#3b82f6' },
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
    id: 'rectangle',
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
    id: 'eraser',
    label: 'Eraser',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
        <path d="M20 20H7L3 16l11-11 6 6-5.5 5.5" /><line x1="6" y1="21" x2="21" y2="21" />
      </svg>
    ),
  },
]

// ── Drawing helpers ───────────────────────────────────────────────────────────

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

function redrawAll(ctx: CanvasRenderingContext2D, strokes: Stroke[]) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  for (const s of strokes) {
    ctx.save()
    if (s.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
      ctx.lineWidth = s.size * 3
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (let i = 0; i < s.points.length; i++) {
        if (i === 0) ctx.moveTo(s.points[i].x, s.points[i].y)
        else ctx.lineTo(s.points[i].x, s.points[i].y)
      }
      ctx.stroke()
    } else if (s.tool === 'pen') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.size
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (let i = 0; i < s.points.length; i++) {
        if (i === 0) ctx.moveTo(s.points[i].x, s.points[i].y)
        else ctx.lineTo(s.points[i].x, s.points[i].y)
      }
      ctx.stroke()
    } else if (s.tool === 'arrow') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color
      ctx.fillStyle = s.color
      ctx.lineWidth = s.size
      ctx.lineCap = 'round'
      drawArrow(ctx, s.x1, s.y1, s.x2, s.y2, s.size)
    } else if (s.tool === 'rectangle') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.size
      ctx.lineCap = 'square'
      ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1)
    } else if (s.tool === 'ellipse') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.size
      const cx = (s.x1 + s.x2) / 2
      const cy = (s.y1 + s.y2) / 2
      const rx = Math.abs(s.x2 - s.x1) / 2
      const ry = Math.abs(s.y2 - s.y1) / 2
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (s.tool === 'text') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = s.color
      ctx.font = `bold ${Math.max(14, s.size * 4)}px sans-serif`
      ctx.fillText(s.text, s.x, s.y)
    }
    ctx.restore()
  }
}

/** Draw subtitle at bottom of canvas, matching native app style */
function drawSubtitle(ctx: CanvasRenderingContext2D, text: string) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  const fontSize = Math.max(16, Math.round(h * 0.042))
  const padding = 12
  const bottomMargin = Math.round(h * 0.06)

  ctx.save()
  ctx.font = `bold ${fontSize}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'

  const metrics = ctx.measureText(text)
  const textW = metrics.width
  const textH = fontSize

  const bgX = (w - textW) / 2 - padding
  const bgY = h - bottomMargin - textH - padding
  const bgW = textW + padding * 2
  const bgH = textH + padding * 2

  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.beginPath()
  if (ctx.roundRect) {
    ctx.roundRect(bgX, bgY, bgW, bgH, 6)
  } else {
    ctx.rect(bgX, bgY, bgW, bgH)
  }
  ctx.fill()

  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, w / 2, h - bottomMargin)
  ctx.restore()
}

// ── useAnnotationEditor hook ──────────────────────────────────────────────────

export function useAnnotationEditor(
  videoRef: React.RefObject<HTMLVideoElement | null>
): AnnotationEditorState {
  const canvasRef  = useRef<HTMLCanvasElement>(null)

  const [tool, setTool]       = useState<DrawTool>('pen')
  const [color, setColor]     = useState('#ef4444')
  const [size, setSize]       = useState(4)
  const [strokes, setStrokes] = useState<Stroke[]>([])

  const drawingRef  = useRef(false)
  const currentRef  = useRef<Stroke | null>(null)
  const strokesRef  = useRef<Stroke[]>([])
  const toolRef     = useRef<DrawTool>('pen')
  const colorRef    = useRef('#ef4444')
  const sizeRef     = useRef(4)

  useEffect(() => { strokesRef.current = strokes }, [strokes])
  useEffect(() => { toolRef.current    = tool    }, [tool])
  useEffect(() => { colorRef.current   = color   }, [color])
  useEffect(() => { sizeRef.current    = size    }, [size])

  // Resize canvas to match video rendered rect
  useEffect(() => {
    const canvas = canvasRef.current
    const video  = videoRef.current
    if (!canvas || !video) return
    const sync = () => {
      const rect = video.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
        canvas.width  = Math.round(rect.width)
        canvas.height = Math.round(rect.height)
        const ctx = canvas.getContext('2d')
        if (ctx) redrawAll(ctx, strokesRef.current)
      }
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(video)
    return () => ro.disconnect()
  }, [videoRef])

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const t  = toolRef.current
    const c  = colorRef.current
    const sz = sizeRef.current
    const pos = getPos(e)

    if (t === 'text') {
      const text = window.prompt('Enter annotation text:')
      if (!text) return
      const stroke: TextStroke = { tool: 'text', color: c, size: sz, x: pos.x, y: pos.y, text }
      const next = [...strokesRef.current, stroke]
      setStrokes(next)
      strokesRef.current = next
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx) redrawAll(ctx, next)
      return
    }

    drawingRef.current = true
    if (t === 'pen' || t === 'eraser') {
      currentRef.current = { tool: t, color: c, size: sz, points: [pos] }
    } else {
      currentRef.current = { tool: t as 'arrow' | 'rectangle' | 'ellipse', color: c, size: sz, x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y }
    }
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !currentRef.current) return
    const pos = getPos(e)
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx) return

    const s = currentRef.current
    if (s.tool === 'pen' || s.tool === 'eraser') {
      s.points.push(pos)
    } else {
      (s as ShapeStroke).x2 = pos.x;
      (s as ShapeStroke).y2 = pos.y
    }

    redrawAll(ctx, strokesRef.current)
    ctx.save()
    if (s.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
      ctx.lineWidth = s.size * 3
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (let i = 0; i < s.points.length; i++) {
        if (i === 0) ctx.moveTo(s.points[i].x, s.points[i].y)
        else ctx.lineTo(s.points[i].x, s.points[i].y)
      }
      ctx.stroke()
    } else if (s.tool === 'pen') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.size
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (let i = 0; i < s.points.length; i++) {
        if (i === 0) ctx.moveTo(s.points[i].x, s.points[i].y)
        else ctx.lineTo(s.points[i].x, s.points[i].y)
      }
      ctx.stroke()
    } else if (s.tool === 'arrow') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color
      ctx.fillStyle = s.color
      ctx.lineWidth = s.size
      ctx.lineCap = 'round'
      drawArrow(ctx, s.x1, s.y1, s.x2, s.y2, s.size)
    } else if (s.tool === 'rectangle') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.size
      ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1)
    } else if (s.tool === 'ellipse') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.size
      const cx = (s.x1 + s.x2) / 2
      const cy = (s.y1 + s.y2) / 2
      const rx = Math.abs(s.x2 - s.x1) / 2
      const ry = Math.abs(s.y2 - s.y1) / 2
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }, [])

  const onMouseUp = useCallback(() => {
    if (!drawingRef.current || !currentRef.current) return
    drawingRef.current = false
    const s = currentRef.current
    currentRef.current = null
    if ((s.tool === 'rectangle' || s.tool === 'ellipse' || s.tool === 'arrow') &&
        Math.abs(s.x2 - s.x1) < 3 && Math.abs(s.y2 - s.y1) < 3) return
    const next = [...strokesRef.current, s]
    setStrokes(next)
    strokesRef.current = next
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) redrawAll(ctx, next)
  }, [])

  const undo = useCallback(() => {
    const next = strokesRef.current.slice(0, -1)
    setStrokes(next)
    strokesRef.current = next
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) redrawAll(ctx, next)
  }, [])

  const clearAll = useCallback(() => {
    setStrokes([])
    strokesRef.current = []
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height)
  }, [])

  const cursor = tool === 'eraser' ? 'cell' : tool === 'text' ? 'text' : 'crosshair'

  return { canvasRef, strokes, strokesRef, tool, setTool, color, setColor, size, setSize, cursor, onMouseDown, onMouseMove, onMouseUp, undo, clearAll }
}

// ── AnnotationCanvas component ────────────────────────────────────────────────

interface AnnotationCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  videoWidth: number
  videoHeight: number
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  /** strokesRef from useAnnotationEditor, needed to redraw strokes under subtitle */
  strokesRef: React.MutableRefObject<Stroke[]>
  onMouseDown: (e: React.MouseEvent<HTMLCanvasElement>) => void
  onMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => void
  onMouseUp: () => void
  cursor: string
  /** Subtitle segments for live preview overlay during playback */
  segments?: Segment[]
  /** Current video time (seconds) */
  currentTime?: number
  /** Whether video is playing */
  playing?: boolean
}

export function AnnotationCanvas({
  canvasRef,
  strokesRef,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  cursor,
  segments = [],
  currentTime = 0,
  playing = false,
}: AnnotationCanvasProps) {
  // rAF subtitle overlay: draw subtitle on top of annotation strokes during playback
  const segmentsRef    = useRef<Segment[]>([])
  const currentTimeRef = useRef(0)
  const playingRef     = useRef(false)
  const lastSubRef     = useRef('')

  useEffect(() => { segmentsRef.current    = segments    }, [segments])
  useEffect(() => { currentTimeRef.current = currentTime }, [currentTime])
  useEffect(() => { playingRef.current     = playing     }, [playing])

  useEffect(() => {
    let rafId: number

    const loop = () => {
      rafId = requestAnimationFrame(loop)
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      if (!playingRef.current || segmentsRef.current.length === 0) {
        // If a subtitle was showing, remove it by redrawing strokes only
        if (lastSubRef.current !== '') {
          lastSubRef.current = ''
          redrawAll(ctx, strokesRef.current)
        }
        return
      }

      const t = currentTimeRef.current
      const seg = segmentsRef.current.find(s => t >= s.start && t <= s.end)
      const subText = seg ? seg.text.trim() : ''

      if (subText !== lastSubRef.current) {
        lastSubRef.current = subText
        // Redraw annotation strokes first (clears old subtitle), then overlay new subtitle
        redrawAll(ctx, strokesRef.current)
        if (subText) {
          drawSubtitle(ctx, subText)
        }
      }
    }

    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [canvasRef, strokesRef])

  return (
    <canvas
      ref={canvasRef}
      style={{ cursor, position: 'absolute', inset: 0, pointerEvents: 'all', zIndex: 10 }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    />
  )
}

// ── AnnotationToolbar component ───────────────────────────────────────────────

interface AnnotationToolbarProps {
  tool: DrawTool
  setTool: (t: DrawTool) => void
  color: string
  setColor: (c: string) => void
  size: number
  setSize: (s: number) => void
  strokeCount: number
  onUndo: () => void
  onClear: () => void
}

export function AnnotationToolbar({
  tool, setTool,
  color, setColor,
  size, setSize,
  strokeCount,
  onUndo, onClear,
}: AnnotationToolbarProps) {
  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-3 space-y-3">
      {/* Tool row */}
      <div className="flex items-center gap-1 flex-wrap">
        {TOOLS.map(t => (
          <button
            key={t.id}
            title={t.label}
            onClick={() => setTool(t.id)}
            className={`
              flex flex-col items-center gap-0.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors min-w-[52px]
              ${tool === t.id
                ? 'bg-primary text-primary-foreground shadow-md'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'}
            `}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}

        <div className="flex-1" />

        <button
          onClick={onUndo}
          disabled={strokeCount === 0}
          title="Undo last stroke"
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>

        <button
          onClick={onClear}
          disabled={strokeCount === 0}
          title="Clear all annotations"
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-red-400 hover:text-red-300 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clear
        </button>
      </div>

      {/* Color + size row */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
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

        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span
            className="inline-block h-4 w-4 rounded-sm border border-zinc-700"
            style={{ background: color }}
          />
          <span className="font-mono">{color}</span>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 w-14 text-right">Size: {size}px</span>
          <input
            type="range"
            min={2}
            max={20}
            value={size}
            onChange={e => setSize(Number(e.target.value))}
            className="w-24 accent-primary"
          />
          <span
            className="inline-block rounded-full"
            style={{
              width: Math.max(4, size),
              height: Math.max(4, size),
              background: color,
              flexShrink: 0,
            }}
          />
        </div>
      </div>

      {strokeCount === 0 && (
        <p className="text-xs text-zinc-600 text-center">
          Select a tool and draw directly on the video preview above
        </p>
      )}
      {strokeCount > 0 && (
        <p className="text-xs text-zinc-600 text-center">
          {strokeCount} annotation{strokeCount !== 1 ? 's' : ''} — use Undo or Clear to remove
        </p>
      )}
    </div>
  )
}
