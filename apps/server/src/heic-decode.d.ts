declare module 'heic-decode' {
  /** Decodes the main image of a HEIC file to RGBA pixels. */
  export default function decode(input: {
    buffer: ArrayBufferLike | Uint8Array;
  }): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}
