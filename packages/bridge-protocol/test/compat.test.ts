import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, readCreationMessage } from '../src/index.ts';
import connectorFixture from './fixtures/v1-connector-messages.json' with { type: 'json' };
import fixture from './fixtures/v1-creation-messages.json' with { type: 'json' };

// Creations already published keep working: whatever a version 1 creation sends, every host
// still accepts (see docs/protocol-compat.md). The fixture is frozen; never edit it.
const v1 = fixture as { messages: { v: number; msg: { type: string } }[] };

describe('protocol compatibility', () => {
  it('accepts every message a version 1 creation sends', () => {
    expect(v1.messages.length).toBeGreaterThan(0);
    for (const envelope of v1.messages) {
      expect(envelope.v).toBe(1);
      expect(readCreationMessage(envelope), envelope.msg.type).toEqual(envelope.msg);
    }
  });

  it('covers every message type a creation can send', () => {
    const types = new Set(v1.messages.map((e) => e.msg.type));
    for (const type of [
      'hello',
      'ready',
      'progress',
      'request-exit',
      'request-fullscreen',
      'save:get',
      'save:set',
      'mp:send',
      'mp:shared',
      'ui:toast',
      'ui:prefer-chat-minimized',
      'perf',
      'error',
      'pong',
    ])
      expect(types, type).toContain(type);
  });

  // Added within version 1 (SDK 0.2.0): connectors. Frozen the same way.
  it('accepts every connector message a creation sends', () => {
    const added = connectorFixture as { messages: { v: number; msg: { type: string } }[] };
    const types = new Set(added.messages.map((e) => e.msg.type));
    for (const type of ['connector:call', 'connector:status', 'connector:link'])
      expect(types, type).toContain(type);
    for (const envelope of added.messages) {
      expect(envelope.v).toBe(1);
      expect(readCreationMessage(envelope), envelope.msg.type).toEqual(envelope.msg);
    }
  });

  it('only ever moves forward', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });
});
