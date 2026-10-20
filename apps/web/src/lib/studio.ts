import type { DeviceTest, FieldPerf, PlaceVisits, Studio } from '@ats/api-types';
import { api } from './api.ts';

export type {
  DeviceTest,
  FieldPerf,
  PlaceVisits,
  Studio,
  StudioBuild,
  StudioCreation,
  StudioVersion,
  StudioVersionConnector,
  VersionQa,
} from '@ats/api-types';

export const loadStudio = (spaceId: string) => api<Studio>(`/api/spaces/${spaceId}/studio`);

export const makeLive = (creationId: string, versionId: string) =>
  api(`/api/creations/${creationId}/versions/${versionId}/live`, { method: 'POST', json: {} });

/** Approves what a version uses of connectors (before making it live). */
export const approveConnectors = (
  creationId: string,
  versionId: string,
  connectors: { id: string; ops: string[] }[],
) =>
  api(`/api/creations/${creationId}/versions/${versionId}/connectors/approve`, {
    method: 'POST',
    json: { connectors },
  });

export const saveDeviceTest = (
  creationId: string,
  versionId: string,
  test: Omit<DeviceTest, 'at' | 'by'>,
) =>
  api(`/api/creations/${creationId}/versions/${versionId}/device-tests`, {
    method: 'POST',
    json: test,
  });

export const reportFile = (buildId: string, file: string) =>
  `/api/builds/${buildId}/report/${encodeURIComponent(file)}`;

/** "Smooth", "Mostly smooth" or "Struggles", from how long frames took. */
export function smoothness(p95Ms: number) {
  if (p95Ms <= 20) return { word: 'Smooth', tone: 'good' as const };
  if (p95Ms <= 34) return { word: 'Mostly smooth', tone: 'ok' as const };
  return { word: 'Struggles', tone: 'bad' as const };
}

/** "Phone · Android · Chrome": enough to tell devices apart, nothing identifying. */
export function describeDevice(): string {
  const ua = navigator.userAgent;
  const kind =
    /iPad|Tablet/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1)
      ? 'Tablet'
      : /Mobi|iPhone|Android/.test(ua)
        ? 'Phone'
        : 'Computer';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1)
      ? 'iOS'
      : /Mac/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Other';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${kind} · ${os} · ${browser}`;
}

export const loadFieldPerf = (spaceId: string) =>
  api<{ space: FieldPerf[]; creations: FieldPerf[] }>(`/api/spaces/${spaceId}/perf`);

/** Time people spent in each room and creation of a place, and each person's (Architects). */
export const loadVisits = (spaceId: string) => api<PlaceVisits>(`/api/spaces/${spaceId}/visits`);

/** Rows summed up per kind of device (phones, tablets, laptops), weighted by samples. */
export function byForm(rows: FieldPerf[]) {
  const forms = new Map<string, { samples: number; p95: number }>();
  for (const r of rows) {
    const form = r.device.split('-')[0] ?? 'other';
    const f = forms.get(form) ?? { samples: 0, p95: 0 };
    f.p95 = (f.p95 * f.samples + r.p95Ms * r.samples) / (f.samples + r.samples);
    f.samples += r.samples;
    forms.set(form, f);
  }
  const WORDS: Record<string, string> = { phone: 'Phones', tablet: 'Tablets', laptop: 'Computers' };
  return [...forms].map(([form, f]) => ({
    form: WORDS[form] ?? form,
    samples: f.samples,
    p95Ms: Math.round(f.p95),
    ...smoothness(f.p95),
  }));
}
