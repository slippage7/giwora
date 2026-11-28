import { put } from '@vercel/blob';
import {
  MAX_JSON_BYTES,
  blobConfigured,
  cleanLink,
  cleanText,
  isBlobUrl,
  readBuffer,
  sendJson,
} from './_shared.js';

const SITE = 'https://giwora.vercel.app';

// POST /api/metadata  (JSON body)
// Builds the token metadata document from validated fields, stores it in
// Vercel Blob and returns the public URL to pass to the launch transaction.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Use POST.' });
  }

  if (!blobConfigured()) {
    return sendJson(res, 503, {
      error:
        'Metadata storage is not connected yet. Add a Vercel Blob store to this project.',
    });
  }

  let input;

  try {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      input = req.body;
    } else {
      const raw = await readBuffer(req, MAX_JSON_BYTES);
      input = JSON.parse(raw.toString('utf8'));
    }
  } catch (err) {
    const status = err?.status === 413 ? 413 : 400;
    return sendJson(res, status, { error: 'Invalid metadata request.' });
  }

  const name = cleanText(input.name, 64);
  const symbol = cleanText(input.symbol, 10).toUpperCase();
  const description = cleanText(input.description, 500);

  if (!name) return sendJson(res, 400, { error: 'Token name is required.' });

  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) {
    return sendJson(res, 400, {
      error: 'Symbol must contain 2–10 letters or numbers.',
    });
  }

  let image = '';

  if (input.image) {
    if (!isBlobUrl(input.image)) {
      return sendJson(res, 400, {
        error: 'Logo must be uploaded through GIWORA first.',
      });
    }
    image = String(input.image);
  }

  const website = cleanLink(input.website);
  const x = cleanLink(input.x);
  const telegram = cleanLink(input.telegram);

  const links = {};
  if (website) links.website = website;
  if (x) links.x = x;
  if (telegram) links.telegram = telegram;

  const doc = {
    name,
    symbol,
    description,
    ...(image ? { image } : {}),
    external_url: website || SITE,
    ...(Object.keys(links).length ? { links } : {}),
    network: 'GIWA Sepolia',
    chain_id: 91342,
    created_with: 'GIWORA',
  };

  try {
    const blob = await put(
      `metadata/${symbol.toLowerCase()}.json`,
      JSON.stringify(doc, null, 2),
      {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: true,
        cacheControlMaxAge: 31536000,
      }
    );

    return sendJson(res, 200, { url: blob.url });
  } catch (err) {
    console.error('metadata failed', err);
    return sendJson(res, 500, {
      error: 'Could not store the metadata. Try again.',
    });
  }
}
