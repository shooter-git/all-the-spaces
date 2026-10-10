# Connectors

A **connector** lets creations use another web service you run or trust, as the person playing.
A book club's lending app, a team's rota or a family's shopping list could appear inside a space,
in 3D, while the service itself stays where it is.

Creations still have no network of their own ([0010](decisions/0010-operator-installed-connectors.md)).
A connector works like this:

- **The server's owner installs it**, as a file.
- **A creation declares** which of its operations it uses, and why.
- **An Architect approves** that use, for each version.
- **Each person links their own account** at the service, and every call is made as them, by the
  server, with their own token.

Nothing is installed by default. Without connectors, nothing here changes how creations work.

## Installing one

A connector is one JSON file, `<id>.json`, in the folder `ATS_CONNECTORS_DIR` names. On a server
set up with the installer, that's `connectors/` in the install folder: the server sees it,
read-only, as `/etc/ats/connectors` ([self-hosting](self-hosting.md)). The server reads the
folder when it starts:

- a file that isn't valid is skipped, and the log says why;
- the other connectors still load, and the server still starts.

Restart the server after adding or changing one.

The service must offer **OAuth 2 with PKCE**: authorization code, with refresh tokens if access
tokens expire. Register All the Spaces with it as a confidential client, with this redirect
address:

```
https://<your app address>/api/connectors/callback
```

Put the client secret in the environment variable the definition names (`clientSecretEnv`, which
must start with `ATS_CONNECTOR_`). On an installed server, that's the optional `connectors.env`
in the install folder (readable only by root, like `api-keys.env`). The secret is never in the
file, never sent to browsers, and never shown in the app. Without it, the connector is skipped.

### The Lanternfield Library example

A fictional book-lending club, with an API at `library.example.org`:

```json
{
  "id": "lanternfield-library",
  "displayName": "Lanternfield Library",
  "description": "Borrow and return books from the club shelves.",
  "baseUrl": "https://library.example.org/api",
  "oauth": {
    "authorizeUrl": "https://library.example.org/oauth/authorize",
    "tokenUrl": "https://library.example.org/oauth/token",
    "revokeUrl": "https://library.example.org/oauth/revoke",
    "clientId": "all-the-spaces",
    "clientSecretEnv": "ATS_CONNECTOR_LANTERNFIELD_SECRET",
    "scopes": ["shelves:read", "loans:read", "loans:write", "offline_access"],
    "pkce": true,
    "tokenAuth": "basic"
  },
  "linkCheck": { "op": "whoAmI", "nameField": "/member/displayName" },
  "operations": {
    "whoAmI": {
      "method": "GET",
      "path": "/v1/me",
      "scope": "loans:read",
      "kind": "read",
      "maxResponseBytes": 2000
    },
    "listShelves": {
      "method": "GET",
      "path": "/v1/shelves",
      "params": {
        "type": "object",
        "properties": { "page": { "type": "integer", "minimum": 1, "maximum": 100 } },
        "additionalProperties": false
      },
      "scope": "shelves:read",
      "kind": "read",
      "maxResponseBytes": 40000
    },
    "getMyLoans": {
      "method": "GET",
      "path": "/v1/loans/me",
      "scope": "loans:read",
      "kind": "read",
      "maxResponseBytes": 20000
    },
    "borrowBook": {
      "method": "PUT",
      "path": "/v1/books/:bookId/loan",
      "params": {
        "type": "object",
        "properties": { "bookId": { "type": "string", "pattern": "^[0-9]{1,9}$" } },
        "required": ["bookId"],
        "additionalProperties": false
      },
      "body": {
        "type": "object",
        "properties": { "weeks": { "type": "integer", "minimum": 1, "maximum": 4 } },
        "required": ["weeks"],
        "additionalProperties": false
      },
      "scope": "loans:write",
      "kind": "write",
      "idempotencyHeader": "Idempotency-Key",
      "maxResponseBytes": 4000
    },
    "returnBook": {
      "method": "DELETE",
      "path": "/v1/books/:bookId/loan",
      "params": {
        "type": "object",
        "properties": { "bookId": { "type": "string", "pattern": "^[0-9]{1,9}$" } },
        "required": ["bookId"],
        "additionalProperties": false
      },
      "scope": "loans:write",
      "kind": "write",
      "maxResponseBytes": 4000
    }
  }
}
```

### The definition

