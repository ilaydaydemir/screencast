'use client'

import { useState } from 'react'
import { UploadZone } from '@/components/upload/UploadZone'
import { RecordingGrid } from '@/components/recordings/RecordingGrid'
import { Upload, Video } from 'lucide-react'

export default function DashboardPage() {
  const [tab, setTab] = useState<'library' | 'upload'>('library')
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <div className="flex h-full flex-col gap-0">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border px-1 pb-0">
        <TabButton
          active={tab === 'library'}
          onClick={() => setTab('library')}
          icon={<Video className="h-4 w-4" />}
          label="Library"
        />
        <TabButton
          active={tab === 'upload'}
          onClick={() => setTab('upload')}
          icon={<Upload className="h-4 w-4" />}
          label="Upload"
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'library' && (
          <div key={refreshKey}>
            <h1 className="mb-6 text-xl font-semibold">My Recordings</h1>
            <RecordingGrid />
          </div>
        )}
        {tab === 'upload' && (
          <div className="mx-auto max-w-xl">
            <h1 className="mb-2 text-xl font-semibold">Upload Video</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              Drop a video file to upload it and get a shareable watch link.
            </p>
            <UploadZone
              onDone={() => {
                setRefreshKey(k => k + 1)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function TabButton({
  active, onClick, icon, label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`
        flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors
        ${active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
        }
      `}
    >
      {icon}
      {label}
    </button>
  )
}
