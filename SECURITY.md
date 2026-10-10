# Security policy

Please report security problems privately using GitHub's
[private vulnerability reporting](https://github.com/shooter-git/all-the-spaces/security/advisories/new)
for this repository. Don't open a public issue.

Include what you found, how to reproduce it and what an attacker could do with it. We'll acknowledge
your report within a few days and keep you informed while we fix it. We're happy to credit you in
the release notes.

Especially valuable areas (see [docs/security.md](docs/security.md)):

- anything that lets a creation escape its sandboxed frame, read another user's data or act as them;
- anything that exposes a private or hidden room to someone who shouldn't see it;
- anything that lets platform code read, copy or send an Architect's AI sign-in credentials;
- installer or update behaviour that could lose data or run unverified code.
