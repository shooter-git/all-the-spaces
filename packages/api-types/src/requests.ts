export type RequestKind = 'new' | 'improve' | 'bug';
export type RequestStatus =
  | 'submitted'
  | 'accepted'
  | 'in_progress'
  | 'qa_failed'
  | 'ready'
  | 'published'
  | 'declined'
  | 'withdrawn';

export interface RequestSummary {
  id: string;
  kind: RequestKind;
  title: string;
  status: RequestStatus;
  statusWords: string;
  open: boolean;
  groupId: string;
  spaceId: string;
  spaceName: string | null;
  objectLabel: string | null;
  objectKey: string | null;
  roomKey: string;
  creationId: string | null;
  images: string[];
  /** Markdown that came with it: `doc-N`, and the file's own name. */
  documents: { name: string; file: string }[];
  createdAt: string;
  updatedAt: string;
  /** Architects only. */
  priority?: 'low' | 'normal' | 'high';
  effort?: 'small' | 'medium' | 'large' | null;
  requesterName?: string | null;
  workspaceId?: string | null;
}

export interface RequestDetail extends RequestSummary {
  prompt: string;
  brief?: string | null | undefined;
  mine: boolean;
  canWithdraw: boolean;
  workspace: { id: string; mine: boolean } | null;
}

export interface RequestEvent {
  id: string;
  status: RequestStatus | null;
  statusWords: string | null;
  note: string | null;
  by: string | null;
  byArchitect: boolean;
  at: string;
}

/** What's been asked for on the objects you can see. */
export type ObjectRequests = Record<string, { state: 'requested' | 'building'; mine: boolean }>;
