import type { Me, Sent } from '@ats/api-types';
import { schema } from '@ats/db';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { getSession, membershipsFor } from '../session.ts';

const DEFAULT_NAME = 'All the Spaces';
const DEFAULT_THEME = '#F5F1EE';

/** Home-screen labels get cut off beyond ~12 characters. */
export function shortName(name: string): string {
  if (name === DEFAULT_NAME) return 'Spaces';
  const trimmed = name.replace(/^the\s+/i, '');
  if (trimmed.length <= 12) return trimmed;
  return trimmed.split(/\s+/)[0]?.slice(0, 12) ?? trimmed.slice(0, 12);
}

export async function metaRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get('/api/health', async () => {
    await db.execute('select 1');
    return { ok: true };
  });

  app.get('/api/me', async (req): Promise<Sent<Me>> => {
    const session = await getSession(ctx, req);
    if (!session) return { user: null, groups: [] };
    const { id, name, email, image } = session.user;
    return { user: { id, name, email, image }, groups: await membershipsFor(db, id) };
  });

  // The installable app takes the group's name and colour ("The Smith House" on a home screen).
  app.get('/manifest.webmanifest', async (_req, reply) => {
    const [group] = await db
      .select({ name: schema.groups.name, themeColor: schema.groups.themeColor })
      .from(schema.groups)
      .orderBy(asc(schema.groups.createdAt))
      .limit(1);
    const name = group?.name ?? DEFAULT_NAME;
    const theme = group?.themeColor ?? DEFAULT_THEME;
    reply.header('content-type', 'application/manifest+json').header('cache-control', 'no-cache');
    return {
      id: '/',
      name,
      short_name: shortName(name),
      description: group
        ? `${name}, a shared space on All the Spaces`
        : 'Shared spaces where real objects become portals.',
      start_url: '/',
      scope: '/',
      // The status bar stays on the app's pages; a space goes full screen by itself (SpaceView).
      display: 'standalone',
      orientation: 'any',
      theme_color: theme,
      background_color: '#F5F1EE',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        {
          src: '/icons/maskable-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
        {
          src: '/icons/monochrome-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'monochrome',
        },
      ],
      screenshots: [
        {
          src: '/icons/screenshot-portrait.png',
          sizes: '1080x1920',
          type: 'image/png',
          form_factor: 'narrow',
        },
        {
          src: '/icons/screenshot-landscape.png',
          sizes: '1920x1080',
          type: 'image/png',
          form_factor: 'wide',
        },
      ],
    };
  });
}
