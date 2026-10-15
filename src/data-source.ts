import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Company } from './entities/Company.js';
import { Location } from './entities/Location.js';
import { Posting } from './entities/Posting.js';
import { PostingLocation } from './entities/PostingLocation.js';
import { RejectedCode } from './entities/RejectedCode.js';
import { InitialSchema1760000000000 } from './migrations/1760000000000-InitialSchema.js';
import { AddEligibilityIndex1760000001000 } from './migrations/1760000001000-AddEligibilityIndex.js';

export const ENTITIES = [Company, Location, Posting, PostingLocation, RejectedCode];

export const MIGRATIONS = [InitialSchema1760000000000, AddEligibilityIndex1760000001000];

export function createDataSource(databaseUrl: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    // Deliberately off. Schema changes go through reviewable migration files so that the index
    // this project exists to demonstrate is a committed artefact rather than a runtime accident.
    synchronize: false,
    logging: process.env.TYPEORM_LOGGING === '1',
  });
}

/** Used by the TypeORM CLI, which expects a default exported, already configured DataSource. */
export default createDataSource(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/can_i_apply',
);
