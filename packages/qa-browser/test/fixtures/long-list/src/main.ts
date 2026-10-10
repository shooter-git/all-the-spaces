// A list of forty pages that scrolls (reachable, so not cut off), and one button really off the
// edge of the screen, for testing the layout check.
import { connect } from '@allthespaces/portal';

const portal = await connect();
document.body.style.cssText = 'margin: 0; height: 100vh; overflow: hidden; font: 16px sans-serif';
const list = document.createElement('div');
list.style.cssText =
  'position: absolute; top: 80px; left: 16px; right: 16px; height: 50vh; overflow-y: auto';
for (let i = 1; i <= 40; i++) {
  const b = document.createElement('button');
  b.textContent = `Page ${i}`;
  b.style.cssText = 'display: block; width: 100%; height: 56px';
  list.append(b);
}
const lost = document.createElement('button');
lost.textContent = 'Off the edge';
lost.style.cssText = 'position: absolute; bottom: 24px; right: -80px; width: 160px; height: 56px';
document.body.append(list, lost);
portal.ready();
