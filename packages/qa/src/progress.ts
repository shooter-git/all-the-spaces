/**
 * What the checks print as they go, for whoever is watching (the Studio shows a build's newest
 * lines under it). A step run in its own process prints these on stdout, each with a mark, so its
 * last line can still be its JSON result: `::log <text>` is a line to show, `::step <name>` says
 * the checks moved on to the next step.
 */
const LOG = '::log ';
const STEP = '::step ';

/** Longest line kept: anything longer is cut, with an ellipsis. */
export const PROGRESS_LINE_MAX = 240;

export const logLine = (text: string) => `${LOG}${text}`;
export const stepLine = (step: string) => `${STEP}${step}`;

/** A marked line, read back; null for anything else a step printed. */
export function readProgress(line: string): { log: string } | { step: string } | null {
  if (line.startsWith(LOG)) return { log: line.slice(LOG.length) };
  if (line.startsWith(STEP)) return { step: line.slice(STEP.length).trim() };
  return null;
}

/**
 * A line as it can be shown: no colours or other terminal codes, no control characters (tabs
 * become spaces), no password in an address, and not too long.
 */
export function cleanLine(text: string): string {
  const clean = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal codes are what's removed
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?|\x1b[@-Z\\-_]/g, '')
    .replace(/\t/g, '  ')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are removed
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1')
    .trimEnd();
  return clean.length > PROGRESS_LINE_MAX ? `${clean.slice(0, PROGRESS_LINE_MAX - 1)}…` : clean;
}
