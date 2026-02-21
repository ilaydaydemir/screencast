import type { Metadata } from 'next'
import { createAdminClient } from '@/lib/supabase/admin'
import { formatDuration } from '@/lib/format'
import { WatchPlayer } from './WatchPlayer'

interface Props {
  params: Promise<{ shareId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { shareId } = await params

  try {
    const supabase = createAdminClient()
    const { data: recording } = await supabase
      .from('recordings')
      .select('title, duration, mime_type, storage_path, thumbnail_path')
      .eq('share_id', shareId)
      .eq('is_public', true)
      .eq('status', 'ready')
      .single()

    if (!recording) {
      return { title: 'Recording Not Found' }
    }

    const videoUrl = recording.storage_path
      ? supabase.storage
          .from('recordings')
          .getPublicUrl(recording.storage_path).data.publicUrl
      : undefined

    const thumbnailUrl = recording.thumbnail_path
      ? supabase.storage
          .from('recordings')
          .getPublicUrl(recording.thumbnail_path).data.publicUrl
      : undefined

    return {
      title: `${recording.title} | Screencast`,
      description: `Watch this ${formatDuration(recording.duration)} recording`,
      openGraph: {
        title: recording.title,
        type: 'video.other',
        ...(videoUrl && {
          videos: [{ url: videoUrl, type: recording.mime_type }],
        }),
        ...(thumbnailUrl && { images: [thumbnailUrl] }),
      },
    }
  } catch {
    return { title: 'Screencast' }
  }
}

export default async function WatchPage({ params }: Props) {
  const { shareId } = await params

  let recording: {
    title: string
    storage_path: string | null
    thumbnail_path: string | null
    duration: number
    view_count: number
    created_at: string
    id: string
  } | null = null

  try {
    const supabase = createAdminClient()
    const { data } = await supabase
      .from('recordings')
      .select('id, title, storage_path, thumbnail_path, duration, view_count, created_at')
      .eq('share_id', shareId)
      .eq('is_public', true)
      .eq('status', 'ready')
      .single()

    recording = data

    if (recording) {
      // Increment view count
      await supabase
        .from('recordings')
        .update({ view_count: (recording.view_count || 0) + 1 })
        .eq('id', recording.id)
    }
  } catch {
    // Failed to fetch
  }

  if (!recording) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Recording Not Found</h1>
          <p className="mt-2 text-muted-foreground">
            This recording may have been deleted or is not publicly available.
          </p>
        </div>
      </div>
    )
  }

  const supabase = createAdminClient()
  const videoUrl = recording.storage_path
    ? supabase.storage
        .from('recordings')
        .getPublicUrl(recording.storage_path).data.publicUrl
    : null

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-4 py-8">
        <WatchPlayer videoUrl={videoUrl} title={recording.title} duration={recording.duration} />
      </div>
    </div>
  )
}
