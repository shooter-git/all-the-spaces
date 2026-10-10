import type { SessionMode } from '@allthespaces/bridge-protocol';
import type { DeclaredConnector } from './studio.ts';

export type { SessionMode };

/** A creation in the space, as the app lists it. */
export interface CreationInfo {
  id: string;
  title: string;
  description: string;
  objectKey: string | null;
  roomKey: string | null;
  defaultMode: SessionMode;
  version: number;
  /** People in its shared sessions right now. */
  playing: number;
}

/** What the server hands back when you open a creation. */
export interface OpenedCreation {
  creation: {
    id: string;
    title: string;
    version: number;
    versionId: string;
    protocolVersion: number;
    defaultMode: SessionMode;
    /** The shape of the data this version saves. */
    saveVersion: number | null;
  };
  /** A version that isn't live, opened to try: nothing it saves is kept. */
  trial: boolean;
  /** The creation's own sealed address (with a pass just for you). */
  url: string;
  playOrigin: string;
  /** Lets you into its live session. */
  ticket: string;
  /** Voice chat in this session (the group has it, and it isn't a session on your own). */
  voice?: boolean;
  /** The connectors this version declares (what it may ask the app to call for it). */
  connectors?: DeclaredConnector[];
}

/** A connector this server's owner installed, and your link to it (GET /api/connectors). */
export interface ConnectorInfo {
  id: string;
  displayName: string;
  description: string;
  /** What linking lets it do (the scopes it asks the service for). */
  scopes: string[];
  linked: boolean;
  linkedAt: string | null;
  /** Linked, but the service stopped accepting it: link again. */
  broken: boolean;
  /** Who the service says you're linked as (from its link check), when it said. */
  accountName: string | null;
  /** The link check worked right after linking (false without one, or when it couldn't tell). */
  checked: boolean;
}
