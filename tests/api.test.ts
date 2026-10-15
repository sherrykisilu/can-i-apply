import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createApp } from '../src/api/server.js';
import { parseGreenhousePayload } from '../src/ingest/greenhouse.js';
import { ingestPostings, seedLocations } from '../src/ingest/ingestService.js';
import { normalisePendingPostings } from '../src/normalise/normalisationService.js';
import { ReplayProvider } from '../src/normalise/provider.js';
import { loadRecordings } from '../src/normalise/providerFactory.js';
import { createTestDataSource, testDatabaseUrl, truncateAll } from './helpers/db.js';

const hasDatabase = testDatabaseUrl() !== undefined;

describe.skipIf(!hasDatabase)('http api', () => {
  let dataSource: DataSource;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await truncateAll(dataSource);
    await seedLocations(dataSource);

    const payload = JSON.parse(
      readFileSync(new URL('./fixtures/greenhouse-canonical.json', import.meta.url), 'utf8'),
    );
    await ingestPostings(dataSource, parseGreenhousePayload(payload, 'canonical', 'Canonical'));
    await normalisePendingPostings(dataSource, new ReplayProvider(loadRecordings()));

    server = createApp(dataSource).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('reports health', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('returns eligible postings for a real country', async () => {
    const response = await fetch(`${base}/eligible/KE?limit=5`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      country: { code: string; name: string };
      total: number;
      postings: unknown[];
    };
    expect(body.country).toEqual({ code: 'KE', name: 'Kenya' });
    expect(body.total).toBeGreaterThan(0);
    expect(body.postings.length).toBeLessThanOrEqual(5);
  });

  it('rejects a country code that is not in the ISO register', async () => {
    const response = await fetch(`${base}/eligible/XK`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('unknown_country_code');
  });

  it('exposes what the gate rejected', async () => {
    const response = await fetch(`${base}/rejections?limit=5`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rejections: Array<{ proposedCode: string }> };
    expect(Array.isArray(body.rejections)).toBe(true);
  });
});
