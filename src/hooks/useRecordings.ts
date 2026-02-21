'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Database } from '@/lib/supabase/types'

type Recording = Database['public']['Tables']['recordings']['Row']

export function useRecordings() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const fetchRecordings = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('recordings')
      .select('*')
      .order('created_at', { ascending: false })

    if (!error && data) {
      setRecordings(data)
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchRecordings()
  }, [fetchRecordings])

  const deleteRecording = useCallback(
    async (id: string) => {
      const recording = recordings.find((r) => r.id === id)
      if (!recording) return

      // Delete storage files
      const filesToDelete = [recording.storage_path, recording.thumbnail_path].filter(
        Boolean
      ) as string[]
      if (filesToDelete.length > 0) {
        await supabase.storage.from('recordings').remove(filesToDelete)
      }

      await supabase.from('recordings').delete().eq('id', id)
      setRecordings((prev) => prev.filter((r) => r.id !== id))
    },
    [recordings, supabase]
  )

  const updateRecording = useCallback(
    async (id: string, updates: Partial<Recording>) => {
      const { data, error } = await supabase
        .from('recordings')
        .update(updates)
        .eq('id', id)
        .select()
        .single()

      if (!error && data) {
        setRecordings((prev) =>
          prev.map((r) => (r.id === id ? data : r))
        )
      }
    },
    [supabase]
  )

  return {
    recordings,
    loading,
    fetchRecordings,
    deleteRecording,
    updateRecording,
  }
}
