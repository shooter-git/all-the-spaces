/** What someone was on, as their app says: never more precise than this. */
export const VISIT_DEVICES = ['phone', 'tablet', 'computer', 'headset'] as const;
export type VisitDevice = (typeof VISIT_DEVICES)[number];

/** Where a visit is: a room of a place, or a creation (a session of its version). */
export type VisitPlace = { userId: string; device?: VisitDevice | undefined } & (
  | { spaceId: string; roomKey: string }
  | {
      creationId: string;
      versionId: string;
      /** The live session: people in the same one were playing together. */
      session?: string | undefined;
    }
);

/** A visit that began (and, if it was short, perhaps ended) since the last batch. */
export type VisitStart = VisitPlace & {
  /** Chosen by the real-time service: sending it twice keeps one visit. */
  id: string;
  /** Times are ms since the epoch, on the real-time service's clock. */
  startedAt: number;
  endedAt?: number | undefined;
};

/**
 * What the real-time service tells the server about visits (POST /internal/visits): coarse spans
 * of time in a room or a creation, never positions.
 */
export interface VisitBatch {
  /** When this was sent (ms since the epoch, on the real-time service's clock). */
  now: number;
  started: VisitStart[];
  /** Visits sent before that have ended since. */
  ended: { id: string; at: number }[];
  /**
   * Every visit still going, sent once every `VISIT_HEARTBEAT_MS`: visits nobody vouches for
   * (their real-time service stopped) are ended when they were last seen.
   */
  going?: string[] | undefined;
}

export const VISIT_HEARTBEAT_MS = 60_000;
