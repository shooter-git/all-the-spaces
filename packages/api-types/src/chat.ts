export interface ChatMessage {
  id: string;
  channel: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
}

export interface ChatPerson {
  id: string;
  name: string;
  color: string;
  dnd: boolean;
  online: boolean;
}

/** Everything the chat panel needs to start: people, blocks, mutes, recent conversations. */
export interface ChatState {
  me: { id: string; dnd: boolean };
  people: ChatPerson[];
  blocked: string[];
  muted: string[];
  conversations: { channel: string; at: string }[];
}

/** Something the app tells you about (a request moved on, a new request for Architects…). */
export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  read: boolean;
  createdAt: string;
}

/** How you like to be told, and what this server can do. */
export interface NotificationSettings {
  email: boolean;
  /** Whether this server can send email at all. */
  canEmail: boolean;
  pushKey: string | null;
  devices: { endpoint: string; device: string }[];
}

/** What the server says over the live connection (/api/live). */
export type LiveEvent =
  | { t: 'hello'; userId: string }
  | { t: 'message'; message: ChatMessage }
  | { t: 'ack'; nonce: string; message: ChatMessage }
  | { t: 'error'; nonce: string; error: string }
  | { t: 'dnd'; userId: string; dnd: boolean }
  | { t: 'notification'; notification: AppNotification }
  | { t: 'pong' };
