import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // Auth via Bearer token (extension doesn't have cookies)
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

  // Verify the recording belongs to this user
  const { data: recording, error: recErr } = await supabase
    .from('recordings')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (recErr || !recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  const admin = createAdminClient()
  const chunkPrefix = `${user.id}/${id}/chunks/`

  try {
    // List all chunks
    const { data: files, error: listErr } = await admin.storage
      .from('recordings')
      .list(`${user.id}/${id}/chunks`, {
        sortBy: { column: 'name', order: 'asc' },
      })

    if (listErr || !files || files.length === 0) {
      return NextResponse.json({ error: 'No chunks found' }, { status: 404 })
    }

    // Download and concatenate all chunks
    const chunkBuffers: Uint8Array[] = []
    let totalSize = 0

    for (const file of files) {
      const { data: blob, error: dlErr } = await admin.storage
        .from('recordings')
        .download(`${chunkPrefix}${file.name}`)

      if (dlErr || !blob) {
        return NextResponse.json(
          { error: `Failed to download chunk ${file.name}` },
          { status: 500 }
        )
      }

      const buffer = new Uint8Array(await blob.arrayBuffer())
      chunkBuffers.push(buffer)
      totalSize += buffer.length
    }

    // Concatenate into single buffer
    const finalBuffer = new Uint8Array(totalSize)
    let offset = 0
    for (const buf of chunkBuffers) {
      finalBuffer.set(buf, offset)
      offset += buf.length
    }

    // Upload final file
    const videoPath = `${user.id}/${id}.webm`
    const { error: uploadErr } = await admin.storage
      .from('recordings')
      .upload(videoPath, finalBuffer, {
        contentType: 'video/webm',
        upsert: true,
      })

    if (uploadErr) {
      return NextResponse.json(
        { error: `Final upload failed: ${uploadErr.message}` },
        { status: 500 }
      )
    }

    // Update recording row
    const body = await request.json().catch(() => ({}))
    await admin
      .from('recordings')
      .update({
        storage_path: videoPath,
        thumbnail_path: body.thumbnail_path || null,
        file_size: totalSize,
        status: 'ready',
        title: body.title || recording.title,
        duration: body.duration ?? recording.duration,
      })
      .eq('id', id)

    // Cleanup chunks
    const chunkPaths = files.map(f => `${chunkPrefix}${f.name}`)
    await admin.storage.from('recordings').remove(chunkPaths)

    return NextResponse.json({
      success: true,
      storage_path: videoPath,
      file_size: totalSize,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Assembly failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
