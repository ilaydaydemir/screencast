'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

interface TranscriptSegment {
  id: number
  text: string
  isFinal: boolean
  timestamp: string
}

export default function LiveTranscript() {
  const [isRecording, setIsRecording] = useState(false)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [interimText, setInterimText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [supported, setSupported] = useState(true)

  // eslint-disable-next-line no-undef
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const segmentIdRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setSupported(false)
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [segments, interimText])

  const stop = useCallback(() => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setIsRecording(false)
    setInterimText('')
  }, [])

  const start = useCallback(() => {
    setError(null)

    const SpeechRecognitionAPI =
      (typeof SpeechRecognition !== 'undefined' ? SpeechRecognition : null) ||
      (typeof webkitSpeechRecognition !== 'undefined' ? webkitSpeechRecognition : null)

    if (!SpeechRecognitionAPI) return

    const recognition = new SpeechRecognitionAPI()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onstart = () => setIsRecording(true)

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          const text = result[0].transcript.trim()
          if (text) {
            const now = new Date()
            const timestamp = now.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
            setSegments(prev => [
              ...prev,
              { id: segmentIdRef.current++, text, isFinal: true, timestamp },
            ])
          }
        } else {
          interim += result[0].transcript
        }
      }
      setInterimText(interim)
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'aborted') return
      setError(`Mic error: ${event.error}`)
      stop()
    }

    recognition.onend = () => {
      // Auto-restart if still supposed to be recording
      if (recognitionRef.current) {
        recognition.start()
      }
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [stop])

  const clearAll = () => {
    setSegments([])
    setInterimText('')
  }

  const copyAll = () => {
    const text = segments.map(s => s.text).join(' ')
    navigator.clipboard.writeText(text)
  }

  const saveAsTxt = () => {
    const lines = segments.map(s => `[${s.timestamp}] ${s.text}`).join('\n')
    const blob = new Blob([lines], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transcript-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!supported) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center max-w-md p-8">
          <div className="text-5xl mb-4">🚫</div>
          <h1 className="text-2xl font-bold mb-2">Browser Not Supported</h1>
          <p className="text-muted-foreground">
            Please open this page in <strong>Google Chrome</strong>. The Web Speech API is only
            available in Chrome.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full transition-all ${
              isRecording ? 'bg-red-500 animate-pulse' : 'bg-muted-foreground'
            }`}
          />
          <h1 className="text-lg font-semibold">Live Transcript</h1>
        </div>
        <div className="flex items-center gap-2">
          {segments.length > 0 && (
            <>
              <button
                onClick={copyAll}
                className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-accent transition-colors"
              >
                Copy All
              </button>
              <button
                onClick={saveAsTxt}
                className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-accent transition-colors"
              >
                Save .txt
              </button>
              <button
                onClick={clearAll}
                className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-accent transition-colors text-destructive"
              >
                Clear
              </button>
            </>
          )}
        </div>
      </header>

      {/* Transcript area */}
      <main className="flex-1 overflow-y-auto px-6 py-8 max-w-3xl mx-auto w-full">
        {segments.length === 0 && !interimText && (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="text-6xl mb-6">🎙️</div>
            <p className="text-muted-foreground text-lg">
              {isRecording
                ? 'Listening… start speaking'
                : 'Press Start to begin live transcription'}
            </p>
          </div>
        )}

        {/* Final segments */}
        <div className="space-y-4">
          {segments.map(seg => (
            <div key={seg.id} className="flex gap-4 group">
              <span className="text-xs text-muted-foreground pt-0.5 shrink-0 font-mono">
                {seg.timestamp}
              </span>
              <p className="text-foreground leading-relaxed">{seg.text}</p>
            </div>
          ))}

          {/* Interim (in-progress) text */}
          {interimText && (
            <div className="flex gap-4">
              <span className="text-xs text-muted-foreground pt-0.5 shrink-0 font-mono">
                live
              </span>
              <p className="text-muted-foreground leading-relaxed italic">{interimText}</p>
            </div>
          )}
        </div>

        <div ref={bottomRef} />
      </main>

      {/* Error */}
      {error && (
        <div className="mx-6 mb-4 px-4 py-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Footer controls */}
      <footer className="border-t border-border px-6 py-5 flex items-center justify-center gap-4">
        {!isRecording ? (
          <button
            onClick={start}
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity text-sm"
          >
            <span className="w-2 h-2 rounded-full bg-red-400" />
            Start Recording
          </button>
        ) : (
          <button
            onClick={stop}
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-destructive text-white font-medium hover:opacity-90 transition-opacity text-sm"
          >
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            Stop Recording
          </button>
        )}
        {segments.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {segments.length} segment{segments.length !== 1 ? 's' : ''}
          </span>
        )}
      </footer>
    </div>
  )
}
