import { matchMaker } from '@colyseus/core';

/**
 * Only the app's own pages may call the matchmaking routes from a browser. Colyseus otherwise
 * answers every origin with that origin, and allows credentials. (The app reaches them on its own
 * origin, through /rt, so it needs no CORS at all.)
 */
export function onlyFromApp(publicUrl: string) {
  const origin = new URL(publicUrl).origin;
  matchMaker.controller.getCorsHeaders = () => ({ 'Access-Control-Allow-Origin': origin });
}
