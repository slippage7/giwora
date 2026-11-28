// Shared helpers for the upload endpoints. Files starting with "_" are not
// exposed as routes by Vercel.

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 16 * 1024;

// Public Vercel Blob URLs always live under this host suffix.
export const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';

export function sendJson(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

export function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

// Reads a request body as a Buffer, whether or not Vercel already parsed it.
export async function readBuffer(req, limit) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > limit) throw tooLarge();
    return req.body;
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw tooLarge();

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw tooLarge();
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function tooLarge() {
  const err = new Error('File is too large.');
  err.status = 413;
  return err;
}

// Confirms the bytes really are the image type that was declared, so this
// endpoint cannot be used to host arbitrary files.
export function detectImage(buffer) {
  if (buffer.length < 12) return null;

  const hex = buffer.subarray(0, 4).toString('hex');

  if (hex === '89504e47') return { type: 'image/png', ext: 'png' };
  if (hex.startsWith('ffd8ff')) return { type: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') {
    return { type: 'image/gif', ext: 'gif' };
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { type: 'image/webp', ext: 'webp' };
  }

  return null;
}

export function isBlobUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

export function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

export function cleanLink(value) {
  const text = cleanText(value, 200);
  if (!text) return '';

  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}
