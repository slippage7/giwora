// Client helpers for the token metadata form: input checks, link clean-up and
// the two upload calls (logo, metadata JSON). No wallet or chain code in here.

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function checkLogoFile(file) {
  if (!file) return 'Choose an image first.';

  if (!LOGO_TYPES.includes(file.type)) {
    return 'Logo must be a PNG, JPG, WEBP or GIF image.';
  }

  if (file.size > MAX_LOGO_BYTES) {
    return 'Logo must be smaller than 2 MB.';
  }

  return '';
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Accepts a full link or a short form and returns an https URL, '' when the
// field is empty, or null when the text cannot be understood.
export function normalizeLink(kind, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  const handle = text.replace(/^@/, '');

  if (/^[A-Za-z0-9_]{1,32}$/.test(handle)) {
    if (kind === 'x') return `https://x.com/${handle}`;
    if (kind === 'telegram') return `https://t.me/${handle}`;
  }

  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;

  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes('.')) return null;
    return `https://${url.host}${url.pathname}${url.search}`.replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function post(path, init) {
  let res;

  try {
    res = await fetch(path, { method: 'POST', ...init });
  } catch {
    throw new Error('Could not reach the upload service. Check your connection.');
  }

  let data = null;

  try {
    data = await res.json();
  } catch {
    // handled below
  }

  if (data?.url && res.ok) return data.url;

  if (data?.error) throw new Error(data.error);

  if (res.status === 404 || res.ok) {
    throw new Error(
      'The upload service is not available here. It only runs on the deployed site.'
    );
  }

  throw new Error(`Upload failed (${res.status}). Try again.`);
}

export function uploadLogo(file) {
  return post('/api/upload', {
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
}

export function uploadMetadata(fields) {
  return post('/api/metadata', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}
