'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Trash2, ArrowLeft, Share2, Check, Download, Scissors, RotateCcw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { SubtitleGenerator } from '@/components/subtitles/SubtitleGenerator'
import { SocialExport } from '@/components/export/SocialExport'
import { Comments } from '@/components/watch/Comments'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDate, formatFileSize, formatDuration } from '@/lib/format'
import type { Database } from '@/lib/supabase/types'

type Recording = Database['public']['Tables']['recordings']['Row']
type Tab = 'edit' | 'subtitles' | 'export' | 'comments'
interface Segment { id: number; start: number; end: number; text: string }
interface CutRange { start: number; end: number }

export default function RecordingDetailPage() {
  const [recording, setRecording] = useState<Recording | null>(null)
  const [loading, setLoading]     = useState(true)
  const [title, setTitle]         = useState('')
  const [tab, setTab]             = useState<Tab>('edit')
  const [segments, setSegments]   = useState<Segment[]>([])
  const [copied, setCopied]       = useState(false)

  // Player state
  const [playing, setPlaying]     = useState(false)
  const [currentTime, setCurrent] = useState(0)
  const [duration, setDuration]   = useState(0)
  const [trimIn, setTrimIn]       = useState(0)
  const [trimOut, setTrimOut]     = useState(0)
  const [cuts, setCuts]           = useState<CutRange[]>([])
  const [speed, setSpeed]         = useState(1)
  const videoRef  = useRef<HTMLVideoElement>(null)
  const tlRef     = useRef<HTMLDivElement>(null)

  const router  = useRouter()
  const params  = useParams()
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('recordings')
        .select('*')
        .eq('id', params.id as string)
        .single()
      if (data) { setRecording(data); setTitle(data.title) }
      setLoading(false)
    }
    load()
  }, [params.id]) // eslint-disable-line

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
    const onMeta  = () => {
      if (!isFinite(v.duration) || v.duration < 0.1) {
        // webm from MediaRecorder has no duration header — force Chrome to scan
        const onDurationFix = () => {
          setDuration(v.duration)
          setTrimOut(v.duration)
          v.currentTime = 0
          v.removeEventListener('seeked', onDurationFix)
        }
        v.addEventListener('seeked', onDurationFix)
        v.currentTime = 1e101
      } else {
        setDuration(v.duration)
        setTrimOut(v.duration)
      }
    }
    const onTime  = () => setCurrent(v.currentTime)
    const onPlay  = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnd   = () => { setPlaying(false); v.currentTime = trimIn }
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
  }, [videoUrl, trimIn])

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed
  }, [speed])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (playing) { v.pause() } else { v.play() }
  }

  const seek = (t: number) => {
    if (videoRef.current) videoRef.current.currentTime = t
    setCurrent(t)
  }

  const saveTitle = async () => {
    if (!recording || title === recording.title) return
    await supabase.from('recordings').update({ title }).eq('id', recording.id)
    setRecording(prev => prev ? { ...prev, title } : prev)
  }

  const handleDelete = async () => {
    if (!recording) return
    if (!confirm('Delete this recording? This cannot be undone.')) return
    const paths = [recording.storage_path, recording.thumbnail_path].filter(Boolean) as string[]
    if (paths.length) await supabase.storage.from('recordings').remove(paths)
    await supabase.from('recordings').delete().eq('id', recording.id)
    router.push('/dashboard')
  }

  const copyShare = () => {
    const url = `${window.location.origin}/watch/${recording?.share_id}`
    navigator.clipboard.writeText(url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // ── Timeline click ────────────────────────────────────────
  const onTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return
    const rect = tlRef.current!.getBoundingClientRect()
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    seek(pct * duration)
  }, [duration])

  // ── Mark cut at current position ──────────────────────────
  const markCut = () => {
    const t = currentTime
    const len = Math.min(5, duration - t)
    if (len < 0.5) return
    setCuts(prev => [...prev, { start: t, end: t + len }])
  }

  const removeCut = (i: number) => setCuts(prev => prev.filter((_, idx) => idx !== i))

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  )
  if (!recording) return (
    <div className="text-center py-24 text-muted-foreground">Recording not found</div>
  )

  const TABS: { id: Tab; label: string }[] = [
    { id: 'edit',      label: 'Edit' },
    { id: 'subtitles', label: 'Subtitles' },
    { id: 'export',    label: 'Export' },
    { id: 'comments',  label: 'Comments' },
  ]

  return (
    <div className="mx-auto max-w-5xl pb-16">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-4">
        <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard')}>
          <ArrowLeft className="mr-2 h-4 w-4" />Library
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={copyShare}>
            {copied ? <Check className="mr-1.5 h-3.5 w-3.5 text-green-500" /> : <Share2 className="mr-1.5 h-3.5 w-3.5" />}
            {copied ? 'Copied!' : 'Share link'}
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Editor layout ─────────────────────────────────── */}
      <div className="rounded-2xl overflow-hidden border border-border bg-zinc-950">

        {/* Video canvas area */}
        <div className="relative bg-black flex items-center justify-center" style={{ minHeight: 400 }}>
          <video
            ref={videoRef}
            crossOrigin="anonymous"
            className="max-h-[460px] w-full object-contain"
            playsInline
            onClick={togglePlay}
            style={{ cursor: 'pointer' }}
          />
          {!playing && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="rounded-full bg-black/50 p-5">
                <svg className="h-10 w-10 text-white fill-white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </div>
            </div>
          )}
        </div>

        {/* Timeline */}
        <div className="px-4 pt-3 pb-1">
          <div
            ref={tlRef}
            onClick={onTimelineClick}
            className="relative h-8 rounded-md bg-zinc-800 cursor-pointer overflow-hidden"
          >
            {/* Played region */}
            <div
              className="absolute inset-y-0 left-0 bg-primary/30"
              style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
            />
            {/* Cut regions */}
            {cuts.map((c, i) => (
              <div
                key={i}
                className="absolute inset-y-0 bg-red-500/50"
                style={{
                  left: `${(c.start / duration) * 100}%`,
                  width: `${((c.end - c.start) / duration) * 100}%`,
                }}
              />
            ))}
            {/* Trim in/out */}
            <div className="absolute inset-y-0 left-0 w-1 bg-green-400 rounded-l-md"
              style={{ left: `${(trimIn / duration) * 100}%` }} />
            <div className="absolute inset-y-0 w-1 bg-green-400 rounded-r-md"
              style={{ left: `${(trimOut / duration) * 100}%` }} />
            {/* Playhead */}
            <div
              className="absolute inset-y-0 w-0.5 bg-white"
              style={{ left: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
            />
          </div>
        </div>

        {/* Controls bar */}
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Play/pause */}
          <button
            onClick={togglePlay}
            className="flex items-center justify-center h-9 w-9 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            {playing
              ? <svg className="h-4 w-4 fill-white" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              : <svg className="h-4 w-4 fill-white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            }
          </button>

          {/* Time */}
          <span className="font-mono text-xs text-zinc-400 min-w-[90px]">
            {formatDuration(Math.floor(currentTime))} / {formatDuration(Math.floor(duration))}
          </span>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Speed */}
          <select
            value={speed}
            onChange={e => setSpeed(Number(e.target.value))}
            className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700"
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>

          {/* Mark cut */}
          <button
            onClick={markCut}
            title="Mark 5s cut at playhead"
            className="flex items-center gap-1.5 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <Scissors className="h-3.5 w-3.5" /> Cut
          </button>

          {/* Reset cuts */}
          {cuts.length > 0 && (
            <button
              onClick={() => setCuts([])}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 transition-colors"
            >
              <RotateCcw className="h-3 w-3" /> Clear {cuts.length} cut{cuts.length > 1 ? 's' : ''}
            </button>
          )}

          {/* Download */}
          {videoUrl && (
            <a
              href={videoUrl}
              download
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              <Download className="h-3.5 w-3.5" /> Download
            </a>
          )}
        </div>
      </div>

      {/* Title + meta */}
      <div className="mt-4 space-y-2">
        <Input
          value={title}
          onChange={e => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={e => e.key === 'Enter' && saveTitle()}
          className="text-base font-medium"
          placeholder="Recording title"
        />
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground px-1">
          <span>⏱ {formatDuration(recording.duration)}</span>
          <span>💾 {formatFileSize(recording.file_size)}</span>
          <span>📅 {formatDate(recording.created_at)}</span>
          <span>👁 {recording.view_count} views</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-5 border-b border-border">
        <div className="flex gap-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
                ${tab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="mt-5">
        {tab === 'edit' && (
          <div className="space-y-3">
            {cuts.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-4 space-y-2">
                <h3 className="text-sm font-semibold">Cut segments</h3>
                {cuts.map((c, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm">
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatDuration(Math.floor(c.start))} → {formatDuration(Math.floor(c.end))}
                    </span>
                    <button onClick={() => removeCut(i)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                  </div>
                ))}
              </div>
            )}
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-muted/40 px-4 py-3">
                  <div className="text-xs text-muted-foreground mb-1">Duration</div>
                  <div className="font-medium">{formatDuration(recording.duration)}</div>
                </div>
                <div className="rounded-lg bg-muted/40 px-4 py-3">
                  <div className="text-xs text-muted-foreground mb-1">File size</div>
                  <div className="font-medium">{formatFileSize(recording.file_size)}</div>
                </div>
                <div className="rounded-lg bg-muted/40 px-4 py-3">
                  <div className="text-xs text-muted-foreground mb-1">Format</div>
                  <div className="font-medium">{recording.mime_type}</div>
                </div>
                <div className="rounded-lg bg-muted/40 px-4 py-3">
                  <div className="text-xs text-muted-foreground mb-1">Created</div>
                  <div className="font-medium">{formatDate(recording.created_at)}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'subtitles' && videoUrl && (
          <SubtitleGenerator
            videoUrl={videoUrl}
            title={recording.title}
            videoRef={videoRef}
            recordingId={recording.id}
            savedSrt={recording.subtitle_srt}
            onSegmentsChange={setSegments}
          />
        )}

        {tab === 'export' && videoUrl && (
          <SocialExport
            videoUrl={videoUrl}
            title={recording.title}
            segments={segments}
          />
        )}

        {tab === 'comments' && recording.share_id && (
          <div className="rounded-xl border border-border bg-card p-4">
            <Comments shareId={recording.share_id} recordingId={recording.id} />
          </div>
        )}
      </div>
    </div>
  )
}
