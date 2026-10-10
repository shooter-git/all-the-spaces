import { Button, Field, Notice, Section } from '@ats/ui';
import { useState } from 'react';
import { ChatSettings } from '../components/ChatSettings.tsx';
import { ColourSwatches, DEFAULT_GROUP_COLOUR } from '../components/ColourSwatches.tsx';
import { ManageLayout } from '../components/ManageLayout.tsx';
import { StudioSettings } from '../components/StudioSettings.tsx';
import type { Me } from '../lib/api.ts';
import { saveGroup } from '../lib/group.ts';

function NameAndColour({ me, onChanged }: { me: Me; onChanged: () => Promise<unknown> }) {
  const group = me.groups[0];
  const [name, setName] = useState(group?.groupName ?? '');
  const [color, setColor] = useState(group?.themeColor ?? DEFAULT_GROUP_COLOUR);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (!group) return null;
  const changed = name.trim() !== group.groupName || color !== group.themeColor;
  return (
    <Section title="Name and colour">
      <p className="ats-muted">
        What everyone sees at the top, and what the app is called when someone adds it to their home
        screen (those already added keep the old name until they add it again).
      </p>
      <Field
        label="Group name"
        value={name}
        maxLength={60}
        onChange={(e) => {
          setName(e.target.value);
          setState('idle');
        }}
      />
      <div className="ats-field">
        <span className="ats-label">Colour</span>
        <ColourSwatches
          name="group-color"
          value={color}
          onChange={(c) => {
            setColor(c);
            setState('idle');
          }}
        />
      </div>
      <div className="ats-row">
        <Button
          variant="primary"
          disabled={!changed || !name.trim() || state === 'saving'}
          onClick={async () => {
            setState('saving');
            setError(null);
            try {
              await saveGroup(group.groupId, { name: name.trim(), themeColor: color });
              await onChanged();
              setState('saved');
            } catch (e) {
              setError((e as Error).message);
              setState('idle');
            }
          }}
        >
          {state === 'saving' ? 'Saving…' : 'Save'}
        </Button>
        {state === 'saved' && <span className="ats-muted">Saved.</span>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

export function GroupSettings({ me, onChanged }: { me: Me; onChanged: () => Promise<unknown> }) {
  const group = me.groups[0];
  if (!group) return null;
  return (
    <ManageLayout
      me={me}
      title="Group settings"
      intro="How your group looks, how chat works, and how the Studio builds for everyone. Who may see each room is set per space, under Privacy."
    >
      <NameAndColour me={me} onChanged={onChanged} />
      <ChatSettings groupId={group.groupId} />
      <StudioSettings groupId={group.groupId} open />
    </ManageLayout>
  );
}
