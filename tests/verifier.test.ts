import { describe, expect, it } from 'vitest';
import { verifyProposedCodes } from '../src/normalise/verifier.js';
import { isoCountryCount, isIsoAlpha2 } from '../src/iso/countries.js';

describe('ISO register', () => {
  it('holds exactly the 249 assigned alpha-2 codes', () => {
    expect(isoCountryCount()).toBe(249);
  });

  it('excludes codes that are reserved rather than assigned', () => {
    for (const code of ['UK', 'EU', 'EZ', 'XK', 'AN', 'SU', 'YU', 'ZZ']) {
      expect(isIsoAlpha2(code)).toBe(false);
    }
  });
});

describe('verification gate', () => {
  it('accepts real codes and returns the register name, not the model name', () => {
    const result = verifyProposedCodes([{ code: 'KE', confidence: 0.9 }]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([{ code: 'KE', countryName: 'Kenya', confidence: 0.9 }]);
  });

  it('rejects a hallucinated country code', () => {
    // The real failure this gate exists for. Several Deel postings list Kosovo, and a model asked
    // for its code reaches for XK. XK is user assigned, not an assigned ISO 3166-1 country.
    const result = verifyProposedCodes([
      { code: 'DE', confidence: 0.95 },
      { code: 'XK', confidence: 0.74 },
    ]);

    expect(result.accepted.map((a) => a.code)).toEqual(['DE']);
    expect(result.rejected).toEqual([{ proposedCode: 'XK', reason: 'not_iso_3166_1' }]);
  });

  it('rejects UK and EU, which are the codes a guessing model reaches for', () => {
    const result = verifyProposedCodes([
      { code: 'UK', confidence: 0.99 },
      { code: 'EU', confidence: 0.99 },
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual(['not_iso_3166_1', 'not_iso_3166_1']);
  });

  it('normalises case and surrounding whitespace but forgives nothing else', () => {
    const result = verifyProposedCodes([{ code: ' ke ', confidence: 0.5 }]);
    expect(result.accepted.map((a) => a.code)).toEqual(['KE']);
  });

  it('rejects anything that is not two letters', () => {
    const result = verifyProposedCodes([
      { code: 'KEN', confidence: 0.9 },
      { code: '', confidence: 0.9 },
      { code: 'Kenya', confidence: 0.9 },
      { code: 'K1', confidence: 0.9 },
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'malformed',
      'malformed',
      'malformed',
      'malformed',
    ]);
  });

  it('rejects confidence outside 0 to 1 rather than clamping it', () => {
    const result = verifyProposedCodes([
      { code: 'FR', confidence: 1.4 },
      { code: 'IT', confidence: Number.NaN },
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'confidence_out_of_range',
      'confidence_out_of_range',
    ]);
  });

  it('keeps the first of a duplicated code and records the rest', () => {
    const result = verifyProposedCodes([
      { code: 'ES', confidence: 0.9 },
      { code: 'es', confidence: 0.2 },
    ]);
    expect(result.accepted).toEqual([{ code: 'ES', countryName: 'Spain', confidence: 0.9 }]);
    expect(result.rejected).toEqual([{ proposedCode: 'ES', reason: 'duplicate' }]);
  });

  it('never lets a rejected code through by returning it in accepted', () => {
    const proposals = ['XK', 'UK', 'EU', 'ZZ', 'QQ', 'XX'].map((code) => ({
      code,
      confidence: 1,
    }));
    const result = verifyProposedCodes(proposals);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(proposals.length);
  });
});
