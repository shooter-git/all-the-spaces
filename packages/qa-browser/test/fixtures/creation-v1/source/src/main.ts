import { connect } from '@allthespaces/portal';

// A creation as published with SDK 0.1.0 (protocol 1): it says hello, shows progress, reads and
// writes a personal save, shows a toast and says it's ready.
const portal = await connect({ save: { version: 1 } });
portal.progress(0.5, 'Counting visits');
const visits = ((await portal.save.personal.get<number>('visits')) ?? 0) + 1;
await portal.save.personal.set('visits', visits);
const app = document.querySelector('#app') as HTMLElement;
const line = document.createElement('p');
line.textContent = `Hello, ${portal.me.name}: visit ${visits}`;
app.append(line);
portal.ui.toast(`Visit ${visits}`);
portal.ready();
