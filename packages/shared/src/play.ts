/**
 * How creations are served on the play origin. The server and the QA runner both use these, so
 * a creation is checked under exactly the rules it will live under.
 */

/** The file types a creation may contain, and how they're served. */
export const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  ktx2: 'image/ktx2',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin: 'application/octet-stream',
  hdr: 'image/vnd.radiance',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
};

export const typeOf = (path: string): string | undefined =>
  CONTENT_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];

/** A safe relative path inside a bundle. */
export function isBundlePath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith('/') &&
    path.split('/').every((p) => p !== '' && p !== '.' && p !== '..') &&
    /^[\w.@/ +-]+$/.test(path)
  );
}

/**
 * Headers for one of a creation's files. `base` is the creation's own folder on the play origin
 * (ending in `/`); `appOrigin` is the only page allowed to show it.
 */
export function playHeaders(type: string, base: string, appOrigin: string): Record<string, string> {
  return {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // The frame has an opaque origin, so its module scripts are cross-origin requests.
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'referrer-policy': 'no-referrer',
    'content-security-policy': [
      // An opaque origin: no cookies, storage or access to the app, whatever the page does.
      'sandbox allow-scripts allow-pointer-lock',
      "default-src 'none'",
      // Only this creation's own files — not even other creations on the same origin.
      `script-src ${base} blob: 'wasm-unsafe-eval'`,
      'worker-src blob:',
      `connect-src ${base} blob: data:`,
      `img-src ${base} blob: data:`,
      `media-src ${base} blob: data:`,
      `font-src ${base} data:`,
      `style-src ${base} 'unsafe-inline'`,
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${appOrigin}`,
    ].join('; '),
  };
}
