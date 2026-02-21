import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ shareId: string }> }
) {
  const { shareId } = await params
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('recordings')
    .select('id, title, duration, mime_type, storage_path, thumbnail_path, share_id, view_count, created_at')
    .eq('share_id', shareId)
    .eq('is_public', true)
    .eq('status', 'ready')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Increment view count
  await supabase
    .from('recordings')
    .update({ view_count: (data.view_count || 0) + 1 })
    .eq('id', data.id)

  return NextResponse.json(data)
}
