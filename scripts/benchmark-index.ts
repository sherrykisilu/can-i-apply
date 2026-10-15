#!/usr/bin/env node
/**
 * Measure the eligibility query with and without idx_posting_location_eligibility.
 *
 * Honesty note. The committed fixtures hold 83 real postings. At that size Postgres will pick a
 * sequential scan whatever indexes exist, because the whole table is a handful of pages, so a
 * before and after comparison on real data alone would prove nothing. This script therefore has
 * two modes:
 *
 *   npm run bench:index                 measures the real ingested data as it stands
 *   npm run bench:index -- --scale 250  grows posting_location with synthetic edges first
 *
 * The synthetic rows reuse the real ISO country register and the real posting shape. They are
 * written under the company slug "synthetic-benchmark" so they are trivially identifiable and are
 * removed again at the end of the run. Every number printed is produced by running the statement,
 * nothing is estimated.
 */
import 'reflect-metadata';
import { createDataSource } from '../src/data-source.js';
import { loadConfig } from '../src/config.js';
import { ELIGIBILITY_SQL, explainEligibilityQuery } from '../src/query/eligibility.js';

const INDEX_NAME = 'idx_posting_location_eligibility';
const SYNTHETIC_SLUG = 'synthetic-benchmark';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const config = loadConfig();
  const countryCode = (argValue('--country') ?? 'KE').toUpperCase();
  const scale = Number(argValue('--scale') ?? '0');
  const repeats = Number(argValue('--repeats') ?? '5');

  const dataSource = createDataSource(config.databaseUrl);
  await dataSource.initialize();

  try {
    if (scale > 0) {
      console.log(`seeding ${scale} synthetic postings per country for the benchmark`);
      await seedSynthetic(dataSource, scale);
    }

    const edges: Array<{ total: string }> = await dataSource.query(
      'SELECT COUNT(*)::text AS total FROM "posting_location"',
    );
    const postings: Array<{ total: string }> = await dataSource.query(
      'SELECT COUNT(*)::text AS total FROM "posting"',
    );
    console.log(`\nposting rows: ${postings[0]?.total}`);
    console.log(`posting_location rows: ${edges[0]?.total}`);
    console.log(`country under test: ${countryCode}\n`);

    await dataSource.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
    await dataSource.query('ANALYZE "posting_location"');
    const without = await measure(dataSource, countryCode, repeats);
    report('WITHOUT the index', without);

    await dataSource.query(
      `CREATE INDEX ${INDEX_NAME} ON "posting_location" ("location_id", "posting_id")`,
    );
    await dataSource.query('ANALYZE "posting_location"');
    const with_ = await measure(dataSource, countryCode, repeats);
    report('WITH the index', with_);

    const ratio = without.best / with_.best;
    console.log(`\nspeedup on best of ${repeats}: ${ratio.toFixed(1)}x`);
  } finally {
    if (scale > 0) {
      console.log('\nremoving synthetic rows');
      await removeSynthetic(dataSource);
    }
    await dataSource.query(
      `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON "posting_location" ("location_id", "posting_id")`,
    );
    await dataSource.destroy();
  }
}

interface Measurement {
  readonly best: number;
  readonly plan: string[];
}

async function measure(
  dataSource: import('typeorm').DataSource,
  countryCode: string,
  repeats: number,
): Promise<Measurement> {
  let best = Number.POSITIVE_INFINITY;
  let plan: string[] = [];

  for (let i = 0; i < repeats; i += 1) {
    const lines = await explainEligibilityQuery(dataSource, { countryCode, limit: 50 });
    const execution = lines.find((line) => line.startsWith('Execution Time:'));
    const ms = Number(execution?.replace('Execution Time:', '').replace('ms', '').trim() ?? 'NaN');
    if (Number.isFinite(ms) && ms < best) {
      best = ms;
      plan = lines;
    }
  }

  return { best, plan };
}

function report(label: string, measurement: Measurement): void {
  console.log(`===== ${label} =====`);
  for (const line of measurement.plan) console.log(line);
  console.log(`best execution time over the run: ${measurement.best.toFixed(3)} ms\n`);
}

async function seedSynthetic(
  dataSource: import('typeorm').DataSource,
  perCountry: number,
): Promise<void> {
  await dataSource.query(
    `INSERT INTO "company" ("name", "slug", "source")
     VALUES ('Synthetic Benchmark', $1, 'synthetic')
     ON CONFLICT ("slug") DO NOTHING`,
    [SYNTHETIC_SLUG],
  );

  await dataSource.query(
    `
    WITH company AS (SELECT "id" FROM "company" WHERE "slug" = $1),
    inserted AS (
      INSERT INTO "posting" (
        "company_id", "source", "external_id", "title", "url",
        "raw_location_text", "normalisation_status"
      )
      SELECT
        (SELECT "id" FROM company),
        'synthetic',
        'synthetic-' || l."countryCode" || '-' || g,
        'Benchmark Engineer ' || g,
        'https://example.invalid/' || l."countryCode" || '/' || g,
        l."countryName",
        'normalised'
      FROM "location" l
      CROSS JOIN generate_series(1, $2) AS g
      ON CONFLICT ("source", "external_id") DO NOTHING
      RETURNING "id", "raw_location_text"
    )
    INSERT INTO "posting_location" ("posting_id", "location_id", "derivation", "confidence")
    SELECT i."id", l."id", 'exact_match', NULL
    FROM inserted i
    JOIN "location" l ON l."countryName" = i."raw_location_text"
    ON CONFLICT DO NOTHING
    `,
    [SYNTHETIC_SLUG, perCountry],
  );
}

async function removeSynthetic(dataSource: import('typeorm').DataSource): Promise<void> {
  await dataSource.query(
    `DELETE FROM "posting" WHERE "company_id" IN (SELECT "id" FROM "company" WHERE "slug" = $1)`,
    [SYNTHETIC_SLUG],
  );
  await dataSource.query('DELETE FROM "company" WHERE "slug" = $1', [SYNTHETIC_SLUG]);
}

console.log(`statement under measurement:\n${ELIGIBILITY_SQL}\n`);

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
