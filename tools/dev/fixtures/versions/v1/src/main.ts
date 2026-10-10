// Version 1 saves your visits as a plain number.
import { connect } from '@allthespaces/portal';

const portal = await connect({ save: { version: 1 } });
const count = document.querySelector('#count') as HTMLElement;
const status = document.querySelector('#status') as HTMLElement;
let visits = ((await portal.save.personal.get<number>('visits')) ?? 0) + 1;
await portal.save.personal.set('visits', visits);
count.textContent = `Visit ${visits}`;
(document.querySelector('#again') as HTMLElement).addEventListener('click', async () => {
  try {
    visits++;
    await portal.save.personal.set('visits', visits);
    status.textContent = 'Saved';
  } catch (err) {
    status.textContent = `Not saved: ${(err as Error).message}`;
  }
});
portal.ready();
