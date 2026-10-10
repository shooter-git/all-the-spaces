import { ApiError } from './api.ts';

/** Downloads (served as files: a plain link starts them). */
export const placeExportUrl = (spaceId: string) => `/api/spaces/${spaceId}/export`;
export const creationExportUrl = (creationId: string) => `/api/creations/${creationId}/export`;

/** Sends an exported file (.atspace, .atcreation) to be imported. Never retried: once is enough. */
export async function importFile<T>(url: string, file: File): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/zip' },
      body: file,
    });
  } catch {
    throw new ApiError('The connection dropped while sending it. Try again.', 0);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok)
    throw new ApiError(
      res.status === 413
        ? 'That file is too big to import.'
        : (body.error ?? 'That file couldn’t be imported.'),
      res.status,
    );
  return body as T;
}
