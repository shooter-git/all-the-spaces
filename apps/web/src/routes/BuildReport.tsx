import { Notice, Section } from '@ats/ui';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { BackLink } from '../components/BackLink.tsx';
import { api } from '../lib/api.ts';
import { reportFile } from '../lib/studio.ts';
import './creations.css';

interface Check {
  id: string;
  status: 'pass' | 'fail' | 'warn';
  title: string;
  detail?: string;
  fix?: string;
  where?: string;
}
interface Report {
  ok: boolean;
  createdAt: string;
  creation: { title: string; tier: string };
  checks: Check[];
  viewports: { name: string; label: string; screenshots: { name: string; file: string }[] }[];
  summary: Record<string, number> | null;
  build: {
    conversions: { path: string; action: string; before: number; after: number }[];
    notes: string[];
  } | null;
}

const NUMBERS: [string, string, (n: number) => string][] = [
  ['drawCalls', 'Draw calls per frame', (n) => String(n)],
  ['triangles', 'Triangles per frame', (n) => n.toLocaleString()],
  ['textureMB', 'Texture memory', (n) => `${n.toFixed(1)} MB`],
  ['gpuMB', 'Graphics memory', (n) => `${n.toFixed(1)} MB`],
  ['voices', 'Sounds at once', (n) => String(n)],
  ['heapMB', 'Script memory', (n) => `${n.toFixed(1)} MB`],
  ['initialMB', "Download before it's ready", (n) => `${n.toFixed(1)} MB`],
  ['totalMB', 'Whole download', (n) => `${n.toFixed(1)} MB`],
];
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

/** A build's checks, as the Architect (and their assistant) see them. */
export function BuildReport() {
  const { buildId } = useParams();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (buildId)
      api<Report>(reportFile(buildId, 'report.json')).then(setReport, (e: Error) =>
        setError(e.message),
      );
  }, [buildId]);

  const failed = report?.checks.filter((c) => c.status === 'fail').length ?? 0;
  const warned = report?.checks.filter((c) => c.status === 'warn').length ?? 0;
  return (
    <main className="ats-screen">
      <div className="ats-container ats-stack">
        <header className="ats-stack" style={{ gap: 6 }}>
          <div>
            <BackLink />
          </div>
          <h1>{report?.creation.title ?? 'Checks'}</h1>
          {report && (
            <>
              <p className="report-verdict" data-ok={report.ok}>
                {report.ok
                  ? warned
                    ? `Ready, with ${warned} thing${warned === 1 ? '' : 's'} worth a look`
                    : 'Ready'
                  : `${failed} thing${failed === 1 ? '' : 's'} to fix before it can be published`}
              </p>
              <p className="ats-muted">
                Checked for {report.creation.tier}-powered devices and up ·{' '}
                {new Date(report.createdAt).toLocaleString()}
              </p>
            </>
          )}
        </header>
        {error && <Notice tone="error">{error}</Notice>}
        {report && buildId && (
          <>
            <Section title="Checks">
              <ul className="report-checks">
                {report.checks.map((c) => (
                  <li key={`${c.id}|${c.where ?? ''}|${c.title}`}>
                    <span className={`studio-dot studio-dot--${c.status}`} aria-hidden="true" />
                    <div>
                      <span className="visually-hidden">
                        {c.status === 'pass'
                          ? 'Passed: '
                          : c.status === 'warn'
                            ? 'Worth a look: '
                            : 'To fix: '}
                      </span>
                      <strong>{c.title}</strong>
                      {c.where && <span className="ats-muted"> · {c.where}</span>}
                      {c.detail && <p className="studio-small">{c.detail}</p>}
                      {c.fix && c.status !== 'pass' && (
                        <p className="studio-small report-fix">{c.fix}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
            {report.viewports.some((v) => v.screenshots.length) && (
              <Section title="On each screen">
                <div className="report-shots">
                  {report.viewports.flatMap((v) =>
                    v.screenshots.map((s) => (
                      <figure key={s.file}>
                        <img
                          src={reportFile(buildId, s.file)}
                          alt={`${v.label}: ${s.name}`}
                          loading="lazy"
                        />
                        <figcaption>
                          {v.label} · {s.name}
                        </figcaption>
                      </figure>
                    )),
                  )}
                </div>
              </Section>
            )}
            {report.summary && (
              <Section title="The heaviest moments">
                <table className="report-numbers">
                  <tbody>
                    {NUMBERS.map(([key, label, fmt]) => (
                      <tr key={key}>
                        <th scope="row">{label}</th>
                        <td>{fmt(report.summary?.[key] ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}
            {(report.build?.conversions.length ?? 0) > 0 && (
              <Section title="Made lighter">
                <ul>
                  {report.build?.conversions.map((c) => (
                    <li key={c.path} className="studio-small">
                      {c.path}: {c.action} ({mb(c.before)} → {mb(c.after)})
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {(report.build?.notes.length ?? 0) > 0 && (
              <Section title="Notes">
                <ul>
                  {report.build?.notes.map((n) => (
                    <li key={n} className="studio-small">
                      {n}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
