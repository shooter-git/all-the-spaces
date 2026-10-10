import {
  Avatar,
  Button,
  Confirm,
  Icon,
  IconButton,
  List,
  ListRow,
  Notice,
  Section,
  Segmented,
  Tag,
} from '@ats/ui';
import { useCallback, useEffect, useState } from 'react';
import { ManageLayout } from '../components/ManageLayout.tsx';
import type { Me } from '../lib/api.ts';
import {
  type InviteLink,
  loadInvites,
  loadPeople,
  makeInvite,
  type Person,
  removePerson,
  setRole,
  turnOffInvite,
  usableInvite,
  when,
} from '../lib/group.ts';

function InviteSection({ groupId, groupName }: { groupId: string; groupName: string }) {
  const [role, setInviteRole] = useState<InviteLink['role']>('member');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [links, setLinks] = useState<InviteLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    () => loadInvites(groupId).then(setLinks, (e: Error) => setError(e.message)),
    [groupId],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    setError(null);
    setCopied(false);
    try {
      setLink((await makeInvite(groupId, role)).url);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      () => setError('Couldn’t copy it here: select the link and copy it yourself.'),
    );
  };
  const share = () =>
    link &&
    navigator
      .share({
        title: `Join ${groupName}`,
        text: `You're invited to ${groupName} on All the Spaces.`,
        url: link,
      })
      .catch(() => {});
  const live = (links ?? []).filter(usableInvite);

  return (
    <Section title="Invite people">
      <p className="ats-muted">
        Send a link however you like. It works for 7 days, for everyone you send it to.
      </p>
      <div className="invite-make">
        <Segmented
          label="They join as"
          value={role}
          onChange={(r) => {
            setInviteRole(r);
            setLink(null);
          }}
          options={[
            { value: 'member', label: 'Members' },
            { value: 'architect', label: 'Architects', icon: 'architect' },
          ]}
        />
        <Button variant="primary" onClick={create}>
          <Icon name="link" size={16} />
          Make a link
        </Button>
      </div>
      {link && (
        <div className="invite-link">
          <input
            className="ats-input"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Invite link"
          />
          <IconButton icon={copied ? 'check' : 'copy'} label="Copy the link" onClick={copy} />
          {'share' in navigator && (
            <IconButton icon="share" label="Share the link" onClick={share} />
          )}
        </div>
      )}
      {copied && (
        <p className="ats-muted invite-copied">Copied. Paste it wherever you're sending it.</p>
      )}
      {live.length > 0 && (
        <div className="invite-live">
          <h3>Links that still work</h3>
          <List>
            {live.map((i) => (
              <ListRow
                key={i.id}
                lead={<Icon name="link" />}
                title={`For ${i.role === 'architect' ? 'Architects' : 'members'}${i.label ? ` · ${i.label}` : ''}`}
                meta={`Used ${i.uses} time${i.uses === 1 ? '' : 's'} · works until ${when(i.expiresAt)}`}
                actions={
                  <IconButton
                    icon="unlink"
                    tone="danger"
                    label="Turn this link off"
                    onClick={async () => {
                      await turnOffInvite(groupId, i.id).catch((e: Error) => setError(e.message));
                      await refresh();
                    }}
                  />
                }
              />
            ))}
          </List>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

function PersonRow({
  person: p,
  groupId,
  architects,
  onChanged,
}: {
  person: Person;
  groupId: string;
  architects: number;
  onChanged: () => Promise<unknown>;
}) {
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  // The last Architect stays one: someone has to look after the group.
  const onlyArchitect = p.role === 'architect' && architects <= 1;

  return (
    <ListRow
      lead={<Avatar name={p.name} color={p.color} />}
      title={p.name}
      tag={p.you ? <Tag>You</Tag> : undefined}
      meta={`${p.email}${p.emailConfirmed === false ? ' (not confirmed yet)' : ''} · joined ${when(p.joinedAt)} · last here ${when(p.lastSeenAt)}`}
      actions={
        <>
          <select
            className="ats-input"
            aria-label={`${p.name}: role`}
            value={p.role}
            disabled={busy || onlyArchitect}
            title={onlyArchitect ? 'A group needs at least one Architect.' : undefined}
            onChange={(e) =>
              void run(() => setRole(groupId, p.userId, e.target.value as Person['role']))
            }
          >
            <option value="architect">Architect</option>
            <option value="member">Member</option>
          </select>
          {p.you ? (
            <span className="people-spacer" />
          ) : (
            <IconButton
              icon="trash"
              tone="danger"
              label={`Remove ${p.name} from the group`}
              disabled={removing}
              onClick={() => setRemoving(true)}
            />
          )}
        </>
      }
    >
      {removing && (
        <Confirm
          confirm={`Remove ${p.name}`}
          cancel="Keep them"
          busy={busy}
          onConfirm={() => void run(() => removePerson(groupId, p.userId))}
          onCancel={() => setRemoving(false)}
        >
          They leave any space or creation they're in straight away, and rooms shared with them
          aren't any more. Their account stays, so you can invite them back.
        </Confirm>
      )}
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
    </ListRow>
  );
}

export function People({ me }: { me: Me }) {
  const group = me.groups[0];
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    () =>
      group
        ? loadPeople(group.groupId).then(
            (r) => setPeople(r.people),
            (e: Error) => setError(e.message),
          )
        : Promise.resolve(),
    [group],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!group) return null;
  const architects = people?.filter((p) => p.role === 'architect').length ?? 0;

  return (
    <ManageLayout
      me={me}
      title="People"
      intro="Architects build spaces and creations and look after the group. Members walk around, chat and ask for things."
    >
      <Section title={people ? `In ${group.groupName} · ${people.length}` : 'In the group'}>
        {error && <Notice tone="error">{error}</Notice>}
        {people && (
          <List label="People in the group">
            {people.map((p) => (
              <PersonRow
                key={p.userId}
                person={p}
                groupId={group.groupId}
                architects={architects}
                onChanged={refresh}
              />
            ))}
          </List>
        )}
      </Section>
      <InviteSection groupId={group.groupId} groupName={group.groupName} />
    </ManageLayout>
  );
}
