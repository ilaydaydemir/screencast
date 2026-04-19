'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatDuration } from '@/lib/format'
import type { Database } from '@/lib/supabase/types'

type Recording = Database['public']['Tables']['recordings']['Row']
interface CutRange { start: number; end: number }

export default function CutEditorPage() {
  const [recording, setRecording] = useState<Recording | null>(null)
  const [loading, setLoading]     = useState(true)
  const [cuts, setCuts]           = useState<CutRange[]>([])
  const [currentTime, setCurrent] = useState(0)
  const [duration, setDuration]   = useState(0)
  const [playing, setPlaying]     = useState(false)
  const [dragging, setDragging]   = useState<{ start: number } | null>(null)
  const [pendingEnd, setPendingEnd] = useState<number | null>(null)

  const videoRef  = useRef<HTMLVideoElement>(null)
  const tlRef     = useRef<HTMLDivElement>(null)

  const router   = useRouter()
  const params   = useParams()
  const supabase = createClient()

  const id = params.id as string

  // ── Load recording ───────────────────────────────────────
  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('recordings')
        .select('*')
        .eq('id', id)
        .single()
      if (data) {
        setRecording(data)
        if (data.cuts && Array.isArray(data.cuts)) {
          setCuts(data.cuts as unknown as CutRange[])
        }
      }
      setLoading(false)
    }
    load()
  }, [id]) // eslint-disable-line

  const cleanPath = (p: string | null | undefined) =>
    p?.startsWith('recordings/') ? p.slice('recordings/'.length) : (p ?? '')

  const videoUrl = recording?.storage_path
    ? supabase.storage.from('recordings').getPublicUrl(cleanPath(recording.storage_path)).data.publicUrl
    : null

  // ── Video events ─────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoUrl) return
    v.src = videoUrl
    const onMeta = () => {
      if (!isFinite(v.duration) || v.duration < 0.1) {
        const onSeeked = () => {
          setDuration(v.duration)
          v.currentTime = 0
          v.removeEventListener('seeked', onSeeked)
        }
        v.addEventListener('seeked', onSeeked)
        v.currentTime = 1e101
      } else {
        setDuration(v.duration)
      }
    }
    const onTime  = () => setCurrent(v.currentTime)
    const onPlay  = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnd   = () => { setPlaying(false); v.currentTime = 0 }
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

  // ── Cut-skip during playback ──────────────────────────────
  const cutsRef = useRef<CutRange[]>([])
  useEffect(() => { cutsRef.current = cuts }, [cuts])
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => {
      for (const cut of cutsRef.current) {
        if (v.currentTime >= cut.start && v.currentTime < cut.end) {
          v.currentTime = cut.end
          break
        }
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (playing) { v.pause() } else { v.play() }
  }

  // ── Timeline helpers ──────────────────────────────────────
  const timelineToTime = (e: React.MouseEvent, rect: DOMRect) =>
    Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration))

  const finalizeDrag = (endTime: number) => {
    if (!dragging) return
    const start = Math.min(dragging.start, endTime)
    const end   = Math.max(dragging.start, endTime)
    if (end - start >= 0.5) {
      setCuts(prev => [...prev, { start, end }])
    }
    setDragging(null)
    setPendingEnd(null)
  }

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration || !tlRef.current) return
    e.preventDefault()
    const t = timelineToTime(e, tlRef.current.getBoundingClientRect())
    setDragging({ start: t })
    setPendingEnd(t)
  }

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging || !tlRef.current) return
    const t = timelineToTime(e, tlRef.current.getBoundingClientRect())
    setPendingEnd(t)
  }

  const onMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging || !tlRef.current) return
    const t = timelineToTime(e, tlRef.current.getBoundingClientRect())
    finalizeDrag(t)
  }

  const onMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging || !tlRef.current) return
    const t = timelineToTime(e, tlRef.current.getBoundingClientRect())
    finalizeDrag(t)
  }

  const removeCut = (i: number) => setCuts(prev => prev.filter((_, idx) => idx !== i))

  // ── Save ──────────────────────────────────────────────────
  const save = async () => {
    if (!recording) return
    await supabase.from('recordings').update({ cuts } as never).eq('id', recording.id)
    router.push(`/dashboard/recordings/${recording.id}`)
  }

  // ── Pending drag overlay values ───────────────────────────
  const pendingRegion = dragging && pendingEnd !== null ? {
    start: Math.min(dragging.start, pendingEnd),
    end:   Math.max(dragging.start, pendingEnd),
  } : null

  // ── Time markers every 10% ────────────────────────────────
  const markers = duration > 0
    ? Array.from({ length: 9 }, (_, i) => (i + 1) * 0.1)
    : []

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  )
  if (!recording) return (
    <div className="text-center py-24 text-muted-foreground">Recording not found</div>
  )

  return (
    <div className="mx-auto max-w-4xl pb-16">

      {/* Top bar */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => router.push(`/dashboard/recordings/${id}`)}
          className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <h1 className="text-sm font-semibold text-white truncate max-w-xs">
          Cut Editor — {recording.title}
        </h1>
        <button
          onClick={save}
          className="rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium px-4 py-2 transition-colors"
        >
          Save cuts
        </button>
      </div>

      {/* Video section */}
      <div className="rounded-2xl overflow-hidden bg-zinc-950 border border-zinc-800">
        <div className="relative bg-black flex items-center justify-center" style={{ minHeight: 360 }}>
          <video
            ref={videoRef}
            crossOrigin="anonymous"
            className="max-h-[400px] w-full object-contain"
            playsInline
          />
          {/* Play overlay */}
          {!playing && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="rounded-full bg-black/50 p-5">
                <svg className="h-10 w-10 text-white fill-white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </div>
            </div>
          )}
        </div>

        {/* Play + time */}
        <div className="flex items-center gap-3 px-4 pt-3 pb-1">
          <button
            onClick={togglePlay}
            className="flex items-center justify-center h-9 w-9 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            {playing
              ? <svg className="h-4 w-4 fill-white" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              : <svg className="h-4 w-4 fill-white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            }
          </button>
          <span className="font-mono text-xs text-zinc-400 min-w-[90px]">
            {formatDuration(Math.floor(currentTime))} / {formatDuration(Math.floor(duration))}
          </span>
        </div>

        {/* Timeline */}
        <div className="px-4 pb-4 pt-2">
          <div
            ref={tlRef}
            className="relative h-16 rounded-lg bg-zinc-800 cursor-crosshair overflow-hidden select-none"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
          >
            {/* Time markers every 10% */}
            {markers.map(pct => (
              <div
                key={pct}
                className="absolute inset-y-0 w-px bg-zinc-600/50"
                style={{ left: `${pct * 100}%` }}
              />
            ))}

            {/* Saved cut regions (red) */}
            {cuts.map((c, i) => (
              duration > 0 && (
                <div
                  key={i}
                  className="absolute inset-y-0 bg-red-500/50"
                  style={{
                    left:  `${(c.start / duration) * 100}%`,
                    width: `${((c.end - c.start) / duration) * 100}%`,
                  }}
                />
              )
            ))}

            {/* In-progress drag region (orange) */}
            {pendingRegion && duration > 0 && (
              <div
                className="absolute inset-y-0 bg-orange-400/40"
                style={{
                  left:  `${(pendingRegion.start / duration) * 100}%`,
                  width: `${((pendingRegion.end - pendingRegion.start) / duration) * 100}%`,
                }}
              />
            )}

            {/* Playhead */}
            <div
              className="absolute inset-y-0 w-0.5 bg-white pointer-events-none"
              style={{ left: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
            />
          </div>
          <p className="mt-2 text-xs text-zinc-500">Drag to select regions to remove</p>
        </div>
      </div>

      {/* Cut list */}
      <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
        <h3 className="text-sm font-semibold text-white mb-3">Cut regions</h3>
        {cuts.length === 0 ? (
          <p className="text-xs text-zinc-500">No cuts yet — drag on the timeline to mark regions to remove</p>
        ) : (
          cuts.map((c, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg bg-zinc-800/60 px-3 py-2 text-sm">
              <span className="font-mono text-xs text-zinc-300">
                {formatDuration(Math.floor(c.start))} → {formatDuration(Math.floor(c.end))}
              </span>
              <button
                onClick={() => removeCut(i)}
                className="text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
