import type { DataSource } from 'typeorm';
import { createDataSource } from '../../src/data-source.js';

/**
 * Database harness for the integration tests.
 *
 * The suite is split so that the verification gate, the parsers and the normalisation pipeline
 * all run with no database at all. Only the tests that are genuinely about SQL need Postgres.
 *
 * If TEST_DATABASE_URL is missing those tests skip, unless REQUIRE_DB_TESTS is set, in which case
 * they fail. CI sets REQUIRE_DB_TESTS so a green build can never mean the database tests quietly
 * did not run.
 */

export function testDatabaseUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL ?? undefined;
}

export function databaseTestsRequired(): boolean {
  return process.env.REQUIRE_DB_TESTS === '1';
}

export async function createTestDataSource(): Promise<DataSource> {
  const url = testDatabaseUrl();
  if (!url) throw new Error('TEST_DATABASE_URL is not set');

  const dataSource = createDataSource(url);
  await dataSource.initialize();
  await dataSource.runMigrations();
  return dataSource;
}

export async function truncateAll(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    'TRUNCATE "rejected_code", "posting_location", "posting", "company", "location" RESTART IDENTITY CASCADE',
  );
}
