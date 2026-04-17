'use client'

import { useRouter } from 'next/navigation'
import { UploadZone } from '@/components/upload/UploadZone'

export default function UploadPage() {
  const router = useRouter()

  return (
    <div className="mx-auto max-w-xl py-2">
      <h1 className="mb-2 text-xl font-semibold">Upload Video</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Drop a video file to upload it and get a shareable watch link instantly.
      </p>
      <UploadZone onDone={() => router.push('/dashboard')} />
    </div>
  )
}