| Field | |
|---|---|
| `id` | `a-z`, `0-9` and `-`, 2 to 32 characters; the file is `<id>.json` |
| `displayName`, `description` | What people and Architects see |
| `baseUrl` | Where the API is: `https://` only, with no query or credentials |
| `resolveTo` | Optional `host:port` to connect to instead of what the base URL's name resolves to (see below) |
| `allowPrivateAddress` | Optional, default `false`: allow a service on a private network (and plain `http://`) |
| `oauth.authorizeUrl`, `tokenUrl`, `revokeUrl` | The service's OAuth addresses (`revokeUrl` is optional, used when someone unlinks) |
| `oauth.clientId`, `clientSecretEnv` | The client the service gave you, and the environment variable holding its secret |
| `oauth.scopes` | Every scope the server asks for when someone links (include `offline_access` or similar if the service needs it for refresh tokens) |
| `oauth.pkce` | Always `true` (S256) |
| `oauth.tokenAuth` | How the server proves it's the client: `basic` (HTTP Basic) or `body` (in the form) |
| `oauth.extraAuthorizeParams` | Optional extra parameters for the authorization page (never `state`, `scope`, `redirect_uri` or the other ones the server sets) |
| `operations` | 1 to 200 operations, by name (`listShelves`): see below |
| `linkCheck` | Optional: `{ "op", "nameField"? }`, a read the server makes right after someone links ([the link check](#the-link-check)). `op` names a `GET` read that needs no params; `nameField` is a [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) into its answer (`/nickname`, `/member/displayName`), at most 100 characters |

Each operation:

| Field | |
|---|---|
| `method` | `GET`, `PUT`, `POST`, `PATCH` or `DELETE` |
| `path` | Under the base URL. `:name` fills a whole segment from `params` |
| `params` | An object schema. Path parameters must be required, and a string one needs a `pattern` or `enum`. The others go in the query string (plain values, or lists of them) |
| `body` | An object or array schema, for the JSON body (never on a `GET`) |
| `scope` | One of `oauth.scopes`: the person's link must include it |
| `kind` | `read`, or `write` for anything that changes something |
| `idempotencyHeader` | Optional, for writes: the header the service reads idempotency keys from |
| `maxResponseBytes` | The most the answer may be, up to 60000 (creations get answers through a 64 KB bridge) |
| `timeoutMs` | Optional, default 10000, at most 30000 |

**Schemas** are a small, closed part of JSON Schema, so everything a creation sends is bounded and
checked before it reaches the service:

- `string`: `enum`, `pattern`, `minLength`, `maxLength`;
- `integer` and `number`: `enum`, `minimum`, `maximum`;
- `boolean`;
- `array`: `items` and a required `maxItems`, `minItems`;
- `object`: `properties`, `required`, and always `"additionalProperties": false`.

Any other keyword is refused when the file is read. As in JSON Schema, a `pattern` isn't
anchored: write `^…$`.

## What the server sends, and to where

For each call the server:

- builds the address from the base URL and the operation's path: path parameters are checked
  again and percent-encoded, and can never be empty, `.`, `..` or contain `/`, `\`, `?`, `#` or `%`;
- sends only `Authorization: Bearer <that person's token>`, `Accept: application/json`,
  `Content-Type` with a body, `User-Agent: ATS-connector/<release>`, and for writes the
  idempotency header;
- sends no cookies, never follows redirects (an answer that redirects is an error), and stops
  waiting after the timeout;
- takes only JSON answers, counting the bytes as they arrive and stopping at
  `maxResponseBytes`. Nothing is cached, and each person's calls use only their own token.

**Addresses.** The server resolves the service's name once per call. If any address it resolves
to is private (loopback, private networks, link-local, carrier-grade NAT and the like), the
call is refused, unless `allowPrivateAddress` is set. The connection then goes to the address it
checked, while the name is still what the certificate is checked against and what `Host` says,
so the name can't be pointed somewhere else between the check and the call.

**`resolveTo`** connects to the `host:port` you give instead, for the base URL's host only, while
keeping the name for the certificate and `Host`. Use it when the service runs on the same machine
or network, for example behind your own reverse proxy at `127.0.0.1:8443`. It's yours to set (no
creation or Architect can), so it isn't checked against private addresses.

**Idempotency.** A write's `idempotencyKey` (from the creation) is never sent as it is. The
service gets `ats-` and the first 40 hex digits of SHA-256 of the person, the creation and that
key. A retry of the same change gets the same value; nothing else can make it.

## Linking an account

People link their own account from **Your account → Linked accounts**, or when a creation asks.
The app draws its own card over the creation (it never sees it), naming the service and what it
asks for. Then:

1. The server makes a one-time `state` and PKCE verifier (32 random bytes each). It keeps a hash
   of the state and the verifier sealed with the server secret, for 10 minutes.
2. The whole page goes to the service's authorization page (never a pop-up, so it works in an
   installed app on a phone). The person says yes there.
