// Version 2 saves your visits as an object, and upgrades what version 1 saved.
import { connect } from '@allthespaces/portal';

interface Visits {
  count: number;
  upgradedFrom?: number;
}
const portal = await connect({
  save: {
    version: 2,
    migrate: (old, from) =>
      from === 1 && typeof old === 'number' ? { count: old, upgradedFrom: 1 } : old,
  },
});
const count = document.querySelector('#count') as HTMLElement;
const visits = (await portal.save.personal.get<Visits>('visits')) ?? { count: 0 };
const next: Visits = { ...visits, count: visits.count + 1 };
await portal.save.personal.set('visits', next as unknown as import('@allthespaces/portal').Json);
count.textContent = `Visits: ${next.count}${next.upgradedFrom ? ` (upgraded from version ${next.upgradedFrom})` : ''}`;
portal.ready();
