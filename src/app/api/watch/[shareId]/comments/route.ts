import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET(_req: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params
  const admin = createAdminClient()
  const { data: recording } = await admin.from('recordings').select('id').eq('share_id', shareId).single()
  if (!recording) return NextResponse.json([], { status: 200 })
  const { data } = await admin
    .from('recording_comments')
    .select('id,name,body,created_at')
    .eq('recording_id', recording.id)
    .order('created_at', { ascending: true })
  return NextResponse.json(data ?? [])
}

export async function POST(req: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params
  const { name, body } = await req.json()
  if (!body?.trim()) return NextResponse.json({ error: 'Body required' }, { status: 400 })
  const admin = createAdminClient()
  const { data: recording } = await admin.from('recordings').select('id').eq('share_id', shareId).single()
  if (!recording) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data, error } = await admin
    .from('recording_comments')
    .insert({ recording_id: recording.id, name: name?.trim() || 'Anonymous', body: body.trim() })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