3. The service sends them back to `/api/connectors/callback`. The server checks that:
   - the state is one it made, unused and not expired;
   - the person signed in is the one who started (otherwise it's refused, and the attempt ends).

   It then swaps the code for tokens, without following redirects, makes the
   [link check](#the-link-check) if the connector has one, and sends the person back where they
   were in the app, with `?linked=<id>`. If they were signed out in the meantime,
   they sign in first and it carries on.
4. The tokens are sealed with the server secret (one key per link) and never leave the server.
   They're refreshed when they're about to expire, and once more if the service answers 401.

If the service refuses a refresh (`invalid_grant`), the link is marked as needing linking again,
and calls answer `not-linked` until the person links again. The same happens if it still answers
401 to a token it has just issued.

**Unlinking** asks the service to revoke the tokens (best effort, if it has `revokeUrl`) and
deletes them.

**Revoking at the service** (the person or the service withdraws the grant) works the same way:
the next call finds the link broken.

### The link check

If the definition has a `linkCheck`, the server calls that operation as the person straight
after it gets their tokens, before sending them back. It's an ordinary call (the same address
pinning, headers, size cap and refresh on 401), with nothing filled in and a deadline of 8
seconds at most. Without a `linkCheck`, linking calls nothing at the service's API. Pick an
operation whose scope everyone grants: if the service granted fewer scopes than that, there's
no check (as if it couldn't be reached).

It's there so that:

- the link is proven to work the moment it's made, not the first time a creation needs it;
- people see who they're linked as (**Linked as Ada** in their account, and `accountName` in a
  creation's `connector:status`), which helps when someone has more than one account there;
- a service that records a connected app only when it's first used sees the link at once.

What happens next depends on the answer:

| Answer | What happens |
|---|---|
| It worked | The link is kept and marked as checked. If `nameField` points at a string, it's kept as the account's name: trimmed, without control characters, at most 60 characters. Nothing else from the answer is kept |
| 403, or 401 even after a refresh | The service says this account can't use it, so the link is removed (and its tokens revoked, if the service has `revokeUrl`). It's recorded in the audit log (`connector.link_refused`, with the status and the service's code, if any). The person comes back with `?link_error=refused_by_service&link_connector=<id>` (and `&link_reason=<CODE>` if the service gave a code like `ACCOUNT_SUSPENDED`), and is told to link a different account or ask its owner |
| Anything else (unreachable, slow, too big, another error) | The link may well be fine, so it's kept, unchecked. The person comes back with `?linked=<id>&link_check=unconfirmed`, and is told the service couldn't be reached to check it yet |

Linking again starts afresh: the last check's name and time don't carry over.

## Approving what a creation uses

A creation lists what it uses in `ats.json`:

```json
"connectors": [
  {
    "id": "lanternfield-library",
    "ops": ["listShelves", "getMyLoans", "borrowBook"],
    "why": "Shows the club's shelves and your loans, and lets you borrow a book."
  }
]
```

A version that declares connectors is kept as a candidate until an Architect approves them.
**Make live** in **Creations** lists each operation:

- whether it only reads or changes things;
- its scope;
- the creation's own reason.

**Allow and make it live** records the approval for that version, and only that version.

Then:

- An Architect trying a version that isn't live can call its declared **read** operations with
  their own link, before approving. Writes answer `trial`.
- Approvals stay on this server. An exported creation carries what it declares, never what was
  approved. An imported one arrives as a candidate, waiting to be approved here.
- `creation:publish --approve-connectors` (the server owner's command line) approves what the
  project declares as it publishes. Without the flag, it lands as a candidate like any other.

Every link, unlink, refused link check, approval and write call is recorded in the audit log. Write calls record the
connector, operation, creation and status, never bodies or tokens.

## Limits

- Calls per person and connector: 120 reads and 30 writes a minute. Over that, `denied` for the
  rest of the minute.
- Only the live version can act for members. Someone still inside an older version gets `denied`
  and rejoins.
- An error from the service reaches the creation only as `status`, a `code` if it looks like one
  (`A-Z` and `_`, up to 40), a `message` cut to 200 characters, and `details` if they're JSON of
  2 KB or less.

## Turning one off

Remove its file and restart the server. Links stay, unused, until people unlink or you link it
again. Taking a creation off its object stops its calls too, since nobody can open it.
