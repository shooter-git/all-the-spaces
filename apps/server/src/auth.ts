import type { Db } from '@ats/db';
import { schema } from '@ats/db';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { createAccessControl } from 'better-auth/plugins/access';
import { organization } from 'better-auth/plugins/organization';
import { defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import { eq } from 'drizzle-orm';
import { isUsableInviteToken, joinWithInvite } from './invite-tokens.ts';

// Groups are Better Auth "organizations" renamed. Two roles: architect (runs the space) and member.
const ac = createAccessControl(defaultStatements);
export const roles = {
  architect: ac.newRole(ownerAc.statements),
  member: ac.newRole(memberAc.statements),
};

export interface AuthOptions {
  db: Db;
  secret: string;
  publicUrl: string;
  /**
   * Sends an email (the server has SMTP). Then everyone confirms their email address before they
   * can sign in, so nothing is ever sent to an address its owner didn't confirm.
   */
  sendMail?: (message: { to: string; subject: string; text: string }) => Promise<void>;
}

export function createAuth({ db, secret, publicUrl, sendMail }: AuthOptions) {
  const url = new URL(publicUrl);
  const groups = organization({
    ac,
    roles,
    creatorRole: 'architect',
    // Groups are created only by the setup wizard (and later by Architects), never by self sign-up.
    allowUserToCreateOrganization: false,
    invitationExpiresIn: 60 * 60 * 24 * 14,
    schema: {
      organization: {
        modelName: 'groups',
        additionalFields: {
          kind: { type: 'string', required: false, defaultValue: 'other' },
          themeColor: { type: 'string', required: false, defaultValue: '#D3DDE8' },
        },
      },
      member: { modelName: 'memberships' },
      invitation: { modelName: 'invitations' },
    },
  });
  return betterAuth({
    appName: 'All the Spaces',
    baseURL: publicUrl,
    basePath: '/api/auth',
    secret,
    trustedOrigins: [url.origin],
    telemetry: { enabled: false },
    database: drizzleAdapter(db, { provider: 'pg', schema: { ...schema } }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      requireEmailVerification: Boolean(sendMail),
    },
    ...(sendMail && {
      emailVerification: {
        sendOnSignUp: true,
        // Signing in before confirming sends a fresh link.
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        expiresIn: 60 * 60 * 24,
        sendVerificationEmail: async (
          { user, url }: { user: { email: string }; url: string },
          request?: Request,
        ) => {
          // Not for the setup wizard's Architect (created on the server, no request).
          if (!request) return;
          await sendMail({
            to: user.email,
            subject: 'Confirm your email for All the Spaces',
            text: [
              'Open this link to confirm this is your email address and sign in:',
              url,
              "It works for 24 hours. If you didn't just join All the Spaces, ignore this email.",
            ].join('\n\n'),
          });
        },
      },
    }),
    // The plugin is only the groups' tables. People join, change role and leave through the app's
    // own routes, which keep the audit log, the last Architect, live rooms and room access in
    // step; the plugin's own endpoints would skip all of that, so none of them answers.
    disabledPaths: Object.values(groups.endpoints).map((e) => e.path),
    hooks: {
      // Spaces are private: signing up over HTTP needs a live invite link. The setup wizard creates
      // the first Architect server-side (no incoming request), so it isn't affected.
      before: createAuthMiddleware(async (hookCtx) => {
        if (hookCtx.path !== '/sign-up/email' || !hookCtx.request) return;
        const token = hookCtx.request.headers.get('x-ats-invite');
        if (!token || !(await isUsableInviteToken(db, token))) {
          throw new APIError('FORBIDDEN', { message: 'You need an invite link to join.' });
        }
      }),
      // ...and puts the new account in the link's group straight away: with email confirmation
      // there's no session yet to accept it with, and the link may be opened on another device.
      after: createAuthMiddleware(async (hookCtx) => {
        if (hookCtx.path !== '/sign-up/email' || !hookCtx.request) return;
        const token = hookCtx.request.headers.get('x-ats-invite');
        const id = (hookCtx.context.returned as { user?: { id?: unknown } } | undefined)?.user?.id;
        if (!token || typeof id !== 'string') return;
        // An address that already has an account gets a made-up answer (so sign-up doesn't
        // reveal who's here): only a real new account joins.
        const [created] = await db
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.id, id));
        if (created) await joinWithInvite(db, created.id, token);
      }),
    },
    advanced: {
      useSecureCookies: url.protocol === 'https:',
      cookiePrefix: 'ats',
    },
    plugins: [
      passkey({ rpID: url.hostname, rpName: 'All the Spaces', origin: url.origin }),
      groups,
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
