import Link from 'next/link'
import { Video } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function RecordingEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
      <Video className="mb-4 h-12 w-12 text-muted-foreground" />
      <h3 className="mb-2 text-lg font-medium">No recordings yet</h3>
      <p className="mb-6 text-sm text-muted-foreground">
        Create your first recording to get started
      </p>
      <Button asChild>
        <Link href="/dashboard/record">Create Recording</Link>
      </Button>
    </div>
  )
}
