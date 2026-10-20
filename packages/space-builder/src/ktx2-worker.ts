// Encodes one texture to KTX2 (Basis Universal) per message, for ktx2.ts. Basis's encoder is
// WebAssembly that runs for a second or more a texture, so it runs here, off the main thread.
import { parentPort } from 'node:worker_threads';
import { encodeToKTX2 } from 'ktx2-encoder';
import type { EncodeJob } from './ktx2.ts';

// The encoder reports every mipmap it makes on stdout, debug or not; only its errors matter.
console.log = () => {};

parentPort?.on('message', async (job: EncodeJob) => {
  try {
    const bytes = await encodeToKTX2(job.rgba, {
      ...job.options,
      enableDebug: false,
      generateMipmap: true,
      imageDecoder: async () => ({ width: job.width, height: job.height, data: job.rgba }),
    });
    parentPort?.postMessage({ id: job.id, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    parentPort?.postMessage({ id: job.id, error: (err as Error).message });
  }
});
