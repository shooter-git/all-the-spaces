/**
 * @allthespaces/portal — everything a creation needs to live inside All the Spaces.
 *
 * Creations run in a sealed frame with no network of their own. Who you are, who's playing,
 * saving and multiplayer all go through this SDK, which asks the app to do them safely.
 */
export type {
  ConnectorFixture,
  ConnectorStatus,
  Json,
  Person,
  ResultCode,
  SessionMode,
  Tier,
  UpstreamError,
  Viewport,
} from '@allthespaces/bridge-protocol';
export { type BusName, PortalAudio } from './audio.ts';
export { BridgeError } from './bridge.ts';
export { type CallOptions, ConnectorError, PortalConnectors } from './connectors.ts';
export { type ActionSpec, PortalInput } from './input.ts';
export {
  type ConnectOptions,
  connect,
  Portal,
  SDK_VERSION,
  type StandInConnectors,
  type StandInOptions,
} from './portal.ts';
export { PortalStorage, type SaveOptions, SaveScopeStore, StaleSaveError } from './save.ts';
export { Session } from './session.ts';
