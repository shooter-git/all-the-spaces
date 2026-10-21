import { LoadingManager, type WebGLRenderer } from 'three';
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
 * Reads KTX2 textures into the compressed format this graphics card reads (ASTC, BC7, ETC2…),
 * so they stay compressed in its memory. Uncompressed only when the card reads none of them.
 */
export function ktx2Loader(renderer: WebGLRenderer): KTX2Loader {
  const manager = new LoadingManager();
  manager.setURLModifier((url) =>
    url.startsWith(PATH) ? (TRANSCODER[url.slice(PATH.length)] ?? url) : url,
  );
  return new KTX2Loader(manager).setTranscoderPath(PATH).detectSupport(renderer);
}
