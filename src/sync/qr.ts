import QRCode from 'qrcode'

/** Renders an account bundle's JSON as a scannable QR code, for pairing a new device out of band. */
export async function bundleToQrDataUrl(json: string): Promise<string> {
  return QRCode.toDataURL(json, { margin: 1, width: 320 })
}
