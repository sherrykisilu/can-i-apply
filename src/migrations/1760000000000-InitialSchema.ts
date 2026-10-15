import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The base schema.
 *
 * Note what is absent: there is no array column, no comma separated country string and no JSON
 * blob of eligible countries on posting. Eligibility is an edge in posting_location, because the
 * single query this project exists to answer reads that relationship from the country side.
 */
export class InitialSchema1760000000000 implements MigrationInterface {
  name = 'InitialSchema1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "company" (
        "id" BIGSERIAL PRIMARY KEY,
        "slug" VARCHAR(128) NOT NULL,
        "name" VARCHAR(256) NOT NULL,
        "source" VARCHAR(64) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_company_slug" ON "company" ("slug")`);

    await queryRunner.query(`
      CREATE TABLE "location" (
        "id" SERIAL PRIMARY KEY,
        "countryCode" CHAR(2) NOT NULL,
        "countryName" VARCHAR(128) NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_location_country_code" ON "location" ("countryCode")`,
    );

    await queryRunner.query(`
      CREATE TABLE "posting" (
        "id" BIGSERIAL PRIMARY KEY,
        "company_id" BIGINT NOT NULL REFERENCES "company" ("id") ON DELETE CASCADE,
        "source" VARCHAR(64) NOT NULL,
        "external_id" VARCHAR(128) NOT NULL,
        "title" VARCHAR(512) NOT NULL,
        "department" VARCHAR(128),
        "url" TEXT NOT NULL,
        "raw_location_text" TEXT NOT NULL,
        "normalisation_status" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "normalisation_error" TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_posting_source_external_id" ON "posting" ("source", "external_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "posting_location" (
        "posting_id" BIGINT NOT NULL REFERENCES "posting" ("id") ON DELETE CASCADE,
        "location_id" INTEGER NOT NULL REFERENCES "location" ("id") ON DELETE RESTRICT,
        "derivation" VARCHAR(16) NOT NULL,
        "confidence" REAL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("posting_id", "location_id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "rejected_code" (
        "id" BIGSERIAL PRIMARY KEY,
        "posting_id" BIGINT NOT NULL REFERENCES "posting" ("id") ON DELETE CASCADE,
        "proposed_code" VARCHAR(64) NOT NULL,
        "reason" VARCHAR(32) NOT NULL,
        "raw_location_text" TEXT NOT NULL,
        "model" VARCHAR(128) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_rejected_code_proposed" ON "rejected_code" ("proposed_code")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "rejected_code"`);
    await queryRunner.query(`DROP TABLE "posting_location"`);
    await queryRunner.query(`DROP TABLE "posting"`);
    await queryRunner.query(`DROP TABLE "location"`);
    await queryRunner.query(`DROP TABLE "company"`);
  }
}
