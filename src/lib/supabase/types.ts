export type Database = {
  public: {
    Tables: {
      recordings: {
        Row: {
          id: string
          user_id: string
          title: string
          description: string | null
          duration: number
          file_size: number
          mime_type: string
          storage_path: string | null
          thumbnail_path: string | null
          share_id: string
          is_public: boolean
          view_count: number
          recording_mode: 'screen' | 'camera_only'
          status: 'processing' | 'ready' | 'failed'
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          title?: string
          description?: string | null
          duration?: number
          file_size?: number
          mime_type?: string
          storage_path?: string | null
          thumbnail_path?: string | null
          share_id?: string
          is_public?: boolean
          view_count?: number
          recording_mode?: 'screen' | 'camera_only'
          status?: 'processing' | 'ready' | 'failed'
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          title?: string
          description?: string | null
          duration?: number
          file_size?: number
          mime_type?: string
          storage_path?: string | null
          thumbnail_path?: string | null
          share_id?: string
          is_public?: boolean
          view_count?: number
          recording_mode?: 'screen' | 'camera_only'
          status?: 'processing' | 'ready' | 'failed'
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
  }
}
