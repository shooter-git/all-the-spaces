import { Button, Field, Icon, IconButton, Notice, Section } from '@ats/ui';
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { BackLink } from '../components/BackLink.tsx';
import { isPdf, pdfPages } from '../lib/pdf.ts';
import {
  createPlace,
  inputUrl,
  listInputs,
  type PlaceInput,
  removeInput,
  type SpaceType,
  startPlaceWorkspace,
  uploadInput,
  uploadPack,
} from '../lib/places.ts';
import { type Assistant, loadAssistants, type Provider } from '../lib/workbench.ts';
import './studio.css';
import {
  AssistantPicker,
  type Picked,
  useAssistantDefaults,
} from '../components/AssistantPicker.tsx';

const TYPES: { value: SpaceType; label: string }[] = [
  { value: 'apartment', label: 'A flat or apartment' },
  { value: 'house', label: 'A house' },
  { value: 'office', label: 'An office or workplace' },
  { value: 'building', label: 'A building with several floors' },
  { value: 'other', label: 'Somewhere else' },
];

/**
 * Adding a real place: its name, a floor plan (or photos of the outside: a .zip of them with notes
 * saying where each was taken), a few photos and a description. Then the Architect's assistant
 * builds it in a workspace, and the Architect reviews it before anyone else can see it.
 */
/** What the pickers offer: pictures of any common kind (iPhone HEIC too) and, for plans, PDFs. */
const PHOTO_TYPES = 'image/*,.heic,.heif';
const PLAN_TYPES = `${PHOTO_TYPES},application/pdf,.pdf`;
const MAX_PLANS = 30;
const MAX_PACKS = 10;

