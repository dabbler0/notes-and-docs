import { useEffect, useRef, useState } from 'preact/hooks'
import jsQR from 'jsqr'

/**
 * A camera-based QR scanner for pairing a new device. Needs `getUserMedia`,
 * which browsers only grant in a secure context (https, or localhost) — a
 * copy of this app opened straight from disk via `file://` won't get camera
 * access at all, so this fails over to a plain message rather than a stuck
 * spinner; the key-file and paste-JSON import paths are the ones guaranteed
 * to work everywhere.
 */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState('')
  const rafRef = useRef(0)
  const stoppedRef = useRef(false)
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    let stream: MediaStream | null = null
    stoppedRef.current = false

    function tick() {
      if (stoppedRef.current) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const code = jsQR(imageData.data, imageData.width, imageData.height)
          if (code && code.data) {
            onResultRef.current(code.data)
            return
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        tick()
      } catch {
        setError('Camera unavailable here (needs https, and camera permission) — use a key file or paste the key text instead.')
      }
    }
    start()

    return () => {
      stoppedRef.current = true
      cancelAnimationFrame(rafRef.current)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  if (error) return <p className="muted">{error}</p>

  return (
    <div className="qr-scanner">
      <video ref={videoRef} className="qr-scanner-video" playsInline muted />
      <canvas ref={canvasRef} hidden />
      <p className="muted">Point the camera at the other device's transfer QR code.</p>
    </div>
  )
}
