import type { MaterialName } from '@ats/space-format';

export interface MaterialDef {
  color: string;
  roughness: number;
  metalness?: number;
  opacity?: number;
}

// A calm, natural palette in keeping with the brand: plaster, oak, linen, indigo, moss.
export const MATERIALS: Record<MaterialName, MaterialDef> = {
  plaster: { color: '#ece7de', roughness: 0.92 },
  'plaster-warm': { color: '#e8dccb', roughness: 0.92 },
  'paint-sage': { color: '#c9d1bd', roughness: 0.9 },
  'paint-sky': { color: '#cfdae4', roughness: 0.9 },
  oak: { color: '#b8946a', roughness: 0.6 },
  walnut: { color: '#6e5040', roughness: 0.55 },
  'tile-light': { color: '#dcd8d0', roughness: 0.35 },
  'tile-dark': { color: '#4a4a4f', roughness: 0.4 },
  concrete: { color: '#a9a69f', roughness: 0.95 },
  'carpet-stone': { color: '#b5ada1', roughness: 1 },
  'fabric-linen': { color: '#ddd3c3', roughness: 0.95 },
  'fabric-indigo': { color: '#3f5b7c', roughness: 0.9 },
  'fabric-moss': { color: '#7d8a68', roughness: 0.9 },
  'metal-dark': { color: '#2e2c33', roughness: 0.4, metalness: 0.6 },
  ceramic: { color: '#e9e4db', roughness: 0.3 },
  leaf: { color: '#5f7a4f', roughness: 0.8 },
  paper: { color: '#f5f1ee', roughness: 0.9 },
  glass: { color: '#dfe9ef', roughness: 0.05, opacity: 0.25 },
  trim: { color: '#f1eee8', roughness: 0.45 },
};

export function hexToLinear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const lin = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return [lin[0] ?? 0, lin[1] ?? 0, lin[2] ?? 0];
}
