/**
 * Magic byte verification for uploaded files (H7 security fix).
 * Checks the first few bytes of a file to confirm its content
 * matches the declared MIME type, preventing spoofed uploads.
 */

// Known magic bytes for allowed file types
const MAGIC_BYTES: Record<string, { bytes: number[]; offset?: number }[]> = {
  'application/pdf': [
    { bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  ],
  'image/jpeg': [
    { bytes: [0xFF, 0xD8, 0xFF] }, // JPEG/JFIF
  ],
  'image/png': [
    { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }, // PNG signature
  ],
  'image/gif': [
    { bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF87a or GIF89a
  ],
  'image/webp': [
    { bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF (WebP container)
  ],
  'image/heic': [
    // HEIC uses ftyp box starting at offset 4
    { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ftyp
  ],
  'image/heif': [
    { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  ],
}

/**
 * Verify that a file's actual content matches its declared MIME type
 * by checking magic bytes at the start of the file.
 *
 * Returns true if verified or if the MIME type isn't in our known list
 * (fail-open for types we don't have signatures for, like .docx/.xlsx).
 */
export async function verifyFileMagicBytes(file: File): Promise<boolean> {
  const signatures = MAGIC_BYTES[file.type]

  // If we don't have signatures for this type, allow it through
  // (the MIME type and extension checks are still enforced)
  if (!signatures) return true

  try {
    // Read only the first 16 bytes
    const buffer = await file.slice(0, 16).arrayBuffer()
    const header = new Uint8Array(buffer)

    // Check if any known signature matches
    return signatures.some(sig => {
      const offset = sig.offset || 0
      return sig.bytes.every((byte, i) => header[offset + i] === byte)
    })
  } catch {
    // If we can't read the file, reject it
    return false
  }
}
