import { Icon, type IconName, Notice, Section, Segmented } from '@ats/ui';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { BackLink } from '../components/BackLink.tsx';
import { api } from '../lib/api.ts';
import './privacy.css';

type Visibility = 'group' | 'limited' | 'hidden';

interface RoomRow {
  key: string;
  name: string;
  floor: string;
  visibility: Visibility;
  people: string[];
  /** Who may ask for things in it. */
  requests: 'anyone' | 'owner' | 'architects';
  ownerId: string | null;
}

interface Person {
  id: string;
  name: string;
  role: 'architect' | 'member';
}

const OPTIONS: { value: Visibility; label: string; icon: IconName }[] = [
  { value: 'group', label: 'Everyone', icon: 'people' },
  { value: 'limited', label: 'Chosen', icon: 'account' },
  { value: 'hidden', label: 'Architects', icon: 'lock' },
];

/** Architects choose who can see each room of a space. */
export function RoomPrivacy() {
  const { spaceId } = useParams();
  const [rooms, setRooms] = useState<RoomRow[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, 'saving' | 'saved' | 'failed'>>({});

  useEffect(() => {
    api<{ rooms: RoomRow[]; people: Person[] }>(`/api/spaces/${spaceId}/rooms`).then(
      (r) => {
        setRooms(r.rooms);
        setPeople(r.people);
      },
      (e: Error) => setError(e.message),
    );
  }, [spaceId]);

  const save = async (
    room: RoomRow,
    change: Partial<Pick<RoomRow, 'visibility' | 'people' | 'requests' | 'ownerId'>>,
  ) => {
    const next = { ...room, ...change };
    setRooms((rs) => rs?.map((r) => (r.key === room.key ? next : r)) ?? null);
    setSaving((s) => ({ ...s, [room.key]: 'saving' }));
    try {
      await api(`/api/spaces/${spaceId}/rooms/${encodeURIComponent(room.key)}`, {
        method: 'PUT',
        json: {
          visibility: next.visibility,
          people: next.people,
          requests: next.requests,
          ownerId: next.ownerId,
        },
      });
      setSaving((s) => ({ ...s, [room.key]: 'saved' }));
    } catch {
      setSaving((s) => ({ ...s, [room.key]: 'failed' }));
    }
  };

  const members = people.filter((p) => p.role !== 'architect');
  const floors = [...new Set(rooms?.map((r) => r.floor) ?? [])];

  return (
    <main className="ats-screen">
      <div className="ats-container ats-stack studio-wide">
        <header className="ats-stack" style={{ gap: 6 }}>
          <div>
            <BackLink to="/" label="Your spaces" />
          </div>
          <h1>Who can see each room</h1>
          <p className="ats-muted">
            People only see the rooms shared with them. Doors to other rooms stay closed, and
            nothing about those rooms — not even their names — reaches their devices. Changes apply
            straight away.
          </p>
        </header>

        {error && <Notice tone="error">{error}</Notice>}
        {!rooms && !error && <p className="ats-muted">Loading…</p>}

        {floors.map((floor) => (
          <Section key={floor} title={floors.length > 1 ? floor : 'Rooms'}>
            <ul className="privacy-rooms">
              {rooms
                ?.filter((r) => r.floor === floor)
                .map((room) => (
                  <li key={room.key} className="privacy-room">
                    <div className="privacy-room-name">
                      <strong>{room.name}</strong>
                      <span className="privacy-status" aria-live="polite">
                        {saving[room.key] === 'saving' ? (
                          'Saving…'
                        ) : saving[room.key] === 'saved' ? (
                          <>
                            <Icon name="check" size={14} /> Saved
                          </>
                        ) : saving[room.key] === 'failed' ? (
                          'Not saved: try again'
                        ) : (
                          ''
                        )}
                      </span>
                    </div>
                    <Segmented
                      label={`Who can see ${room.name}`}
                      value={room.visibility}
                      options={OPTIONS}
                      onChange={(v) => save(room, { visibility: v })}
                    />
                    {room.visibility !== 'hidden' ? (
                      <select
                        className="ats-input privacy-asks"
                        aria-label={`Who can ask for things in ${room.name}`}
                        value={room.requests}
                        onChange={(e) =>
                          save(room, { requests: e.target.value as RoomRow['requests'] })
                        }
                      >
                        <option value="anyone">Anyone there can ask</option>
                        <option value="owner">Only its owner asks</option>
                        <option value="architects">Only Architects ask</option>
                      </select>
                    ) : (
                      <span className="privacy-asks privacy-asks--none">Only Architects ask</span>
                    )}
                    {room.visibility === 'limited' && (
                      <div className="privacy-more">
                        <span className="privacy-more-label">Who can see it</span>
                        {members.length === 0 ? (
                          <span className="ats-muted">
                            Nobody else has joined yet. Invite people from People.
                          </span>
                        ) : (
                          members.map((p) => (
                            <label key={p.id} className="privacy-person">
                              <input
                                type="checkbox"
                                checked={room.people.includes(p.id)}
                                onChange={(e) =>
                                  save(room, {
                                    people: e.target.checked
                                      ? [...room.people, p.id]
                                      : room.people.filter((id) => id !== p.id),
                                  })
                                }
                              />
                              {p.name}
                            </label>
                          ))
                        )}
                      </div>
                    )}
                    {room.visibility !== 'hidden' && room.requests === 'owner' && (
                      <div className="privacy-more">
                        <label className="privacy-more-label" htmlFor={`owner-${room.key}`}>
                          Whose room is it?
                        </label>
                        <select
                          id={`owner-${room.key}`}
                          className="ats-input privacy-owner"
                          value={room.ownerId ?? ''}
                          onChange={(e) => save(room, { ownerId: e.target.value || null })}
                        >
                          <option value="">Nobody's (so only Architects)</option>
                          {people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          </Section>
        ))}
        {rooms && (
          <p className="ats-muted" style={{ fontSize: '0.9rem' }}>
            Architects always see every room, and can ask for things anywhere. Anyone who can see
            something can tell the Architects when it's not working.
          </p>
        )}
      </div>
    </main>
  );
}
