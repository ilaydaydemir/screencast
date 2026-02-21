import { RecordingGrid } from '@/components/recordings/RecordingGrid'

export default function DashboardPage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">My Recordings</h1>
      <RecordingGrid />
    </div>
  )
}