export function NewPlace() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const groupId = params.get('group') ?? '';
  const spaceId = params.get('space');
  const [name, setName] = useState('');
  const [type, setType] = useState<SpaceType>('apartment');
  const [inputs, setInputs] = useState<PlaceInput[]>([]);
  const [description, setDescription] = useState('');
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [provider, setProvider] = useState<Provider | ''>('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** A PDF being turned into pictures (its name). */
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState('');
  const [floor, setFloor] = useState('');
  /** Keep where a .zip's photos were taken (for photos of a building's outside). */
  const [positions, setPositions] = useState(false);
  const [positioned, setPositioned] = useState(0);
  const [picked, setPicked] = useState<Picked>({ provider: '', model: null, effort: null });
  const descId = useId();
  const defaults = useAssistantDefaults(groupId);

  useEffect(() => {
    loadAssistants().then(
      (r) => setAssistants(r.assistants.filter((a) => a.installed && a.signedIn)),
      () => {},
    );
  }, []);
  useEffect(() => {
    if (spaceId) listInputs(spaceId).then(setInputs, () => {});
  }, [spaceId]);

  const plans = inputs.filter((i) => i.kind === 'plan');
  const photos = inputs.filter((i) => i.kind === 'photo');
  const packs = inputs.filter((i) => i.kind === 'pack');
  const chosen = provider || assistants[0]?.provider || '';

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const start = () =>
    run('create', async () => {
      const { spaceId: id } = await createPlace(groupId, name, type);
      setParams({ group: groupId, space: id });
    });
  const add = (kind: 'plan' | 'photo', files: FileList | null, note = '') =>
    run(kind, async () => {
      if (!spaceId || !files) return;
      // A PDF floor plan becomes one picture per page (each usually a floor).
      const items: { file: File; note: string }[] = [];
      for (const file of [...files]) {
        if (kind !== 'plan' || !isPdf(file)) {
          items.push({ file, note });
          continue;
        }
        setReading(file.name);
        const pages = await pdfPages(file, MAX_PLANS - plans.length - items.length).finally(() =>
          setReading(null),
        );
        for (const [i, page] of pages.entries())
          items.push({
            file: page,
            note:
              pages.length === 1
                ? note
                : `${note || file.name.replace(/\.pdf$/i, '')}, page ${i + 1}`,
          });
      }
      const taken = new Set(inputs.map((i) => i.name));
      let n = 1;
      for (const { file, note: about } of items) {
        while (taken.has(`${kind}-${n}`)) n++;
        const name = `${kind}-${n}`;
        taken.add(name);
        const added = await uploadInput(spaceId, name, file, about);
        setInputs((list) => [...list.filter((i) => i.name !== name), { ...added, note: about }]);
      }
    });
  /** A .zip of photos and notes on them: kept whole, what a place can't take left out. */
  const addPack = (files: FileList | null) =>
    run('pack', async () => {
      if (!spaceId || !files) return;
      const left: string[] = [];
      for (const file of [...files]) {
        const added = await uploadPack(spaceId, file, positions);
        setInputs((list) => [...list, { ...added, note: added.folder }]);
        left.push(...added.left);
        setPositioned((n) => n + added.positioned);
      }
      if (left.length)
        setError(
          `Left out (a place takes pictures and documents about it): ${left.slice(0, 6).join(', ')}${left.length > 6 ? ` and ${left.length - 6} more` : ''}.`,
        );
    });
  const remove = (name: string) =>
    run(`remove-${name}`, async () => {
      if (!spaceId) return;
      await removeInput(spaceId, name);
      setInputs((list) => list.filter((i) => i.name !== name));
    });
  const begin = () =>
    run('begin', async () => {
      if (!spaceId || !chosen) return;
      const { id } = await startPlaceWorkspace(spaceId, chosen, description, {
        model: picked.model,
        effort: picked.effort,
      });
      navigate(`/space/${spaceId}/studio/${id}`);
    });

  return (
    <main className="ats-screen">
      <div className="ats-container ats-stack studio-wide">
        <header className="ats-stack" style={{ gap: 6 }}>
          <div>
            <BackLink to="/" label="Your spaces" />
          </div>
          <h1>Add your own place</h1>
          <p className="ats-muted">
            Your AI assistant builds a 3D model of it from its floor plan, or from photos of it.
            Nobody else sees anything until you've checked it and chosen who can see each room.
          </p>
        </header>
        {error && <Notice tone="error">{error}</Notice>}

        {!spaceId ? (
          <Section title="1. The place">
            <form
              className="ats-stack"
              onSubmit={(e) => {
                e.preventDefault();
                void start();
              }}
            >
              <Field
                label="What do you call it?"
                hint="For example: Our flat, The Smiths' house, Studio 4"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
              />
              <fieldset className="studio-choices">
                <legend>What kind of place is it?</legend>
                {TYPES.map((t) => (
                  <label key={t.value} className="studio-check">
                    <input
                      type="radio"
                      name="type"
                      checked={type === t.value}
                      onChange={() => setType(t.value)}
                    />
                    {t.label}
                  </label>
                ))}
              </fieldset>
              <div>
                <Button variant="primary" type="submit" disabled={busy !== null || !name.trim()}>
                  {busy === 'create' ? 'One moment…' : 'Next'}
                  <Icon name="arrowRight" size={16} />
                </Button>
              </div>
            </form>
          </Section>
        ) : (
          <>
            <Section title="2. The floor plan, or photos of the outside">
              <p className="ats-muted">
                A picture of the plan (a photo of a paper plan, or a screenshot from an estate
                agent's listing) or the architect's PDF: each page of a PDF becomes a plan. Take
                photos straight on, with the whole plan in view and any measurements or scale bar
                readable.
              </p>
              <p className="ats-muted">
                More than one floor? Add a plan for each, and say which floor it is. Mark where the
                stairs and any lift are on each one; a garden, balcony or roof terrace goes on the
                plan of the floor it’s on.
              </p>
              <Thumbs spaceId={spaceId} items={plans} onRemove={remove} busy={busy} />
              <div className="studio-actions-row">
                <input
                  className="ats-input studio-room"
                  placeholder={
                    plans.length
                      ? 'Which floor? (e.g. First floor)'
                      : 'Which floor? (e.g. Ground floor)'
                  }
                  value={floor}
                  onChange={(e) => setFloor(e.target.value)}
                  aria-label="Which floor is the plan of?"
                  maxLength={120}
                />
                <label className="ats-button ats-button--primary studio-file">
                  <Icon name="upload" size={16} />
                  {reading
                    ? 'Reading the PDF…'
                    : busy === 'plan'
                      ? 'Adding…'
                      : plans.length
                        ? 'Add another floor plan'
                        : 'Add the floor plan'}
                  <input
                    type="file"
                    accept={PLAN_TYPES}
                    onChange={(e) => {
                      void add('plan', e.target.files, floor.trim());
                      setFloor('');
                      e.target.value = '';
                    }}
                    disabled={busy !== null || plans.length >= MAX_PLANS}
                  />
                </label>
              </div>
              <p className="ats-muted">
                No floor plan? Photos of the outside will do, as a .zip: the building from every
                side (your own, or openly licensed ones), a view from above, and notes on them (a
                README or a manifest saying where each was taken from and what it shows). Your
                assistant builds it from the outside in; inside, it makes its best guess and tells
                you which parts are guesses.
              </p>
              {packs.length > 0 && (
                <ul className="studio-packs">
                  {packs.map((p) => (
                    <li key={p.name}>
                      <Icon name="folder" size={16} />
                      <span className="studio-pack-name">
                        {p.note}/{' '}
                        <span className="ats-muted studio-small">
                          {p.files ?? p.width} file{(p.files ?? p.width) === 1 ? '' : 's'}
                        </span>
                      </span>
                      <IconButton
                        icon="trash"
                        tone="danger"
                        label={`Remove ${p.note}`}
                        onClick={() => void remove(p.name)}
                        disabled={busy !== null}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <div className="studio-actions-row">
                <label className="ats-button ats-button--ghost studio-file">
                  <Icon name="folder" size={16} />
                  {busy === 'pack' ? 'Unpacking…' : 'Add a .zip of photos'}
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(e) => {
                      void addPack(e.target.files);
                      e.target.value = '';
                    }}
                    disabled={busy !== null || packs.length >= MAX_PACKS}
                  />
                </label>
              </div>
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={positions}
                  onChange={(e) => setPositions(e.target.checked)}
                />
                Keep where each photo was taken
              </label>
              <p className="ats-muted studio-small">
                Phone photos know where they were taken and which way they face. Keeping that lets
                your assistant check its model against each photo from the same spot. Only for
                photos of the outside of a building, not of a home; the pictures themselves are
                always saved without it.
                {positioned > 0 &&
                  ` Kept for ${positioned} photo${positioned === 1 ? '' : 's'} (in photo-positions.json).`}
              </p>
            </Section>

            <Section title="3. Photos (optional)">
              <p className="ats-muted">
                One or two of each room help your assistant match the floors, walls and furniture.
                Take them from a corner, in daylight. Keep private things out of view (letters,
                screens, photos of people). Photos are only for your assistant: they never appear in
                the space.
              </p>
              <Thumbs spaceId={spaceId} items={photos} onRemove={remove} busy={busy} />
              <div className="studio-actions-row">
                <input
                  className="ats-input studio-room"
                  placeholder="Which room are they of?"
                  value={room}
                  onChange={(e) => setRoom(e.target.value)}
                  aria-label="Which room are the photos of?"
                  maxLength={120}
                />
                <label className="ats-button ats-button--ghost studio-file">
                  <Icon name="camera" size={16} />
                  {busy === 'photo' ? 'Adding…' : 'Add photos'}
                  <input
                    type="file"
                    accept={PHOTO_TYPES}
                    multiple
                    onChange={(e) => {
                      void add('photo', e.target.files, room);
                      setRoom('');
                      e.target.value = '';
                    }}
                    disabled={busy !== null || photos.length >= 24}
                  />
                </label>
              </div>
            </Section>

            <Section title="4. Tell your assistant about it">
              <div className="ats-field">
                <label htmlFor={descId}>In your own words</label>
                <textarea
                  id={descId}
                  className="ats-input studio-brief"
                  rows={5}
                  maxLength={10000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Which room is which, what the floors and walls are like, the furniture that matters to you…"
                />
              </div>
            </Section>

            <Section title="5. Start">
              <p className="ats-muted">
                While your assistant works, what you've added here is sent to its maker (
                {chosen === 'codex' ? 'OpenAI' : 'Anthropic'}), as with anything you share with it.
                Here, they're saved again without location or camera details, kept private to
                Architects, and never shown in the space.
              </p>
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={understood}
                  onChange={(e) => setUnderstood(e.target.checked)}
                />
                I understand
              </label>
              {assistants.length === 0 ? (
                <p>
                  <Link to="/studio/assistants">Connect your AI assistant</Link> first, then come
                  back here.
                </p>
              ) : (
                <AssistantPicker
                  assistants={assistants}
                  value={{ ...picked, provider: chosen }}
                  onChange={(p) => {
                    setPicked(p);
                    if (p.provider) setProvider(p.provider);
                  }}
                  defaults={defaults}
                />
              )}
              <div>
                <Button
                  variant="primary"
                  onClick={() => void begin()}
                  disabled={busy !== null || !understood || !inputs.length || !chosen}
                >
                  <Icon name="hammer" size={16} />
                  {busy === 'begin' ? 'Preparing the workspace…' : 'Start building'}
                </Button>
                {!inputs.length && (
                  <span className="ats-muted studio-small">
                    {' '}
                    Add the floor plan, or photos, first.
                  </span>
                )}
              </div>
            </Section>
          </>
        )}
      </div>
    </main>
  );
}

function Thumbs({
  spaceId,
  items,
  onRemove,
  busy,
}: {
  spaceId: string;
  items: PlaceInput[];
  onRemove: (name: string) => void;
  busy: string | null;
}) {
  if (!items.length) return null;
  return (
    <ul className="studio-thumbs">
      {items.map((i) => (
        <li key={i.name}>
          <img src={inputUrl(spaceId, i.name)} alt={i.note || i.name} loading="lazy" />
          {i.note && <span className="studio-small">{i.note}</span>}
          <IconButton
            icon="trash"
            tone="danger"
            label={`Remove ${i.note || i.name}`}
            onClick={() => onRemove(i.name)}
            disabled={busy !== null}
          />
        </li>
      ))}
    </ul>
  );
}
