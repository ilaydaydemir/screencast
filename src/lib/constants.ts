export const MAX_RECORDING_DURATION_SECONDS = 3600 // 60 minutes
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 // 500MB

export const SUPPORTED_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

export const RECORDING_MODES = [
  { id: 'full-screen', label: 'Full Screen', icon: 'Monitor' },
  { id: 'window', label: 'Window', icon: 'AppWindow' },
  { id: 'tab', label: 'Current Tab', icon: 'PanelTop' },
  { id: 'camera-only', label: 'Camera Only', icon: 'Camera' },
] as const

export type RecordingMode = (typeof RECORDING_MODES)[number]['id']

export const VIDEO_FRAME_RATE = 30
export const VIDEO_BITS_PER_SECOND = 2_500_000
export const THUMBNAIL_WIDTH = 640
export const THUMBNAIL_HEIGHT = 360
