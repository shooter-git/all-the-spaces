import { Button, Notice } from '@ats/ui';
import { useCallback, useEffect, useState } from 'react';
import { ManageLayout } from '../components/ManageLayout.tsx';
import type { Me } from '../lib/api.ts';
import { type ActivityEntry, loadActivity } from '../lib/group.ts';

const VISIBILITY: Record<string, string> = {
  group: 'everyone',
  limited: 'chosen people',
  hidden: 'only Architects',
};

/** One line in plain words: "Pat made Sam an Architect". */
function describe(e: ActivityEntry): string {
  const who = e.actor?.name ?? 'The server';
  const it = e.about ? `“${e.about}”` : 'something since removed';
  const d = e.details;
  switch (e.action) {
    case 'setup.completed':
      return `${who} set up All the Spaces`;
    case 'member.joined':
      return `${who} joined the group`;
    case 'member.role_changed':
      return `${who} made ${e.about ?? 'someone'} ${d.role === 'architect' ? 'an Architect' : 'a member'}`;
    case 'member.removed':
      return `${who} removed ${(d.name as string | null) ?? e.about ?? 'someone'} from the group`;
    case 'group.changed':
      return `${who} changed the group’s ${d.name ? 'name' : 'colour'}${d.name ? ` to “${d.name}”` : ''}`;
    case 'invite.created':
      return `${who} made an invite link for ${d.role === 'architect' ? 'Architects' : 'members'}`;
    case 'invite.revoked':
      return `${who} turned off an invite link`;
    case 'room.visibility_changed':
      return `${who} let ${VISIBILITY[d.visibility as string] ?? 'others'} see the room “${e.room ?? '?'}” in ${it}`;
    case 'place.created':
      return `${who} started setting up a place`;
    case 'place.built':
      return `${who} built a new version of ${it}`;
    case 'place.published':
      return `${who} published ${it}`;
    case 'place.reverted':
      return `${who} went back to an earlier version of ${it}`;
    case 'place.discarded':
      return `${who} removed “${(d.name as string | undefined) ?? 'a place'}”`;
    case 'place.exported':
      return `${who} downloaded ${it} to move it to another server`;
    case 'place.imported':
      return `${who} imported ${it} from another server`;
    case 'creation.exported':
      return `${who} downloaded the creation ${it}`;
    case 'creation.imported':
      return `${who} imported the creation ${it}`;
    case 'connector.approved':
      return `${who} let ${it} use ${((d.connectors as { id: string }[] | undefined) ?? []).map((c) => c.id).join(', ') || 'a connected service'}`;
    case 'connector.called':
      return `${who} used ${(d.connector as string | undefined) ?? 'a connected service'} (${(d.op as string | undefined) ?? '?'}) in ${it}`;
    case 'space.sample_added':
      return `${who} added a sample space`;
    case 'request.created':
      return `${who} asked for something new`;
    case 'request.accepted':
      return `${who} took on a request`;
    case 'request.declined':
      return `${who} declined a request`;
    case 'workspace.created':
      return `${who} opened a Studio workspace${e.about ? ` for ${it}` : ''}`;
    case 'workspace.published':
      return `${who} made ${it} live`;
    case 'workspace.deleted':
      return `${who} deleted the Studio workspace${e.about ? ` ${it}` : ''}`;
    case 'assistant.installed':
      return `${who} installed or updated an AI assistant`;
    case 'connect.forget':
      return `${who} disconnected an AI assistant`;
    case 'chat.settings_changed':
      return `${who} changed the chat settings`;
    case 'chat.reported':
      return `${who} reported a chat message`;
    case 'studio.settings':
      return `${who} changed the Studio settings`;
    case 'backup.settings_changed':
      return `${who} changed the backup settings`;
    case 'server.sources_changed':
      return `${who} changed which repositories creations may come from`;
    case 'server.owner_changed':
      return `${e.about ?? 'Someone'} became the server’s owner`;
    default:
      return `${who}: ${e.action.replace(/[._]/g, ' ')}`;
  }
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function Activity({ me }: { me: Me }) {
  const group = me.groups[0];
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (before?: string) => {
      if (!group) return;
      try {
        const r = await loadActivity(group.groupId, { ...(before ? { before } : {}), all });
        setEntries((old) => (before ? [...(old ?? []), ...r.entries] : r.entries));
        setMore(r.more);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [group, all],
  );
  useEffect(() => {
    void load();
  }, [load]);

  let lastDay = '';
  return (
    <ManageLayout
      me={me}
      title="Activity"
      intro="Who did what in your group, newest first. Nothing anyone types to an assistant or in a terminal is ever recorded."
    >
      <label className="studio-check">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        Include housekeeping (opening workspaces, checks, previews)
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      {entries?.length === 0 && <p className="ats-muted">Nothing has happened yet.</p>}
      <div>
        {entries?.map((e) => {
          const d = day(e.at);
          const heading = d !== lastDay ? <h2 className="activity-day">{d}</h2> : null;
          lastDay = d;
          return (
            <div key={e.id}>
              {heading}
              <p className="activity-entry">
                <time dateTime={e.at}>{time(e.at)}</time>
                <span>{describe(e)}</span>
              </p>
            </div>
          );
        })}
      </div>
      {more && entries && (
        <div style={{ marginTop: 'var(--ats-space-4)' }}>
          <Button onClick={() => void load(entries[entries.length - 1]?.at)}>Show older</Button>
        </div>
      )}
    </ManageLayout>
  );
}
