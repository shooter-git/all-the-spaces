import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onlyFromApp } from '../src/cors.ts';
import { listenOnFreePort } from './helpers.ts';

const APP = 'https://spaces.example.test';
let server: Server;
let port = 0;

beforeAll(async () => {
  onlyFromApp(`${APP}/some/page`);
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await server?.gracefullyShutdown(false);
});

describe("the real-time service's HTTP routes", () => {
  it('allow only the app as a cross-origin caller', async () => {
    for (const origin of ['https://evil.example', APP]) {
      const res = await fetch(`http://127.0.0.1:${port}/matchmake/joinOrCreate/space`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(res.headers.get('access-control-allow-origin'), origin).toBe(APP);
    }
  });
});
