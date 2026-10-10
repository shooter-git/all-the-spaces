/** You, and the groups you're in (GET /api/me; `user` is null when signed out). */
export interface Me {
  /** `image` is as Better Auth has it: possibly left out, not only null. */
  user: { id: string; name: string; email: string; image?: string | null | undefined } | null;
  groups: {
    groupId: string;
    groupName: string;
    themeColor: string | null;
    role: 'architect' | 'member';
  }[];
}

/** One of your sign-ins (a browser or device that's signed in as you). */
export interface SignedIn {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  userAgent: string | null;
  current: boolean;
}
