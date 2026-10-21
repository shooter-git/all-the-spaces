import { type CompressedTexture, LoadingManager, type WebGLRenderer } from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

/**
 * The Basis Universal transcoder built without JavaScript made from strings (see basis/README.md):
 * three.js's own needs 'unsafe-eval', which the app's Content-Security-Policy doesn't allow.
 * Bundled with the app's files (no CDN).
 */
const TRANSCODER: Record<string, string> = {
  'basis_transcoder.js': new URL('../basis/basis_transcoder.js', import.meta.url).href,
  'basis_transcoder.wasm': new URL('../basis/basis_transcoder.wasm', import.meta.url).href,
};
/** KTX2Loader asks for `<path>basis_transcoder.js` and `.wasm`; this path is only a name. */
const PATH = 'ats-basis-transcoder/';

/**
 * How long a downloaded KTX2 texture may take to decode (starting the transcoder included) before
 * it's given up. Decoding takes well under a second; only a transcoder that can't run (blocked,
 * crashed) takes longer, and KTX2Loader would then wait for it forever.
 */
export const DECODE_TIMEOUT_MS = 30_000;

/**
 * KTX2Loader whose decoding fails instead of hanging. When its transcoder's workers die (as under
 * a Content-Security-Policy they can't run in), three.js's loader never hears back, and a place
 * never finishes opening. Here the texture fails after `DECODE_TIMEOUT_MS`, saying why, and every
 * texture after it fails at once: the place opens without them.
 */
export class GuardedKTX2Loader extends KTX2Loader {
  private broken: Error | null = null;

  // Every downloaded file comes through here, including a second room's copy of a file that's
  // already decoding (KTX2Loader hands it the first one's task), and the download is done by then,
  // so a slow connection doesn't count against the timeout.
  override parse(
    buffer: ArrayBuffer,
    onLoad?: (texture: CompressedTexture) => void,
    onError?: (err: unknown) => void,
  ): void {
    if (this.broken) {
      onError?.(this.broken);
      return;
    }
    let settled = false;
    const settle = () => {
      const first = !settled;
      settled = true;
      clearTimeout(timer);
      return first;
    };
    const timer = setTimeout(() => {
      if (!settle()) return;
      if (!this.broken) {
        this.broken = new Error(
          `KTX2 textures couldn't be decoded: the Basis transcoder didn't answer within ${DECODE_TIMEOUT_MS / 1000} s`,
        );
        console.error(this.broken.message);
      }
      onError?.(this.broken);
    }, DECODE_TIMEOUT_MS);
    super.parse(
      buffer,
      (texture) => {
        if (settle()) onLoad?.(texture);
      },
      (err) => {
        if (settle()) onError?.(err);
      },
    );
  }
}

/**
 * Reads KTX2 textures into the compressed format this graphics card reads (ASTC, BC7, ETC2…),
 * so they stay compressed in its memory. Uncompressed only when the card reads none of them.
 */
export function ktx2Loader(renderer: WebGLRenderer): KTX2Loader {
  const manager = new LoadingManager();
  manager.setURLModifier((url) =>
    url.startsWith(PATH) ? (TRANSCODER[url.slice(PATH.length)] ?? url) : url,
  );
  return new GuardedKTX2Loader(manager).setTranscoderPath(PATH).detectSupport(renderer);
}
