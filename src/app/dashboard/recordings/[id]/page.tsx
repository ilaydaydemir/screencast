'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Trash2, ArrowLeft, Share2, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { VideoPlayer } from '@/components/playback/VideoPlayer'
import { SubtitleGenerator } from '@/components/subtitles/SubtitleGenerator'
import { SocialExport } from '@/components/export/SocialExport'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDate, formatFileSize, formatDuration } from '@/lib/format'
import type { Database } from '@/lib/supabase/types'

type Recording = Database['public']['Tables']['recordings']['Row']
type Tab = 'edit' | 'subtitles' | 'export'

interface Segment { id: number; start: number; end: number; text: string }

export default function RecordingDetailPage() {
  const [recording, setRecording] = useState<Recording | null>(null)
  const [loading, setLoading]     = useState(true)
  const [title, setTitle]         = useState('')
  const [tab, setTab]             = useState<Tab>('edit')
  const [segments, setSegments]   = useState<Segment[]>([])
  const [copied, setCopied]       = useState(false)
  const [videoUrl, setVideoUrl]   = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const router   = useRouter()
  const params   = useParams()
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('recordings')
        .select('*')
        .eq('id', params.id as string)
        .single()
      if (data) {
        setRecording(data)
        setTitle(data.title)
        if (data.storage_path) {
          const { data: signed } = await supabase.storage
            .from('recordings')
            .createSignedUrl(data.storage_path, 3600)
          if (signed) setVideoUrl(signed.signedUrl)
        }
      }
      setLoading(false)
    }
    load()
  }, [params.id, supabase])

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
  ]

  return (
    <div className="mx-auto max-w-4xl space-y-5 pb-16">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Library
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={copyShare}>
            {copied ? <Check className="mr-2 h-3.5 w-3.5 text-green-500" /> : <Share2 className="mr-2 h-3.5 w-3.5" />}
            {copied ? 'Copied!' : 'Share link'}
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Video player */}
      {videoUrl && <VideoPlayer src={videoUrl} title={recording.title} videoRef={videoRef} />}

      {/* Editable title */}
      <Input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={e => e.key === 'Enter' && saveTitle()}
        className="text-base font-medium"
        placeholder="Recording title"
      />

      {/* Meta */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>⏱ {formatDuration(recording.duration)}</span>
        <span>💾 {formatFileSize(recording.file_size)}</span>
        <span>📅 {formatDate(recording.created_at)}</span>
        <span>👁 {recording.view_count} views</span>
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
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
      {tab === 'edit' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-semibold">Recording details</h2>
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
            {videoUrl && (
              <a
                href={videoUrl}
                download
                className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
              >
                ↓ Download original
              </a>
            )}
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
    </div>
  )
}
