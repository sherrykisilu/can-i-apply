import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { parseGreenhousePayload } from '../src/ingest/greenhouse.js';
import { extractDeelJobs, parseDeelJobs } from '../src/ingest/deel.js';
import { ingestPostings, seedLocations } from '../src/ingest/ingestService.js';
import { normalisePendingPostings } from '../src/normalise/normalisationService.js';
import { ReplayProvider } from '../src/normalise/provider.js';
import { loadRecordings } from '../src/normalise/providerFactory.js';
import {
  countEligiblePostings,
  explainEligibilityQuery,
  findEligiblePostings,
} from '../src/query/eligibility.js';
import { Location } from '../src/entities/Location.js';
import { PostingLocation } from '../src/entities/PostingLocation.js';
import { RejectedCode } from '../src/entities/RejectedCode.js';
import { Posting } from '../src/entities/Posting.js';
import { createTestDataSource, databaseTestsRequired, testDatabaseUrl, truncateAll } from './helpers/db.js';

const hasDatabase = testDatabaseUrl() !== undefined;

if (!hasDatabase && databaseTestsRequired()) {
  throw new Error(
    'REQUIRE_DB_TESTS is set but TEST_DATABASE_URL is not. The database tests must not be skipped here.',
  );
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

describe.skipIf(!hasDatabase)('eligibility over real postings', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await truncateAll(dataSource);

    const seeded = await seedLocations(dataSource);
    expect(seeded).toBe(249);

    const deel = fixture('deel-open-roles.json') as { jobs: unknown[] };
    const postings = [
      ...parseGreenhousePayload(fixture('greenhouse-canonical.json'), 'canonical', 'Canonical'),
      ...parseDeelJobs(extractDeelJobs(JSON.stringify(deel.jobs))),
    ];

    const summary = await ingestPostings(dataSource, postings);
    expect(summary.inserted).toBe(postings.length);

    await normalisePendingPostings(dataSource, new ReplayProvider(loadRecordings()));
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('seeds countries from the committed register and nothing else', async () => {
    const count = await dataSource.getRepository(Location).count();
    expect(count).toBe(249);
    const kosovo = await dataSource
      .getRepository(Location)
      .findOne({ where: { countryCode: 'XK' } });
    expect(kosovo).toBeNull();
  });

  it('answers the question the project exists to answer', async () => {
    const total = await countEligiblePostings(dataSource, 'KE');
    expect(total).toBeGreaterThan(0);

    const results = await findEligiblePostings(dataSource, { countryCode: 'KE', limit: 200 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.title.length > 0)).toBe(true);
  });

  it('finds a Kenya eligible posting whose text never says Kenya', async () => {
    const results = await findEligiblePostings(dataSource, { countryCode: 'KE', limit: 500 });
    const regionOnly = results.find((r) => /EMEA/i.test(r.rawLocationText));
    expect(regionOnly, 'expected an EMEA posting to resolve to Kenya').toBeDefined();
    expect(regionOnly?.rawLocationText.toLowerCase()).not.toContain('kenya');
  });

  it('does not make a resident of Kenya eligible for an Americas only posting', async () => {
    const results = await findEligiblePostings(dataSource, { countryCode: 'KE', limit: 500 });
    expect(results.some((r) => r.rawLocationText === 'Home Based - Americas')).toBe(false);

    const us = await findEligiblePostings(dataSource, { countryCode: 'US', limit: 500 });
    expect(us.some((r) => r.rawLocationText === 'Home Based - Americas')).toBe(true);
  });

  it('persisted the rejected codes rather than discarding them', async () => {
    const rejected = await dataSource.getRepository(RejectedCode).find();
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((r) => r.reason === 'not_iso_3166_1')).toBe(true);
    expect(rejected.some((r) => r.proposedCode === 'XK')).toBe(true);
  });

  it('wrote no eligibility edge for any rejected code', async () => {
    const rows: Array<{ count: string }> = await dataSource.query(
      `SELECT COUNT(*)::text AS count
       FROM "posting_location" pl
       JOIN "location" l ON l."id" = pl."location_id"
       WHERE l."countryCode" NOT IN (SELECT "countryCode" FROM "location")`,
    );
    expect(Number(rows[0]?.count ?? '1')).toBe(0);

    const edges = await dataSource.getRepository(PostingLocation).count();
    expect(edges).toBeGreaterThan(100);
  });

  it('records exact matches without a confidence and model results with one', async () => {
    const exact = await dataSource
      .getRepository(PostingLocation)
      .findOne({ where: { derivation: 'exact_match' } });
    expect(exact?.confidence).toBeNull();

    const verified = await dataSource
      .getRepository(PostingLocation)
      .findOne({ where: { derivation: 'model_verified' } });
    expect(verified?.confidence).toBeGreaterThan(0);
  });

  it('is idempotent: re-ingesting the same board changes nothing', async () => {
    const deel = fixture('deel-open-roles.json') as { jobs: unknown[] };
    const postings = parseDeelJobs(extractDeelJobs(JSON.stringify(deel.jobs)));
    const summary = await ingestPostings(dataSource, postings);
    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.unchanged).toBe(postings.length);
  });

  it('leaves no posting stuck in pending', async () => {
    const pending = await dataSource
      .getRepository(Posting)
      .count({ where: { normalisationStatus: 'pending' } });
    expect(pending).toBe(0);
  });

  it('uses the eligibility index rather than scanning the join table', async () => {
    const plan = (await explainEligibilityQuery(dataSource, { countryCode: 'KE' })).join('\n');
    expect(plan).toContain('idx_posting_location_eligibility');
    expect(plan).not.toMatch(/Seq Scan on posting_location/);
  });
});
