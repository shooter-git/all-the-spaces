import { Facts, Notice, Section } from '@ats/ui';
import { useEffect, useState } from 'react';
import { ManageLayout } from '../components/ManageLayout.tsx';
import type { Me } from '../lib/api.ts';
import { type ServerInfo as Info, loadServer } from '../lib/group.ts';

const SCHEDULE = { nightly: 'Every night', weekly: 'Every week', off: 'Off' };

const COMMANDS: [string, string][] = [
  ['sudo ats-admin status', 'The version, the newest backup, and whether each part is running.'],
  ['sudo ats-admin backup', 'Make a backup now (copied off-site too, if that’s set up).'],
  [
    'sudo ats-admin update',
    'Update to the newest release. It backs up first, and goes back by itself if anything fails.',
  ],
  ['sudo ats-admin rollback', 'Undo the last update.'],
  [
    'sudo ats-admin backup-settings',
    'Change when backups run, how long they’re kept, and the off-site copy.',
  ],
  ['sudo ats-admin restore', 'Put a backup back (it replaces what’s there now).'],
];

export function ServerInfo({ me }: { me: Me }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadServer().then(setInfo, (e: Error) => setError(e.message));
  }, []);
  const on = (yes: boolean, what: string) => (yes ? 'On' : `Off (${what})`);

  return (
    <ManageLayout
      me={me}
      title="Server"
      intro="The computer All the Spaces runs on, and how it’s looked after."
    >
      {error && <Notice tone="error">{error}</Notice>}
      {info && (
        <>
          <Section title="This server">
            <Facts
              items={[
                ['Version', info.release],
                ['Address', info.address],
                [
                  'Files are kept',
                  info.storage === 'builtin' ? 'On this server' : 'In your own storage service',
                ],
                [
                  'On it',
                  `${info.counts.people} people · ${info.counts.spaces} spaces · ${info.counts.creations} creations`,
                ],
              ]}
            />
          </Section>
          <Section title="Backups">
            <Facts
              items={[
                ['Scheduled', SCHEDULE[info.backups.schedule]],
                ['Kept for', `${info.backups.keepDays} days`],
                ['Off-site copy', info.backups.offsite ? 'Yes' : 'Not set up'],
              ]}
            />
            {!info.backups.offsite && (
              <p className="ats-muted">
                A copy somewhere else keeps your spaces safe even if this server is lost. Set one up
                with <code>sudo ats-admin backup-settings offsite</code>.
              </p>
            )}
          </Section>
          <Section title="What it can do">
            <Facts
              items={[
                ['Studio', on(info.features.studio, 'creations can’t be built here')],
                ['Voice chat', on(info.features.voice, 'not set up on this server')],
                ['Email', on(info.features.email, 'notifications stay in the app')],
              ]}
            />
          </Section>
          <Section title="Looking after it">
            <p className="ats-muted">
              Updates, backups and restores run on the server itself, so nobody can do them from a
              browser. Sign in to the server (the way you did to install it) and type:
            </p>
            <ul className="manage-commands">
              {COMMANDS.map(([cmd, what]) => (
                <li key={cmd}>
                  <code>{cmd}</code>
                  <span>{what}</span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </ManageLayout>
  );
}
