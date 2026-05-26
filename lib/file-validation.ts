/**
 * Magic byte verification for uploaded files (H7 / audit finding follow-up).
 * Checks the first few bytes of a file to confirm its content matches the
 * declared MIME type, preventing spoofed uploads.
 *
 * Behavior: fail-closed. If an upload arrives with a MIME type we do not
 * recognize, we reject it. Previously the function returned true for unknown
 * MIME types (e.g., application/octet-stream), which let an attacker bypass
 * the magic-byte check entirely by choosing a content-type that we had no
 * signature for. Callers also enforce ALLOWED_UPLOAD_MIME_TYPES, so unknown
 * types should never reach here in practice; treating them as a hard reject
 * is the safer default.
 */

interface Signature {
  /** Bytes to match. */
  bytes: number[]
  /** Byte offset where the signature begins. Defaults to 0. */
  offset?: number
}

// Sentinel for plaintext formats (CSV, TXT) that genuinely have no magic
// bytes but are still allowed. Anything in this set passes without a check.
const PLAINTEXT_MIME_TYPES = new Set<string>([
  'text/csv',
  'text/plain',
])

const MAGIC_BYTES: Record<string, Signature[]> = {
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
    { bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF (WebP container; WEBP fourCC at offset 8 also distinguishes from WAV/AVI but tightening here is out of audit scope)
  ],
  'image/heic': [
    { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ftyp box
  ],
  'image/heif': [
    { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  ],
  // OOXML formats (DOCX, XLSX, PPTX) are ZIP archives with this prefix.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    { bytes: [0x50, 0x4B, 0x03, 0x04] },
    { bytes: [0x50, 0x4B, 0x05, 0x06] }, // empty ZIP
    { bytes: [0x50, 0x4B, 0x07, 0x08] }, // spanned ZIP (rare but valid)
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    { bytes: [0x50, 0x4B, 0x03, 0x04] },
    { bytes: [0x50, 0x4B, 0x05, 0x06] },
    { bytes: [0x50, 0x4B, 0x07, 0x08] },
  ],
  // Legacy MS Office binary formats use the OLE Compound Document File.
  'application/msword': [
    { bytes: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] },
  ],
  'application/vnd.ms-excel': [
    { bytes: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] },
  ],
}

/**
 * Verify that a file's actual content matches its declared MIME type.
 * Reads the first 16 bytes and compares against known signatures.
 *
 * Returns true only when:
 *   - the MIME type is one of the plaintext formats listed above (no magic), or
 *   - the MIME type has a signature and at least one signature matches.
 *
 * Returns false for unknown MIME types, signature mismatches, and any I/O
 * failure reading the file.
 */
export async function verifyFileMagicBytes(file: File): Promise<boolean> {
  if (PLAINTEXT_MIME_TYPES.has(file.type)) return true

  const signatures = MAGIC_BYTES[file.type]
  if (!signatures || signatures.length === 0) return false

  try {
    // 16 bytes is enough for every signature above; webp needs offset 8 + 4.
    const buffer = await file.slice(0, 16).arrayBuffer()
    const header = new Uint8Array(buffer)

    return signatures.some(sig => {
      const offset = sig.offset || 0
      if (offset + sig.bytes.length > header.length) return false
      return sig.bytes.every((byte, i) => header[offset + i] === byte)
    })
  } catch {
    return false
  }
}
