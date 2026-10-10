import { describe, expect, it } from 'vitest';
import { loadServerEnv, loadSupervisorEnv, withLocalDefaults } from '../src/env.ts';

describe('configuration', () => {
  it('derives local connection URLs from dev ports', () => {
    const e = withLocalDefaults({
      ATS_PORT_POSTGRES: '45132',
      POSTGRES_PASSWORD: 'pw',
      ATS_PORT_VALKEY: '45179',
    });
    expect(e.DATABASE_URL).toBe('postgres://ats:pw@127.0.0.1:45132/ats');
    expect(e.VALKEY_URL).toBe('redis://127.0.0.1:45179');
  });

  it('keeps explicit URLs', () => {
    const e = withLocalDefaults({ ATS_PORT_VALKEY: '1', VALKEY_URL: 'redis://valkey:6379' });
    expect(e.VALKEY_URL).toBe('redis://valkey:6379');
  });

  it('explains what is missing in plain terms', () => {
    expect(() => loadServerEnv({})).toThrow(/Configuration is incomplete[\s\S]*BETTER_AUTH_SECRET/);
  });

  it('gives the supervisor its defaults, ignores a too-short egress secret, and needs its own', () => {
    const secret = 'x'.repeat(32);
    expect(loadSupervisorEnv({ SUPERVISOR_SECRET: secret, EGRESS_SECRET: 'short' })).toMatchObject({
      ATS_INSTANCE: 'ats',
      ATS_WORKBENCH_IMAGE: 'ats-workbench:latest',
      ATS_EGRESS_URL: 'http://egress:3128',
      EGRESS_SECRET: undefined,
      ATS_SANDBOX_RUNTIME: 'runsc',
      ATS_SANDBOX_CPUS: 2,
      ATS_SANDBOX_MEMORY_MB: 4096,
      ATS_SANDBOX_PIDS: 1024,
      ATS_BAKE_CPUS: 2,
      ATS_PORT_SUPERVISOR: 45140,
      HOST: '127.0.0.1',
      DOCKER_SOCKET: '/var/run/docker.sock',
    });
    expect(
      loadSupervisorEnv({
        SUPERVISOR_SECRET: secret,
        EGRESS_SECRET: secret,
        ATS_SANDBOX_CPUS: '1.5',
        ATS_BAKE_CPUS: '4',
        ATS_BAKE_PARALLEL: '3',
        ATS_CHECK_CPUS: '6',
      }),
    ).toMatchObject({
      EGRESS_SECRET: secret,
      ATS_SANDBOX_CPUS: 1.5,
      ATS_BAKE_CPUS: 4,
      ATS_BAKE_PARALLEL: 3,
      ATS_CHECK_CPUS: 6,
    });
    // Left empty in .env, the number of bakes at once is worked out from the host's CPUs.
    expect(
      loadSupervisorEnv({ SUPERVISOR_SECRET: secret, ATS_BAKE_PARALLEL: '' }).ATS_BAKE_PARALLEL,
    ).toBeUndefined();
    // Likewise the checks' CPUs (supervisor main.ts: 4, or fewer on a smaller host).
    expect(
      loadSupervisorEnv({ SUPERVISOR_SECRET: secret, ATS_CHECK_CPUS: '' }).ATS_CHECK_CPUS,
    ).toBeUndefined();
    expect(() => loadSupervisorEnv({ SUPERVISOR_SECRET: 'short' })).toThrow(/SUPERVISOR_SECRET/);
    expect(() =>
      loadSupervisorEnv({ SUPERVISOR_SECRET: secret, ATS_SANDBOX_MEMORY_MB: 'lots' }),
    ).toThrow(/ATS_SANDBOX_MEMORY_MB/);
  });
});
