import { ISO_3166_1_ALPHA_2 } from '../iso/countries.js';
import type { NormalisationProvider } from './provider.js';
import { ModelResponseError } from './provider.js';
import type { AcceptedCode, Rejection } from './verifier.js';
import { verifyProposedCodes } from './verifier.js';

/**
 * Turning free text into verified country codes.
 *
 * Two passes, in this order:
 *
 * 1. A deterministic exact match pass. If the text is literally a list of country names the ISO
 *    register already knows, no model is needed. About two thirds of real postings are like this
 *    ("Spain", "Germany, Austria"), and spending a model call on them would be both slower and
 *    less reliable than a map lookup.
 * 2. The model, for everything else: "Home based - EMEA", "Only UTC-6 to UTC-9 time".
 *
 * Whichever pass produced the proposals, the verification gate runs over the result before it is
 * returned. The exact match pass goes through the gate too, so there is exactly one place in the
 * codebase where a country code becomes legitimate.
 */

export type NormalisationMethod = 'exact_match' | 'model';

export interface NormalisationOutcome {
  readonly rawLocationText: string;
  readonly method: NormalisationMethod;
  readonly accepted: readonly AcceptedCode[];
  readonly rejected: readonly Rejection[];
  readonly modelName: string;
  readonly error?: string;
}

const NAME_TO_CODE: ReadonlyMap<string, string> = new Map(
  ISO_3166_1_ALPHA_2.map((country) => [normaliseName(country.name), country.code]),
);

/**
 * A small set of everyday names for countries whose CLDR short name differs from what job boards
 * write. This is not an attempt at fuzzy matching: it is a fixed alias table, and anything not in
 * it falls through to the model rather than being guessed at here.
 */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ['usa', 'US'],
  ['u s a', 'US'],
  ['united states of america', 'US'],
  ['uk', 'GB'],
  ['u k', 'GB'],
  ['great britain', 'GB'],
  ['england', 'GB'],
  ['scotland', 'GB'],
  ['wales', 'GB'],
  ['northern ireland', 'GB'],
  ['republic of ireland', 'IE'],
  ['south korea', 'KR'],
  ['korea', 'KR'],
  ['russia', 'RU'],
  ['russian federation', 'RU'],
  ['czech republic', 'CZ'],
  ['turkey', 'TR'],
  ['ivory coast', 'CI'],
  ['cape verde', 'CV'],
  ['netherlands the', 'NL'],
  ['the netherlands', 'NL'],
  ['hong kong', 'HK'],
  ['macau', 'MO'],
  ['vietnam', 'VN'],
  ['uae', 'AE'],
  ['swaziland', 'SZ'],
  ['macedonia', 'MK'],
  ['bosnia and herzegovina', 'BA'],
  ['trinidad and tobago', 'TT'],
  ['antigua and barbuda', 'AG'],
  ['saint lucia', 'LC'],
  ['sao tome and principe', 'ST'],
  ['democratic republic of the congo', 'CD'],
  ['republic of the congo', 'CG'],
  ['palestine', 'PS'],
  ['laos', 'LA'],
  ['syria', 'SY'],
  ['moldova', 'MD'],
  ['tanzania', 'TZ'],
  ['bolivia', 'BO'],
  ['venezuela', 'VE'],
  ['iran', 'IR'],
  ['brunei', 'BN'],
  ['myanmar', 'MM'],
  ['burma', 'MM'],
  ['timor leste', 'TL'],
  ['east timor', 'TL'],
  ['curacao', 'CW'],
  ['reunion', 'RE'],
  ['aland islands', 'AX'],
]);

function normaliseName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function lookupName(value: string): string | undefined {
  const key = normaliseName(value);
  if (!key) return undefined;
  return NAME_TO_CODE.get(key) ?? ALIASES.get(key);
}

/**
 * Split free text into candidate country names and resolve the ones that are unambiguous.
 *
 * Returns undefined unless every segment resolves. Partial resolution is deliberately not
 * supported: "Germany, EMEA" must go to the model in full rather than silently losing EMEA.
 */
export function resolveExactMatches(rawLocationText: string): string[] | undefined {
  const segments = rawLocationText
    .split(/[,;/]|\bor\b|\band\b|\|/i)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return undefined;

  const codes: string[] = [];
  for (const segment of segments) {
    const code = lookupName(segment);
    if (!code) return undefined;
    codes.push(code);
  }
  return codes;
}

export async function normaliseLocationText(
  rawLocationText: string,
  provider: NormalisationProvider,
): Promise<NormalisationOutcome> {
  const exact = resolveExactMatches(rawLocationText);
  if (exact) {
    const verified = verifyProposedCodes(exact.map((code) => ({ code, confidence: 1 })));
    return {
      rawLocationText,
      method: 'exact_match',
      accepted: verified.accepted,
      rejected: verified.rejected,
      modelName: 'none',
    };
  }

  try {
    const response = await provider.propose(rawLocationText);
    const verified = verifyProposedCodes(response.countries);
    const outcome: NormalisationOutcome = {
      rawLocationText,
      method: 'model',
      accepted: verified.accepted,
      rejected: verified.rejected,
      modelName: provider.modelName,
    };
    if (verified.accepted.length === 0) {
      return {
        ...outcome,
        error:
          verified.rejected.length > 0
            ? `Every proposed code was rejected: ${verified.rejected
                .map((r) => `${r.proposedCode} (${r.reason})`)
                .join(', ')}`
            : 'Model proposed no countries',
      };
    }
    return outcome;
  } catch (error) {
    const message =
      error instanceof ModelResponseError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      rawLocationText,
      method: 'model',
      accepted: [],
      rejected: [],
      modelName: provider.modelName,
      error: message,
    };
  }
}
