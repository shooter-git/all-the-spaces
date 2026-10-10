// Idempotent bootstrap for the built-in single-node Garage: layout, access key, bucket, grant.
// Uses only Garage's admin API; the app itself only ever speaks the S3 API.

export interface GarageBootstrapOptions {
  adminUrl: string;
  adminToken: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

interface GarageError {
  code?: string;
  message?: string;
}

export async function bootstrapGarage(opts: GarageBootstrapOptions): Promise<void> {
  const call = async <T>(path: string, body?: unknown): Promise<{ ok: boolean; data: T }> => {
    const res = await fetch(`${opts.adminUrl}/v2/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${opts.adminToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { ok: res.ok, data: (text ? JSON.parse(text) : {}) as T };
  };
  const must = async <T>(path: string, body?: unknown): Promise<T> => {
    const { ok, data } = await call<T & GarageError>(path, body);
    if (!ok)
      throw new Error(`Garage ${path} failed: ${data.message ?? data.code ?? 'unknown error'}`);
    return data;
  };

  const layout = await must<{ version: number; roles: unknown[] }>('GetClusterLayout');
  if (layout.roles.length === 0) {
    const status = await must<{
      nodes: { id: string; dataPartition?: { total: number } }[];
    }>('GetClusterStatus');
    const node = status.nodes[0];
    if (!node) throw new Error('Garage reports no nodes');
    await must('UpdateClusterLayout', {
      roles: [
        {
          id: node.id,
          zone: 'local',
          capacity: node.dataPartition?.total ?? 100_000_000_000,
          tags: [],
        },
      ],
    });
    await must('ApplyClusterLayout', { version: layout.version + 1 });
  }

  const key = await call(`GetKeyInfo?id=${encodeURIComponent(opts.accessKeyId)}`);
  if (!key.ok) {
    await must('ImportKey', {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      name: 'all-the-spaces',
    });
  }

  let bucket = await call<{ id: string }>(
    `GetBucketInfo?globalAlias=${encodeURIComponent(opts.bucket)}`,
  );
  if (!bucket.ok) {
    bucket = {
      ok: true,
      data: await must<{ id: string }>('CreateBucket', { globalAlias: opts.bucket }),
    };
  }
  await must('AllowBucketKey', {
    bucketId: bucket.data.id,
    accessKeyId: opts.accessKeyId,
    permissions: { read: true, write: true, owner: true },
  });
}
