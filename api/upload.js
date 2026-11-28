import { put } from '@vercel/blob';
import {
  MAX_LOGO_BYTES,
  blobConfigured,
  detectImage,
  readBuffer,
  sendJson,
} from './_shared.js';

// POST /api/upload  (raw image bytes in the body)
// Stores a token logo in Vercel Blob and returns its public URL.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Use POST.' });
  }

  if (!blobConfigured()) {
    return sendJson(res, 503, {
      error:
        'Logo storage is not connected yet. Add a Vercel Blob store to this project.',
    });
  }

  try {
    const buffer = await readBuffer(req, MAX_LOGO_BYTES);
    const image = detectImage(buffer);

    if (!image) {
      return sendJson(res, 415, {
        error: 'Logo must be a PNG, JPG, WEBP or GIF image.',
      });
    }

    const blob = await put(`logos/logo.${image.ext}`, buffer, {
      access: 'public',
      contentType: image.type,
      addRandomSuffix: true,
      cacheControlMaxAge: 31536000,
    });

    return sendJson(res, 200, { url: blob.url });
  } catch (err) {
    if (err?.status === 413) {
      return sendJson(res, 413, { error: 'Logo must be smaller than 2 MB.' });
    }

    console.error('upload failed', err);
    return sendJson(res, 500, { error: 'Could not store the logo. Try again.' });
  }
}
