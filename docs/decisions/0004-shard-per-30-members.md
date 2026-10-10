# 4. One live presence shard per 30 members

Status: accepted, 2026-10-01

## Context

Live presence for a space is a Colyseus room in `realtime`. Each person only receives the people in
their own room and the rooms next to it, but one Colyseus room still does all the work of sending
to everyone in the space. The original plan was one room per space, split only once measurements
showed the need. Phase 9 added a 20-floor, 240-room sample and a load test to measure it
(`pnpm --filter @ats/realtime load-test`, see [development.md](../development.md#performance-checks)).

## Decision

A big group's space is split into several live rooms (shards), one per 30 group members
(`MEMBERS_PER_SHARD` in [`packages/shared/src/tickets.ts`](../../packages/shared/src/tickets.ts)).

- The server picks each person's shard with a stable hash of their id, and puts it in their signed
  real-time pass. Small groups have one shard.
- Each shard sends updates only to its own people.
- Shards tell each other where their people are through Valkey, 20 times a second, with a full
  refresh every 2 s ([`apps/realtime/src/space-room.ts`](../../apps/realtime/src/space-room.ts)),
  so people still see everyone nearby, whichever shard they're in.

The repository doesn't record why 30 was chosen over another number; the load test is how to check
a different one.

## Consequences

- With 152 people in the tall building, updates take 3–4 ms at the 99th percentile and
  who-sees-whom 0.5 ms, under 40% of one core ([architecture.md](../architecture.md#live-presence-at-scale)).
- The shard count follows the group's size, not how many people are in the space right now.
- When a group grows past a multiple of 30, new passes spread people over one more shard. People
  already inside keep theirs; since shards share everyone's positions, nobody notices.
- Positions from another shard arrive through Valkey, passed on every 50 ms, so they can be a
  little behind those from the same shard.
