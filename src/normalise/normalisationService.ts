import type { DataSource } from 'typeorm';
import { Location } from '../entities/Location.js';
import { Posting } from '../entities/Posting.js';
import { PostingLocation } from '../entities/PostingLocation.js';
import { RejectedCode } from '../entities/RejectedCode.js';
import { normaliseLocationText } from './normaliser.js';
import type { NormalisationProvider } from './provider.js';

/**
 * Running normalisation over stored postings and writing the result.
 *
 * Each posting is handled in its own transaction so that a posting whose codes were all rejected
 * cannot leave a half written set of edges behind. Rejections are written in the same
 * transaction as the acceptances, which means the record of what the model got wrong is exactly
 * as durable as the record of what it got right.
 */

export interface NormalisationSummary {
  readonly processed: number;
  readonly normalised: number;
  readonly failed: number;
  readonly edgesWritten: number;
  readonly codesRejected: number;
}

export interface NormaliseOptions {
  readonly limit?: number;
  /** Re-run postings that already succeeded, for example after a prompt change. */
  readonly includeNormalised?: boolean;
  readonly onPosting?: (posting: Posting, accepted: number, rejected: number) => void;
}

export async function normalisePendingPostings(
  dataSource: DataSource,
  provider: NormalisationProvider,
  options: NormaliseOptions = {},
): Promise<NormalisationSummary> {
  const postingRepository = dataSource.getRepository(Posting);
  const locationRepository = dataSource.getRepository(Location);

  const locations = await locationRepository.find();
  const locationIdByCode = new Map(locations.map((l) => [l.countryCode, l.id]));

  const statuses = options.includeNormalised
    ? ['pending', 'failed', 'normalised']
    : ['pending', 'failed'];

  const query = postingRepository
    .createQueryBuilder('posting')
    .where('posting.normalisationStatus IN (:...statuses)', { statuses })
    .orderBy('posting.id', 'ASC');

  if (options.limit !== undefined) query.take(options.limit);

  const postings = await query.getMany();

  let normalised = 0;
  let failed = 0;
  let edgesWritten = 0;
  let codesRejected = 0;

  for (const posting of postings) {
    const outcome = await normaliseLocationText(posting.rawLocationText, provider);

    await dataSource.transaction(async (manager) => {
      await manager.delete(PostingLocation, { postingId: posting.id });
      await manager.delete(RejectedCode, { postingId: posting.id });

      for (const accepted of outcome.accepted) {
        const locationId = locationIdByCode.get(accepted.code);
        if (locationId === undefined) {
          // The gate accepted a code the location table does not hold. That means the seed is out
          // of step with the register, which is a deployment problem, not a model problem.
          throw new Error(
            `Location table is missing ${accepted.code}. Run seedLocations before normalising.`,
          );
        }
        await manager.insert(PostingLocation, {
          postingId: posting.id,
          locationId,
          derivation: outcome.method === 'exact_match' ? 'exact_match' : 'model_verified',
          confidence: outcome.method === 'exact_match' ? null : accepted.confidence,
        });
        edgesWritten += 1;
      }

      for (const rejection of outcome.rejected) {
        await manager.insert(RejectedCode, {
          postingId: posting.id,
          proposedCode: rejection.proposedCode,
          reason: rejection.reason,
          rawLocationText: posting.rawLocationText,
          model: outcome.modelName,
        });
        codesRejected += 1;
      }

      const succeeded = outcome.accepted.length > 0;
      await manager.update(
        Posting,
        { id: posting.id },
        {
          normalisationStatus: succeeded ? 'normalised' : 'failed',
          normalisationError: outcome.error ?? null,
        },
      );
    });

    if (outcome.accepted.length > 0) normalised += 1;
    else failed += 1;

    options.onPosting?.(posting, outcome.accepted.length, outcome.rejected.length);
  }

  return {
    processed: postings.length,
    normalised,
    failed,
    edgesWritten,
    codesRejected,
  };
}
