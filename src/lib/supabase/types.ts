export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: {
      recording_comments: {
        Row: {
          id: string
          recording_id: string
          name: string
          body: string
          created_at: string
        }
        Insert: {
          id?: string
          recording_id: string
          name?: string
          body: string
          created_at?: string
        }
        Update: {
          id?: string
          recording_id?: string
          name?: string
          body?: string
          created_at?: string
        }
        Relationships: []
      }
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
          subtitle_srt: string | null
          cuts: Json
          annotations: Json
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
          subtitle_srt?: string | null
          cuts?: Json
          annotations?: Json
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
          subtitle_srt?: string | null
          cuts?: Json
          annotations?: Json
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
