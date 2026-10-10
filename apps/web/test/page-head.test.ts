import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { absoluteOgImage } from '../vite.config.ts';

// Tests run from apps/web.
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

describe('the built page', () => {
  it("gives link previews the picture's full address (Caddy fills in the host)", () => {
    const plugin = absoluteOgImage();
    const transform = plugin.transformIndexHtml as (html: string) => string;
    const built = transform(html);
    expect(built).toContain(
      '<meta property="og:image" content="https://{{.Host}}/icons/og-image.png" />',
    );
    expect(built).not.toContain('content="/icons/og-image.png"');
    expect(plugin.apply).toBe('build');
  });

  it("doesn't link its source maps (made for debugging, never downloaded)", () => {
    const resolved =
      typeof config === 'function' ? config({ mode: 'production', command: 'build' }) : config;
    expect((resolved as { build?: { sourcemap?: unknown } }).build?.sourcemap).toBe('hidden');
  });
});
