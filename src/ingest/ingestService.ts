import type { DataSource } from 'typeorm';
import { Company } from '../entities/Company.js';
import { Location } from '../entities/Location.js';
import { Posting } from '../entities/Posting.js';
import { ISO_3166_1_ALPHA_2 } from '../iso/countries.js';
import type { RawPosting } from './types.js';

/**
 * Persisting boards into the schema.
 *
 * Ingest is idempotent: a posting is identified by (source, external_id), so re-running against a
 * live board updates existing rows rather than duplicating them. Location text that has changed
 * resets the posting to pending so it gets normalised again, because a changed eligibility string
 * invalidates every country code previously derived from it.
 */

export interface IngestSummary {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
}

/**
 * Seed the location table from the committed ISO register.
 *
 * Runs before any ingest. Countries are reference data, not something the pipeline discovers,
 * and seeding them up front means the foreign key on posting_location can reject an unknown
 * country at the database level as well as at the gate.
 */
export async function seedLocations(dataSource: DataSource): Promise<number> {
  const repository = dataSource.getRepository(Location);
  const existing = await repository.count();
  if (existing === ISO_3166_1_ALPHA_2.length) return 0;

  await repository
    .createQueryBuilder()
    .insert()
    .into(Location)
    .values(
      ISO_3166_1_ALPHA_2.map((country) => ({
        countryCode: country.code,
        countryName: country.name,
      })),
    )
    .orIgnore()
    .execute();

  return (await repository.count()) - existing;
}

export async function ingestPostings(
  dataSource: DataSource,
  postings: readonly RawPosting[],
): Promise<IngestSummary> {
  const companyRepository = dataSource.getRepository(Company);
  const postingRepository = dataSource.getRepository(Posting);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  const companyIds = new Map<string, string>();

  for (const raw of postings) {
    let companyId = companyIds.get(raw.companySlug);
    if (!companyId) {
      let company = await companyRepository.findOne({ where: { slug: raw.companySlug } });
      if (!company) {
        company = companyRepository.create({
          slug: raw.companySlug,
          name: raw.companyName,
          source: raw.source,
        });
        await companyRepository.save(company);
      }
      companyId = company.id;
      companyIds.set(raw.companySlug, companyId);
    }

    const existing = await postingRepository.findOne({
      where: { source: raw.source, externalId: raw.externalId },
    });

    if (!existing) {
      await postingRepository.save(
        postingRepository.create({
          companyId,
          source: raw.source,
          externalId: raw.externalId,
          title: raw.title.slice(0, 512),
          department: raw.department,
          url: raw.url,
          rawLocationText: raw.rawLocationText,
          normalisationStatus: 'pending',
          normalisationError: null,
        }),
      );
      inserted += 1;
      continue;
    }

    const locationChanged = existing.rawLocationText !== raw.rawLocationText;
    const titleChanged = existing.title !== raw.title.slice(0, 512);

    if (!locationChanged && !titleChanged) {
      unchanged += 1;
      continue;
    }

    existing.title = raw.title.slice(0, 512);
    existing.url = raw.url;
    existing.department = raw.department;
    if (locationChanged) {
      existing.rawLocationText = raw.rawLocationText;
      existing.normalisationStatus = 'pending';
      existing.normalisationError = null;
    }
    await postingRepository.save(existing);
    updated += 1;
  }

  return { inserted, updated, unchanged };
}
