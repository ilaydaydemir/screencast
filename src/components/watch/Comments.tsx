'use client'
import { useState, useEffect } from 'react'

interface Comment { id: string; name: string; body: string; created_at: string }

interface CommentsProps {
  shareId: string
  recordingId?: string  // if provided, owner delete buttons are shown
}

export function Comments({ shareId, recordingId }: CommentsProps) {
  const [comments, setComments] = useState<Comment[]>([])
  const [name, setName]         = useState('')
  const [body, setBody]         = useState('')
  const [loading, setLoading]   = useState(false)

  const load = async () => {
    const res = await fetch(`/api/watch/${shareId}/comments`)
    if (res.ok) setComments(await res.json())
  }

  useEffect(() => { load() }, [shareId]) // eslint-disable-line

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return
    setLoading(true)
    const res = await fetch(`/api/watch/${shareId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, body }),
    })
    if (res.ok) { setBody(''); load() }
    setLoading(false)
  }

  const deleteComment = async (commentId: string) => {
    if (!recordingId) return
    if (!confirm('Delete this comment?')) return
    await fetch(`/api/recordings/${recordingId}/comments/${commentId}`, { method: 'DELETE' })
    setComments(prev => prev.filter(c => c.id !== commentId))
  }

  const fmt = (d: string) =>
    new Date(d).toLocaleDateString('en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  return (
    <div className="mt-8">
      <h2 className="text-sm font-semibold mb-4">
        Comments{' '}
        {comments.length > 0 && (
          <span className="text-muted-foreground font-normal">({comments.length})</span>
        )}
      </h2>

      {/* Comment form */}
      <form onSubmit={submit} className="mb-6 flex flex-col gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your name (optional)"
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-500"
        />
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Leave a comment…"
          rows={3}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none resize-y placeholder:text-zinc-500"
        />
        <button
          type="submit"
          disabled={loading || !body.trim()}
          className="self-end bg-red-500 hover:bg-red-600 disabled:opacity-40 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors"
        >
          {loading ? 'Posting…' : 'Post'}
        </button>
      </form>

      {/* Comment list */}
      <div className="flex flex-col gap-3">
        {comments.length === 0 && (
          <p className="text-zinc-500 text-sm">No comments yet. Be the first!</p>
        )}
        {comments.map(c => (
          <div
            key={c.id}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-semibold">{c.name}</span>
              <div className="flex items-center gap-3">
                <span className="text-xs text-zinc-500">{fmt(c.created_at)}</span>
                {recordingId && (
                  <button
                    onClick={() => deleteComment(c.id)}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            <p className="text-sm text-zinc-300 leading-relaxed m-0">{c.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
