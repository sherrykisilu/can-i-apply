import type { DataSource } from 'typeorm';

/**
 * The one query this project exists to answer well.
 *
 * "Which postings can someone resident in country X hold?" It is written as SQL rather than
 * through the query builder for one reason: this is the hot path, the plan matters, and the
 * statement that is measured with EXPLAIN ANALYZE in the README has to be character for
 * character the statement that runs in production.
 *
 * The shape that matters is the leading predicate on location.countryCode. Postgres resolves the
 * country to a single location id, then walks posting_location by location_id. Without
 * idx_posting_location_eligibility there is no index with location_id as a leading column, so
 * that walk is a sequential scan over every edge in the table.
 */

export interface EligiblePosting {
  readonly postingId: string;
  readonly title: string;
  readonly company: string;
  readonly url: string;
  readonly rawLocationText: string;
  readonly derivation: string;
  readonly confidence: number | null;
}

export interface EligibilityQueryOptions {
  readonly countryCode: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly companySlug?: string;
}

export const ELIGIBILITY_SQL = `
SELECT
  p."id"                AS posting_id,
  p."title"             AS title,
  c."name"              AS company,
  p."url"               AS url,
  p."raw_location_text" AS raw_location_text,
  pl."derivation"       AS derivation,
  pl."confidence"       AS confidence
FROM "location" l
JOIN "posting_location" pl ON pl."location_id" = l."id"
JOIN "posting" p          ON p."id" = pl."posting_id"
JOIN "company" c          ON c."id" = p."company_id"
WHERE l."countryCode" = $1
  AND p."normalisation_status" = 'normalised'
  AND ($2::varchar IS NULL OR c."slug" = $2)
ORDER BY pl."confidence" DESC NULLS FIRST, p."id" ASC
LIMIT $3 OFFSET $4
`.trim();

interface EligibilityRow {
  posting_id: string;
  title: string;
  company: string;
  url: string;
  raw_location_text: string;
  derivation: string;
  confidence: number | null;
}

function parameters(options: EligibilityQueryOptions): unknown[] {
  return [
    options.countryCode.trim().toUpperCase(),
    options.companySlug ?? null,
    options.limit ?? 50,
    options.offset ?? 0,
  ];
}

export async function findEligiblePostings(
  dataSource: DataSource,
  options: EligibilityQueryOptions,
): Promise<EligiblePosting[]> {
  const rows: EligibilityRow[] = await dataSource.query(ELIGIBILITY_SQL, parameters(options));

  return rows.map((row) => ({
    postingId: String(row.posting_id),
    title: row.title,
    company: row.company,
    url: row.url,
    rawLocationText: row.raw_location_text,
    derivation: row.derivation,
    confidence: row.confidence === null ? null : Number(row.confidence),
  }));
}

export async function countEligiblePostings(
  dataSource: DataSource,
  countryCode: string,
): Promise<number> {
  const rows: Array<{ total: string }> = await dataSource.query(
    `
    SELECT COUNT(*)::text AS total
    FROM "location" l
    JOIN "posting_location" pl ON pl."location_id" = l."id"
    JOIN "posting" p          ON p."id" = pl."posting_id"
    WHERE l."countryCode" = $1
      AND p."normalisation_status" = 'normalised'
    `,
    [countryCode.trim().toUpperCase()],
  );
  return Number(rows[0]?.total ?? '0');
}

/** Run EXPLAIN ANALYZE over the exact eligibility statement and return the plan lines. */
export async function explainEligibilityQuery(
  dataSource: DataSource,
  options: EligibilityQueryOptions,
): Promise<string[]> {
  const rows: Array<Record<string, string>> = await dataSource.query(
    `EXPLAIN (ANALYZE, BUFFERS) ${ELIGIBILITY_SQL}`,
    parameters(options),
  );
  return rows.map((row) => Object.values(row)[0] ?? '');
}
