# Phase 0 spikes

Early experiments on the riskiest assumptions, run on 2026-09-29. Scripts live in `tools/spikes/`.

## S1 — Official AI CLIs inside gVisor

**Question:** can the unmodified Claude Code and Codex CLIs be installed by their official installers
and run inside a gVisor sandbox, with network access?

**Setup:** gVisor `release-20260921.0` (checksum-verified download), `runsc --rootless do`, fresh home
directory in the sandbox's throwaway overlay.

| Step | Result |
|---|---|
| gVisor rootless sandbox on Debian 12 / kernel 6.1 | ✓ works, no Docker changes needed |
| Outbound HTTPS from the sandbox | ✓ |
| Claude Code official installer (`claude.ai/install.sh`, stable channel) | ✓ `2.1.280 (Claude Code)` runs |
| Codex official installer (`chatgpt.com/codex/install.sh`) | ✓ `codex-cli 0.159.2` runs (installs to `~/.local/bin`) |
| Files stay inside the sandbox | ✓ nothing written to the host |

**Still open (needs an Architect's real subscription, done together in Phase 5):** signing in through
each CLI's own flow (Claude: URL + pasted code; Codex: `--device-auth`, which must first be enabled
in ChatGPT's security settings) with traffic forced through the egress allow-list proxy, and the list
of vendor hostnames that must be allowed. Also to confirm: which of the CLIs' own sandbox modes work
under gVisor.

**Note:** Codex refuses to create helper aliases when its home is under `/tmp`; sandbox homes must
not live in `/tmp`.

## S2 — Live preview (Vite) file watching inside gVisor

**Question:** when the Architect's AI edits files in the workspace, does a dev server running in a
separate gVisor container notice?

| File access mode | inotify (`fs.watch`) | polling (`fs.watchFile`, 100 ms) |
|---|---|---|
| exclusive (gVisor default for the root filesystem) | 0 / 3 changes | 0 / 3 changes |
| **shared** (gVisor default for mounted volumes) | 0 / 3 changes | **3 / 3 changes** |

**Decision:** preview containers mount the workspace as a volume (shared access) and Vite runs with
`server.watch.usePolling: true`. Never rely on inotify for changes made outside the container.

## S3 — CPU-only lighting bake time per room

**Question:** can a CPU-only server bake realistic lighting for a room in reasonable time?

**Setup:** Blender 3.4 Cycles on CPU, one 5 × 4 m furnished room (~160k triangles), diffuse
direct + indirect, on an older 8-core server CPU (from 2014, no hyper-threading). Modern VPS cores
are typically as fast or faster.

| Threads | Lightmap | Samples | UV pack | Bake |
|---|---|---|---|---|
| 4 | 1024² | 64 | 6 s | 19 s |
| 4 | 1024² | 128 | 6 s | 33 s |
| 4 | 2048² | 128 | 6 s | 148 s |
| 8 | 1024² | 64 | 6 s | 13 s |
| 8 | 1024² | 128 | 7 s | 25 s |
| 8 | 2048² | 128 | 6 s | 100 s |

**Findings:**

- Timing is fine: under a minute per room at 1024², ~2–3 minutes at 2048². A whole house is
  minutes; a 20-floor building (~300 rooms) is roughly 3 hours at 1024² on 4 cores — acceptable as a
  background, per-room, incremental job.
- **Quality needs a different approach than the benchmark used.** Packing every triangle into one
  lightmap wastes the atlas on small props and the result was over-exposed. The builder must:
  bake lightmaps only for architecture and large furniture (xatlas charts), light small props with
  baked light probes / AO instead, and calibrate exposure. Denoise with OIDN.
- Use Blender 4.x or later in the `builder` image (this machine only had 3.4).

**Decision:** keep CPU baking. Default 1024² per room, 2048² for large rooms, bakes queued at low
priority. The browser-GPU baking fallback is not needed for now.

## S4 — What works inside a creation's sandboxed frame

**Question:** with the planned isolation (separate origin, `<iframe sandbox="allow-scripts
allow-pointer-lock">` without `allow-same-origin`, CSP `sandbox` + `connect-src` limited to the
creation's own origin), which browser features still work?

Headless engines via Playwright 1.63 (WebKit stands in for Safari).

| Feature | Chromium | Firefox | WebKit |
|---|---|---|---|
| Opaque origin (`null`) | ✓ | ✓ | ✓ |
| ES modules + dynamic import (with `Access-Control-Allow-Origin: *`) | ✓ | ✓ | ✓ |
| Classic worker from `blob:` URL | ✓ | ✓ | ✓ |
| Module worker from `blob:` URL | ✗ | ✓ | ✓ |
| Worker from a normal URL | ✗ (expected) | ✗ | ✗ |
| WebAssembly (with `'wasm-unsafe-eval'`) | ✓ | ✓ | ✓ |
| WebGL2 | ✓ | ✓ | ✓ |
| OffscreenCanvas | ✓ | ✓ | ✓ |
| Fetch its own files | ✓ | ✓ | ✓ |
| Fetch the app's API | ✗ blocked ✓ | ✗ blocked ✓ | ✗ blocked ✓ |
| localStorage / IndexedDB / cookies | ✗ blocked ✓ | ✗ blocked ✓ | ✗ blocked ✓ |
| SharedArrayBuffer (cross-origin isolation) | ✗ | ✗ | ✗ |
| Gamepad API | ✓ | ✗ | ✗ (“third-party iframes are not allowed”) |
| Fullscreen API | ✓ | ✗ | ✗ |
| Audio starts without a tap | ✓ (headless) | ✗ | ✗ |
| Audio after a tap inside the frame | ✓ | ✓ | ✓ |
| postMessage round trip with the host | ✓ | ✓ | ✓ |
| WebGPU | no adapter (headless) | not exposed | not exposed |

**Decisions for the Portal SDK (Phase 3):**

- The isolation holds in all three engines: no access to the host's storage, cookies or API.
- Decoders and helpers use **classic** blob workers (module blob workers fail in Chromium).
- **Gamepads are read by the host and relayed over the bridge** — Firefox and WebKit block the API
  in cross-origin frames.
- **The host fullscreens its own wrapper**; creations request it over the bridge.
- Every creation shows an **in-frame "tap to start"** that unlocks audio.
- No threads/SharedArrayBuffer; WebGL2 stays the default (WebGPU opt-in only).
- Pointer lock API is present; actual locking needs a real user gesture and is checked on devices.

**Still open:** repeat on real devices — iPhone/iPad Safari (especially audio, pointer/touch and
WebGL memory) and Android Chrome.
