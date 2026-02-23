import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // Auth via Bearer token
  const token = request.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 })
  }

  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify recording belongs to user
  const { data: recording } = await supabase
    .from('recordings')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  const admin = createAdminClient()
  const { data: files, error } = await admin.storage
    .from('recordings')
    .list(`${user.id}/${id}/chunks`, {
      sortBy: { column: 'name', order: 'asc' },
    })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    chunks: (files || []).map(f => f.name),
    count: files?.length || 0,
  })
}
