import type { Metadata } from 'next'
import LiveTranscript from './LiveTranscript'

export const metadata: Metadata = {
  title: 'Live Transcript – Screencast',
  description: 'Record your speech and see a live transcript in real time.',
}

export default function TranscriptPage() {
  return <LiveTranscript />
}
