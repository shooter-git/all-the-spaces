import type { BuildProgress, LightingReport } from '@ats/api-types';

/** "Lighting baked", or "Lighting not baked" and why, in a line (nothing when there's no report). */
export function lightingWords(report: LightingReport | null): string | null {
  if (!report || report.rooms === 0) return null;
  if (report.baked) {
    if (report.reused === 0) return 'Lighting baked';
    const kept =
      report.reused === report.rooms ? 'every room' : `${report.reused} of ${report.rooms} rooms`;
    return `Lighting baked (${kept} kept from the last build: nothing in them changed)`;
  }
  const where =
    report.bakedRooms === 0
      ? ''
      : ` in ${report.rooms - report.bakedRooms} of ${report.rooms} rooms`;
  return `Lighting not baked${where}: ${report.reason ?? 'no reason given'}. Those rooms use real-time lighting.`;
}

/** "about 40 minutes", "about 3 hours". */
function roughly(minutes: number) {
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `about ${Math.round(minutes / 60)} hours`;
}

/** "Baking lighting: room 4 of 12, about 30 minutes left", while a build bakes. */
export function bakingWords(progress: BuildProgress | null): string | null {
  if (!progress || progress.rooms === 0) return null;
  const { rooms, done, minutesLeft } = progress;
  if (done >= rooms) return 'Lighting baked: putting it all together';
  const left = minutesLeft === null ? '' : `, ${roughly(minutesLeft)} left`;
  return `Baking lighting: room ${done + 1} of ${rooms}${left}`;
}

/** A version's lighting, as the Studio shows it under the version. */
export function LightingLine({ report }: { report: LightingReport | null }) {
  const words = lightingWords(report);
  if (!report || !words) return null;
  return (
    <p className="studio-small" data-lighting={report.baked ? 'baked' : 'not-baked'}>
      <span
        className={`studio-dot ${report.baked ? 'studio-dot--good' : 'studio-dot--ok'}`}
        aria-hidden="true"
      />{' '}
      {words}
    </p>
  );
}
