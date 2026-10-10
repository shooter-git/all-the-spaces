// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assistant } from '../src/lib/workbench.ts';
import { AssistantCard } from '../src/routes/Assistants.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/lib/workbench.ts', () => ({ assistantAction: async () => ({}) }));
vi.mock('../src/components/Terminal.tsx', () => ({ Terminal: () => null }));

const codex: Assistant = {
  provider: 'codex',
  name: 'Codex',
  vendor: 'OpenAI',
  version: '0.159.3',
  installed: true,
  installedVersion: '0.159.3',
  signedIn: true,
};

describe('an assistant on the Assistants page', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const show = (a: Assistant) =>
    act(() =>
      root.render(
        <MemoryRouter>
          <AssistantCard
            assistant={a}
            active={false}
            onActivate={() => {}}
            onChanged={async () => {}}
            disabled={false}
          />
        </MemoryRouter>,
      ),
    );
  const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent?.trim());

  it('shows one installed and signed in as connected', () => {
    show(codex);
    expect(host.textContent).toContain('Connected · version 0.159.3');
    expect(buttons()).toContain('Reinstall');
  });

  it('asks for an install that no longer counts (an earlier Codex) to be made again', () => {
    show({ ...codex, installed: false });
    expect(host.textContent).toContain('Needs installing again');
    expect(host.textContent).toContain('Your sign-in stays.');
    expect(host.textContent).not.toContain('Connected');
    expect(buttons()).toEqual(['Install Codex again']);
  });

  it('offers a first install to one never installed', () => {
    show({ ...codex, installed: false, installedVersion: null, signedIn: false });
    expect(host.textContent).toContain('Not connected');
    expect(host.textContent).not.toContain('again');
    expect(buttons()).toEqual(['Install Codex']);
  });
});
