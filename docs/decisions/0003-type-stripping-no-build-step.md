# 3. Node runs TypeScript directly: no build step for services

Status: accepted, 2026-09-29

## Context

Everything is written in TypeScript. Compiling the Node services would add an output folder, source
maps and a build to keep in step with the sources, in development, in CI and in the images. Node
can now run TypeScript itself by stripping the types, as long as the code uses only syntax that
can be erased.

## Decision

The Node services (`server`, `realtime`, `worker`, `supervisor`, `egress`) and the packages they
use run their `.ts` sources directly with Node's built-in type stripping. There is no server build
step ([architecture.md](../architecture.md#code-layout)): `node src/main.ts` in development (with
`--watch`) and in the app image alike ([`images/app/Dockerfile`](../../images/app/Dockerfile)).
TypeScript is only a checker (`pnpm typecheck`, `noEmit`).

The web app, creations and the SDK inside them are still bundled by Vite, because browsers need it.

## Consequences

- Node 22.18 or later is required, the first 22 to run TypeScript without a flag. `engines.node`
  says so and `.npmrc` sets `engine-strict`, so `pnpm install` stops on an older Node.
- Only erasable syntax is allowed (`erasableSyntaxOnly` in
  [`tsconfig.node.json`](../../tsconfig.node.json)): no `enum`, no `namespace`, no parameter
  properties. Imports name the `.ts` file.
- Workspace packages export their `src/*.ts` files. That's why the MIT packages can't go to npm as
  they are and are marked private for now ([licensing.md](../licensing.md)).
- Types are never checked at run time: a type error only shows up in `pnpm typecheck`, which CI
  runs.
- The app and egress images copy sources, not build output, so what runs is exactly what's in the
  repository.
