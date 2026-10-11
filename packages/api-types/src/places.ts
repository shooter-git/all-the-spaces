export type SpaceType = 'apartment' | 'condo' | 'house' | 'office' | 'building' | 'other';

/** A floor plan or photo added for a place. */
/**
 * A floor plan, a photo, or a pack (a .zip of photos with notes on them, kept whole: `note` is its
 * folder, `files` how many it holds).
 */
export interface PlaceInput {
  name: string;
  kind: 'plan' | 'photo' | 'pack';
  note: string;
  width: number;
  height: number;
  bytes: number;
  files?: number;
}

/** What adding a floor plan or photo answers (the note isn't sent back). */
export type AddedInput = Omit<PlaceInput, 'note'>;

/** What adding a pack answers: its folder, and what in it a place can't take (left out). */
export type AddedPack = AddedInput & {
  kind: 'pack';
  files: number;
  folder: string;
  left: string[];
};

type Named = { key: string; name: string };
type ObjectRef = { key: string; label: string; room: string };

/** How a new version of a place differs from the live one. */
export interface VersionChanges {
  rooms: { added: Named[]; removed: Named[]; changed: Named[]; unchanged: Named[] };
  objects: {
    added: ObjectRef[];
    removed: ObjectRef[];
    moved: { key: string; label: string; from: string; to: string }[];
  };
}

/**
 * Whether a version's indoor rooms have baked lighting, and if not, why (outdoor rooms always use
 * the real-time sun and sky). A room that couldn't be baked uses real-time lighting.
 */
export interface LightingReport {
  /** Every indoor room has baked lighting. */
  baked: boolean;
  /** Indoor rooms. */
  rooms: number;
  /** Indoor rooms with baked lighting. */
  bakedRooms: number;
  /** Of those, kept from an earlier build because nothing in them changed. */
  reused: number;
  /** Why some or all of them weren't baked, in plain words. */
  reason: string | null;
}

/** How far a build has got with baking its lighting. */
export interface BuildProgress {
  /** Indoor rooms. */
  rooms: number;
  /** Of those, finished (baked, kept from an earlier build, or not baked). */
  done: number;
  /** Roughly how long the rest will take (null until a room has been baked). */
  minutesLeft: number | null;
}

/** Where a place is: being built, a candidate to review, and what's live. */
export interface Review {
  space: { id: string; name: string; status: string; live: boolean };
  building: boolean;
  /** How far the build has got with its lighting (null when it isn't baking). */
  progress: BuildProgress | null;
  /** Publishing deletes the floor plans and photos (a group setting). */
  deletesInputs: boolean;
  failed: string | null;
  candidate: {
    id: string;
    number: number;
    createdAt: string;
    rooms: Named[];
    objects: number;
    /** How its lighting was baked (null for versions built before this was recorded). */
    lighting: LightingReport | null;
    /** How it differs from what's live. */
    changes?: VersionChanges;
    /** Creations whose object isn't in it: each needs a new home, or the shelf. */
    homeless?: { id: string; title: string; objectLabel: string | null }[];
    /** Objects in it that don't hold a creation. */
    freeObjects?: ObjectRef[];
  } | null;
}

/** Something to fix in a place's plan (an error), or worth a look (a warning). */
export interface PlanProblem {
  level: 'error' | 'warning';
  message: string;
  fix?: string;
}

/** A version of a place that has been live. */
export interface PlaceVersion {
  id: string;
  number: number;
  live: boolean;
  rooms: number;
  objects: number;
  publishedAt: string;
  /** How its lighting was baked (null for versions built before this was recorded). */
  lighting: LightingReport | null;
}
