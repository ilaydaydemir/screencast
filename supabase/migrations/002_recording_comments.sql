-- Recording comments table
CREATE TABLE IF NOT EXISTS public.recording_comments (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  recording_id  UUID NOT NULL REFERENCES public.recordings(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT 'Anonymous',
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by recording
CREATE INDEX IF NOT EXISTS idx_recording_comments_recording_id ON public.recording_comments(recording_id);

-- RLS
ALTER TABLE public.recording_comments ENABLE ROW LEVEL SECURITY;

-- Anyone can read comments (public watch page)
CREATE POLICY "Anyone can view comments"
  ON public.recording_comments FOR SELECT
  USING (true);

-- Anyone can insert comments (no auth required for public commenting)
CREATE POLICY "Anyone can post comments"
  ON public.recording_comments FOR INSERT
  WITH CHECK (true);
