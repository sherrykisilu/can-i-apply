import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The index the eligibility query needs.
 *
 * posting_location has a composite primary key of (posting_id, location_id). Postgres backs that
 * with a btree on the pair, and because posting_id is the leading column that index can only be
 * used to answer 'which countries does this posting list'. The query this project actually runs
 * asks the opposite question, 'which postings list this country', which has no usable leading
 * column and degenerates into a sequential scan of the whole join table.
 *
 * idx_posting_location_eligibility leads on location_id so that lookup becomes an index scan, and
 * carries posting_id as the second column so the join back to posting can be satisfied from the
 * index alone. Measured before and after numbers are in the README.
 */
export class AddEligibilityIndex1760000001000 implements MigrationInterface {
  name = 'AddEligibilityIndex1760000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "idx_posting_location_eligibility"
        ON "posting_location" ("location_id", "posting_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_posting_location_eligibility"`);
  }
}
