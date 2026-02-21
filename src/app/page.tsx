import Link from 'next/link'
import { Video, Monitor, Camera, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Video className="h-6 w-6 text-primary" />
            <span className="text-xl font-bold">Screencast</span>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" asChild>
              <Link href="/auth/signin">Sign In</Link>
            </Button>
            <Button asChild>
              <Link href="/auth/register">Get Started</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 py-24 text-center">
        <h1 className="text-5xl font-bold tracking-tight">
          Record your screen.
          <br />
          Share instantly.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          Record your screen with webcam overlay, download or share with a link.
          No install needed — works right in your browser.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Button size="lg" asChild>
            <Link href="/auth/register">Start Recording — Free</Link>
          </Button>
        </div>
      </section>

      {/* Features */}
      <section className="border-t bg-muted/30">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-20 md:grid-cols-3">
          <div className="space-y-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Monitor className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-semibold">Screen + Webcam</h3>
            <p className="text-sm text-muted-foreground">
              Record your full screen, a window, or a tab with your webcam as a
              picture-in-picture bubble overlay.
            </p>
          </div>
          <div className="space-y-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Camera className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-semibold">Camera Only</h3>
            <p className="text-sm text-muted-foreground">
              Record just yourself with your webcam. Perfect for quick video
              messages and updates.
            </p>
          </div>
          <div className="space-y-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Share2 className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-semibold">Instant Sharing</h3>
            <p className="text-sm text-muted-foreground">
              Get a shareable link the moment you finish recording. No uploads
              to third-party platforms needed.
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t">
        <div className="mx-auto max-w-6xl px-6 py-8 text-center text-sm text-muted-foreground">
          Built with Next.js, Supabase & Browser APIs.
        </div>
      </footer>
    </div>
  )
}
