// Asks a worker (`?worker&inline`, the one kind the sealed frame allows) to square a number, and
// is ready only once it answers, for testing that workers start inside the frame.
import { connect } from '@allthespaces/portal';
import Squares from './squares.ts?worker&inline';

const portal = await connect();
const worker = new Squares();
const answer = await new Promise<number>((resolve, reject) => {
  worker.onmessage = (e: MessageEvent<number>) => resolve(e.data);
  worker.onerror = () => reject(new Error("The inline worker didn't start"));
  worker.postMessage(12);
});
document.body.style.cssText =
  'margin: 0; display: grid; place-items: center; height: 100vh; font: 48px sans-serif';
document.body.textContent = `12 × 12 = ${answer}`;
portal.ready();
