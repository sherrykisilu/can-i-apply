import { isIsoAlpha2, lookupIsoAlpha2 } from '../iso/countries.js';
import type { RejectionReason } from '../entities/RejectedCode.js';

/**
 * The verification gate.
 *
 * Nothing a model produces is trusted. The model proposes country codes; this module decides
 * which of them are real. Every proposal is checked against the committed ISO 3166-1 register in
 * src/iso/countries.ts. Anything that is not in that register is rejected, recorded and surfaced,
 * and it never reaches the database.
 *
 * This module has no dependency on the model provider, on the network or on the database. It is
 * a pure function from proposals to a verdict, which is what makes it testable and what makes it
 * impossible for a model to talk its way past.
 */

/** A single country code as proposed by a model, before any checking. */
export interface ProposedCode {
  readonly code: string;
  readonly confidence: number;
}

export interface AcceptedCode {
  readonly code: string;
  readonly countryName: string;
  readonly confidence: number;
}

export interface Rejection {
  readonly proposedCode: string;
  readonly reason: RejectionReason;
}

export interface VerificationResult {
  readonly accepted: readonly AcceptedCode[];
  readonly rejected: readonly Rejection[];
}

/**
 * Check a batch of proposed codes against the ISO register.
 *
 * Normalisation of surrounding whitespace and case is allowed, because 'ke ' and 'ke' are the
 * same proposal badly typed. Nothing else is forgiven: a two letter string that is not an
 * assigned ISO 3166-1 alpha-2 code is rejected even if it is plausible, and codes outside the
 * standard such as UK, EU and XK are rejected precisely because they are the ones a model
 * reaches for when it is guessing.
 */
export function verifyProposedCodes(proposals: readonly ProposedCode[]): VerificationResult {
  const accepted: AcceptedCode[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();

  for (const proposal of proposals) {
    const raw = typeof proposal.code === 'string' ? proposal.code : '';
    const candidate = raw.trim().toUpperCase();

    if (!/^[A-Z]{2}$/.test(candidate)) {
      rejected.push({ proposedCode: truncate(raw), reason: 'malformed' });
      continue;
    }

    if (!isIsoAlpha2(candidate)) {
      rejected.push({ proposedCode: candidate, reason: 'not_iso_3166_1' });
      continue;
    }

    if (
      typeof proposal.confidence !== 'number' ||
      Number.isNaN(proposal.confidence) ||
      proposal.confidence < 0 ||
      proposal.confidence > 1
    ) {
      rejected.push({ proposedCode: candidate, reason: 'confidence_out_of_range' });
      continue;
    }

    if (seen.has(candidate)) {
      rejected.push({ proposedCode: candidate, reason: 'duplicate' });
      continue;
    }

    const country = lookupIsoAlpha2(candidate);
    if (!country) {
      // Unreachable given isIsoAlpha2 above, but the register is the authority, not the guard.
      rejected.push({ proposedCode: candidate, reason: 'not_iso_3166_1' });
      continue;
    }

    seen.add(candidate);
    accepted.push({
      code: country.code,
      countryName: country.name,
      confidence: proposal.confidence,
    });
  }

  return { accepted, rejected };
}

function truncate(value: string): string {
  return value.length > 64 ? value.slice(0, 64) : value;
}
