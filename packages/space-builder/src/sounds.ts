import type { PlanFurniture, Room, SpacePlan } from '@ats/space-format';
import type { V3 } from './geometry.ts';

const WORKPLACE_ROOM = /office|studio|work|desk|reception|meeting|conference/i;
const CAFE_ROOM = /caf[eé]|coffee|kitchen|bar|canteen|pantry/i;

/**
 * Everyday sounds a room should have, from what's in it: typing and clicks at desks where people
 * work, the odd chair creak, cups at a café counter. Homes stay quiet — an empty desk at home
 * shouldn't type by itself.
 */
export function roomSounds(
  plan: SpacePlan,
  room: SpacePlan['rooms'][number],
  items: { item: PlanFurniture; position: V3 }[],
): Room['sounds'] {
  const workplace =
    plan.spaceType === 'office' ||
    (plan.spaceType === 'building' && WORKPLACE_ROOM.test(room.name)) ||
    WORKPLACE_ROOM.test(room.name);
  const cafe = CAFE_ROOM.test(room.name);
  const sounds: Room['sounds'] = [];
  const at = (p: V3, height: number): V3 => [p[0], p[1] + height, p[2]];
  for (const { item, position } of items) {
    if (workplace && item.kind === 'desk') {
      sounds.push({ kind: 'typing', position: at(position, 0.78) });
      sounds.push({ kind: 'mouse', position: at(position, 0.76) });
    }
    if (workplace && item.kind === 'chair')
      sounds.push({ kind: 'chair', position: at(position, 0.4) });
    if (cafe && item.kind === 'counter')
      sounds.push({ kind: 'cups', position: at(position, 0.95) });
  }
  return sounds;
}
