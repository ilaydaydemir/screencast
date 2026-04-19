import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient as createServerClient } from '@/lib/supabase/server'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // Verify user is authenticated
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Get recording to find storage_path
  const { data: recording } = await supabase
    .from('recordings')
    .select('storage_path, user_id')
    .eq('id', id)
    .single()

  if (!recording?.storage_path) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  // Use admin client to generate signed URL (bypasses RLS)
  const admin = createAdminClient()
  const { data, error } = await admin.storage
    .from('recordings')
    .createSignedUrl(recording.storage_path, 3600)

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to sign URL' }, { status: 500 })
  }

  return NextResponse.json({ signedUrl: data.signedUrl })
}
