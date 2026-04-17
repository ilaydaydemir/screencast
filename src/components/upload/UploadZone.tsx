'use client'

import { useCallback, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; progress: number; name: string }
  | { status: 'done'; shareId: string; title: string }
  | { status: 'error'; message: string }

export function UploadZone({ onDone }: { onDone?: () => void }) {
  const [state, setState] = useState<UploadState>({ status: 'idle' })
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = useCallback(async (file: File) => {
    if (!file.type.startsWith('video/')) {
      setState({ status: 'error', message: 'Please upload a video file.' })
      return
    }

    setState({ status: 'uploading', progress: 0, name: file.name })

    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not signed in')

      // 1. Create DB record
      const title = file.name.replace(/\.[^.]+$/, '') || 'Untitled'
      const { data: rec, error: recErr } = await supabase
        .from('recordings')
        .insert({
          user_id: user.id,
          title,
          file_size: file.size,
          mime_type: file.type,
          recording_mode: 'screen',
          status: 'processing',
        })
        .select()
        .single()

      if (recErr || !rec) throw new Error(recErr?.message || 'Failed to create record')
      setState(s => s.status === 'uploading' ? { ...s, progress: 15 } : s)

      // 2. Upload to storage using XMLHttpRequest for progress
      const path = `${user.id}/${rec.id}${getExt(file.type)}`
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) throw new Error('No auth token')

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/recordings/${path}`
        xhr.open('POST', url)
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        xhr.setRequestHeader('Content-Type', file.type)
        xhr.setRequestHeader('apikey', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = 15 + Math.round((e.loaded / e.total) * 80)
            setState(s => s.status === 'uploading' ? { ...s, progress: pct } : s)
          }
        }
        xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`))
        xhr.onerror = () => reject(new Error('Network error during upload'))
        xhr.send(file)
      })

      setState(s => s.status === 'uploading' ? { ...s, progress: 97 } : s)

      // 3. Mark ready
      await supabase
        .from('recordings')
        .update({ storage_path: path, status: 'ready' })
        .eq('id', rec.id)

      setState({ status: 'done', shareId: rec.share_id, title })
      onDone?.()
    } catch (e: unknown) {
      setState({ status: 'error', message: e instanceof Error ? e.message : 'Upload failed' })
    }
  }, [onDone])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) upload(file)
  }, [upload])

  const shareUrl = state.status === 'done'
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/watch/${state.shareId}`
    : ''

  return (
    <div className="w-full">
      {state.status === 'idle' && (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`
            flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed
            py-14 px-8 cursor-pointer transition-all select-none
            ${dragging
              ? 'border-red-500 bg-red-500/5 scale-[1.01]'
              : 'border-border hover:border-muted-foreground/50 hover:bg-muted/30'
            }
          `}
        >
          <div className="text-5xl">🎬</div>
          <div className="text-center">
            <p className="text-base font-semibold">Drop your video here</p>
            <p className="mt-1 text-sm text-muted-foreground">
              or click to browse — MP4, WebM, MOV supported
            </p>
          </div>
          <div className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground">
            Choose File
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }}
          />
        </div>
      )}

      {state.status === 'uploading' && (
        <div className="flex flex-col items-center gap-5 rounded-2xl border border-border bg-card px-8 py-14">
          <div className="text-4xl">⏫</div>
          <p className="text-sm font-medium">Uploading <span className="text-muted-foreground">{state.name}</span></p>
          <div className="w-full max-w-xs">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-red-500 transition-all duration-300"
                style={{ width: `${state.progress}%` }}
              />
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">{state.progress}%</p>
          </div>
        </div>
      )}

      {state.status === 'done' && (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card px-8 py-12">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15 text-2xl">✓</div>
          <div className="text-center">
            <p className="font-semibold">{state.title}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">Uploaded successfully</p>
          </div>
          <div
            className="flex w-full max-w-sm cursor-pointer items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs transition-colors hover:bg-muted"
            onClick={() => navigator.clipboard.writeText(shareUrl)}
          >
            <span className="flex-1 truncate text-green-500">{shareUrl}</span>
            <span className="shrink-0 text-muted-foreground">Copy</span>
          </div>
          <div className="flex gap-3">
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              Watch →
            </a>
            <button
              onClick={() => setState({ status: 'idle' })}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Upload Another
            </button>
          </div>
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-destructive/40 bg-destructive/5 px-8 py-12">
          <div className="text-3xl">⚠️</div>
          <p className="text-sm font-medium text-destructive">{state.message}</p>
          <button
            onClick={() => setState({ status: 'idle' })}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  )
}

function getExt(mimeType: string): string {
  const map: Record<string, string> = {
    'video/webm': '.webm',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-matroska': '.mkv',
  }
  return map[mimeType] ?? '.webm'
}
