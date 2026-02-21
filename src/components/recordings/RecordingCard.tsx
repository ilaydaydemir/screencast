'use client'

import Link from 'next/link'
import { MoreVertical, Trash2, Copy, Eye } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { formatDuration, formatRelativeTime } from '@/lib/format'
import { createClient } from '@/lib/supabase/client'
import type { Database } from '@/lib/supabase/types'

type Recording = Database['public']['Tables']['recordings']['Row']

interface RecordingCardProps {
  recording: Recording
  onDelete: (id: string) => void
}

export function RecordingCard({ recording, onDelete }: RecordingCardProps) {
  const supabase = createClient()

  const thumbnailUrl = recording.thumbnail_path
    ? supabase.storage
        .from('recordings')
        .getPublicUrl(recording.thumbnail_path).data.publicUrl
    : null

  const shareUrl = `${window.location.origin}/watch/${recording.share_id}`

  const copyShareLink = async () => {
    await navigator.clipboard.writeText(shareUrl)
  }

  return (
    <div className="group overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md">
      <Link href={`/dashboard/recordings/${recording.id}`}>
        <div className="relative aspect-video bg-muted">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={recording.title}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              No Preview
            </div>
          )}
          <Badge className="absolute bottom-2 right-2 bg-black/70 text-white">
            {formatDuration(recording.duration)}
          </Badge>
          {recording.status === 'processing' && (
            <Badge className="absolute left-2 top-2" variant="secondary">
              Processing...
            </Badge>
          )}
        </div>
      </Link>
      <div className="flex items-start justify-between p-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{recording.title}</h3>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{formatRelativeTime(recording.created_at)}</span>
            {recording.view_count > 0 && (
              <span className="flex items-center gap-1">
                <Eye className="h-3 w-3" />
                {recording.view_count}
              </span>
            )}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100"
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={copyShareLink}>
              <Copy className="mr-2 h-4 w-4" />
              Copy Share Link
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => onDelete(recording.id)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
