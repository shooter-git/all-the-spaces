// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ColourSwatches } from '../src/components/ColourSwatches.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the group's colour", () => {
  it('is offered by name, not by hex code', () => {
    const picked = vi.fn();
    const box = document.createElement('div');
    const root = createRoot(box);
    act(() => root.render(<ColourSwatches name="c" value="#D3DDE8" onChange={picked} />));
    const radios = [...box.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Sky',
      'Moss',
      'Stone',
      'Silk',
      'Indigo mist',
      'Sakura',
    ]);
    expect(radios[0]?.checked).toBe(true);
    act(() => radios[5]?.click());
    expect(picked).toHaveBeenCalledWith('#E6C3C9');
    act(() => root.unmount());
  });
});
