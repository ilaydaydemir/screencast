'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Trash2, ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { VideoPlayer } from '@/components/playback/VideoPlayer'
import { ShareButton } from '@/components/playback/ShareButton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDate, formatFileSize, formatDuration } from '@/lib/format'
import type { Database } from '@/lib/supabase/types'

type Recording = Database['public']['Tables']['recordings']['Row']

export default function RecordingDetailPage() {
  const [recording, setRecording] = useState<Recording | null>(null)
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const router = useRouter()
  const params = useParams()
  const supabase = createClient()

  useEffect(() => {
    async function fetch() {
      const { data } = await supabase
        .from('recordings')
        .select('*')
        .eq('id', params.id as string)
        .single()

      if (data) {
        setRecording(data)
        setTitle(data.title)
      }
      setLoading(false)
    }
    fetch()
  }, [params.id, supabase])

  const handleTitleSave = async () => {
    if (!recording || title === recording.title) return
    await supabase
      .from('recordings')
      .update({ title })
      .eq('id', recording.id)
    setRecording((prev) => (prev ? { ...prev, title } : prev))
  }

  const handleDelete = async () => {
    if (!recording) return
    if (!confirm('Delete this recording? This cannot be undone.')) return

    const filesToDelete = [recording.storage_path, recording.thumbnail_path].filter(
      Boolean
    ) as string[]
    if (filesToDelete.length > 0) {
      await supabase.storage.from('recordings').remove(filesToDelete)
    }
    await supabase.from('recordings').delete().eq('id', recording.id)
    router.push('/dashboard')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!recording) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">Recording not found</p>
      </div>
    )
  }

  const videoUrl = recording.storage_path
    ? supabase.storage
        .from('recordings')
        .getPublicUrl(recording.storage_path).data.publicUrl
    : null

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard')}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Recordings
      </Button>

      {videoUrl && <VideoPlayer src={videoUrl} title={recording.title} />}

      <div className="flex items-center gap-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleSave}
          onKeyDown={(e) => e.key === 'Enter' && handleTitleSave()}
          className="text-lg font-medium"
        />
        <ShareButton shareId={recording.share_id} />
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
      </div>

      <div className="flex gap-6 text-sm text-muted-foreground">
        <span>Duration: {formatDuration(recording.duration)}</span>
        <span>Size: {formatFileSize(recording.file_size)}</span>
        <span>Created: {formatDate(recording.created_at)}</span>
        <span>Views: {recording.view_count}</span>
      </div>
    </div>
  )
}
