/**
 * Response-body compression pipeline: buffer → decompress → transform → recompress.
 *
 * The proxied DSH 0.1.2+ web server compresses responses by default (gzip).
 * Compressed bodies are binary bytes, so any plain-text rewrite — the randomUUID
 * polyfill injected into HTML, or the isLoopbackHostname replacement in JS —
 * fails to match. The previous approach skipped rewriting entirely when a
 * `content-encoding` header was present, which left the settings Models page
 * degraded once the upstream compressed its payloads.
 *
 * This module instead supports every compression form the browser/upstream use
 * (gzip / deflate / br, and uncompressed identity): keep the upstream's
 * compressed response, buffer the full body, decompress by Content-Encoding into
 * plain text, run the rewrite, then recompress by the original encoding. If the
 * encoding is unsupported or decompression fails, pass the bytes through
 * untouched rather than corrupting the response.
 *
 */
import zlib from 'node:zlib'
import type http from 'node:http'

/**
 * Resolve the encoding from a `content-encoding` header, which may look like
 * "gzip", "br", or "gzip, br" — take the first valid value.
 * Empty/identity means uncompressed; anything unrecognised is returned as-is
 * (treated as unsupported by the caller).
 */
function parseEncoding(ce: string | undefined): string {
  if (!ce) return 'identity'
  const first = String(ce).split(',')[0].trim().toLowerCase()
  return first || 'identity'
}

/** Decompress into plain text. identity passes through; null means unsupported/failed. */
function decompress(buf: Buffer, encoding: string): Buffer | null {
  if (!encoding || encoding === 'identity') return buf
  try {
    switch (encoding) {
      case 'gzip':
        return zlib.gunzipSync(buf)
      case 'deflate':
        // Prefer the standard zlib wrapper; some servers send raw deflate
        // (RFC 1951), so fall back to raw inflate on failure.
        try {
          return zlib.inflateSync(buf)
        } catch {
          return zlib.inflateRawSync(buf)
        }
      case 'br':
        return zlib.brotliDecompressSync(buf)
      default:
        return null // unsupported encoding (e.g. zstd) → cannot rewrite
    }
  } catch {
    return null
  }
}

/** Recompress by the original encoding. identity passes through; null means unsupported/failed. */
function recompress(buf: Buffer, encoding: string): Buffer | null {
  if (!encoding || encoding === 'identity') return buf
  try {
    switch (encoding) {
      case 'gzip':
        return zlib.gzipSync(buf)
      case 'deflate':
        return zlib.deflateSync(buf)
      case 'br':
        return zlib.brotliCompressSync(buf)
      default:
        return null
    }
  } catch {
    return null
  }
}

/**
 * Attach the buffered "decompress → transform(plain) → recompress → send" pipeline
 * to `res`, from the `proxyRes` event of http-proxy. The rewrite changes the body
 * length, so `content-length` is always dropped and the body is sent chunked.
 *
 * `transform(plainBuffer)` returns the rewritten Buffer, or null when no rewrite
 * is needed (pass the original bytes through unwrapped).
 *
 * Degradation guarantees (the response is never corrupted):
 * - upstream compressed but decompression fails / encoding unsupported → pass the
 *   compressed bytes through, keeping the upstream Content-Encoding value;
 * - rewrite succeeded but recompression fails → send plain text and drop the
 *   Content-Encoding header so the browser reads it as plain;
 * - uncompressed (identity) → rewrite directly with no compression overhead.
 *
 * @param res    - the outbound server response to intercept.
 * @param proxyRes - the upstream response being streamed through.
 * @param transform - plain-buffer → rewritten-buffer (or null to passthrough).
 */
export function attachBodyTransform(
  res: http.ServerResponse,
  proxyRes: http.IncomingMessage,
  transform: (plain: Buffer) => Buffer | null,
): void {
  const encoding = parseEncoding(proxyRes.headers['content-encoding'])
  delete proxyRes.headers['content-length']
  res.removeHeader('content-length')

  const chunks: Buffer[] = []
  const origWrite = res.write.bind(res)
  const origEnd = res.end.bind(res)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(res as any).write = (chunk: any, ...rest: any[]): boolean => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return true
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(res as any).end = (chunk?: any, ...rest: any[]): void => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    res.write = origWrite
    res.end = origEnd

    const raw = Buffer.concat(chunks)
    // Annotate as the generic Buffer<ArrayBufferLike>: `Buffer.concat` yields
    // Buffer<ArrayBuffer> while zlib output is Buffer<ArrayBufferLike>.
    let out: Buffer = raw
    const plain = decompress(raw, encoding)
    if (plain !== null) {
      const rewritten = transform(plain)
      if (rewritten !== null) {
        const compressed = recompress(rewritten, encoding)
        if (compressed !== null) {
          out = compressed // decompress → rewrite → recompress, keep the original encoding
        } else {
          out = rewritten // recompress failed: send plain text, drop Content-Encoding
          delete proxyRes.headers['content-encoding']
        }
      }
    }
    origEnd(out, ...rest)
  }
}