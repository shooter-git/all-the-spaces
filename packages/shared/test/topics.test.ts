import { describe, expect, it } from 'vitest';
import { canSeeRoom, type SpaceAccess } from '../src/topics.ts';

describe('canSeeRoom', () => {
  const access: SpaceAccess = {
    architects: ['arch'],
    members: ['arch', 'member', 'friend'],
    rooms: {
      lobby: { visibility: 'group', users: [] },
      den: { visibility: 'limited', users: ['friend', 'outsider'] },
      vault: { visibility: 'hidden', users: [] },
    },
  };

  it('follows each room’s visibility for members', () => {
    expect(canSeeRoom(access, 'member', 'lobby')).toBe(true);
    expect(canSeeRoom(access, 'member', 'den')).toBe(false);
    expect(canSeeRoom(access, 'friend', 'den')).toBe(true);
    expect(canSeeRoom(access, 'arch', 'vault')).toBe(true);
    expect(canSeeRoom(access, 'member', 'unlisted')).toBe(false);
  });

  it('shows nothing to someone outside the group, whole-group rooms included', () => {
    expect(canSeeRoom(access, 'outsider', 'lobby')).toBe(false);
    expect(canSeeRoom(access, 'outsider', 'den')).toBe(false);
  });
});
