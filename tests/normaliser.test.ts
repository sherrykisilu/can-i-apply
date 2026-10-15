import { describe, expect, it } from 'vitest';
import { ModelResponseError, ReplayProvider, parseModelText } from '../src/normalise/provider.js';
import { normaliseLocationText, resolveExactMatches } from '../src/normalise/normaliser.js';
import { loadRecordings } from '../src/normalise/providerFactory.js';

const recordings = loadRecordings();
const provider = new ReplayProvider(recordings);

describe('exact match pass', () => {
  it('resolves plain country names without consulting a model', () => {
    expect(resolveExactMatches('Spain')).toEqual(['ES']);
    expect(resolveExactMatches('Spain, Portugal, Germany, Austria')).toEqual([
      'ES',
      'PT',
      'DE',
      'AT',
    ]);
  });

  it('resolves everyday names that differ from the register short name', () => {
    expect(resolveExactMatches('USA')).toEqual(['US']);
    expect(resolveExactMatches('United Kingdom')).toEqual(['GB']);
  });

  it('refuses partial resolution, so mixed text goes to the model in full', () => {
    // If this returned ['DE'] the EMEA half would vanish silently.
    expect(resolveExactMatches('Germany, EMEA')).toBeUndefined();
    expect(resolveExactMatches('Home based - EMEA')).toBeUndefined();
    expect(resolveExactMatches('Berlin')).toBeUndefined();
  });
});

describe('model response parsing', () => {
  it('reads a plain JSON response', () => {
    const parsed = parseModelText('{"countries":[{"code":"KE","confidence":0.9}]}');
    expect(parsed.countries).toEqual([{ code: 'KE', confidence: 0.9 }]);
  });

  it('reads a response the model wrapped in a code fence', () => {
    const parsed = parseModelText('Sure:\n```json\n{"countries":[{"code":"FR","confidence":1}]}\n```');
    expect(parsed.countries).toEqual([{ code: 'FR', confidence: 1 }]);
  });

  it('errors rather than guessing when the shape is wrong', () => {
    expect(() => parseModelText('{"countries":"everywhere"}')).toThrow(ModelResponseError);
    expect(() => parseModelText('no json here')).toThrow(ModelResponseError);
  });
});

describe('replay provider', () => {
  it('answers from recordings with no network and no API key', async () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeFalsy();
    const response = await provider.propose('Home based - EMEA');
    expect(response.countries.length).toBeGreaterThan(20);
    expect(response.countries.map((c) => c.code)).toContain('KE');
  });

  it('refuses to invent a response for text it has not seen', async () => {
    await expect(provider.propose('Somewhere nobody recorded')).rejects.toThrow(ModelResponseError);
  });
});

describe('normalisation end to end, offline', () => {
  it('defeats the regex case: Home based - EMEA includes Kenya', async () => {
    const outcome = await normaliseLocationText('Home based - EMEA', provider);
    expect(outcome.method).toBe('model');
    expect(outcome.accepted.map((a) => a.code)).toContain('KE');
    expect(outcome.error).toBeUndefined();
  });

  it('Home Based - Americas does not include Kenya', async () => {
    const outcome = await normaliseLocationText('Home Based - Americas', provider);
    expect(outcome.accepted.map((a) => a.code)).not.toContain('KE');
    expect(outcome.accepted.map((a) => a.code)).toContain('US');
  });

  it('a city resolves to its country', async () => {
    const outcome = await normaliseLocationText('Office Based - London, UK', provider);
    expect(outcome.accepted.map((a) => a.code)).toEqual(['GB']);
  });

  it('exact match text never reaches the model', async () => {
    const outcome = await normaliseLocationText('Spain, Portugal', new ReplayProvider([]));
    expect(outcome.method).toBe('exact_match');
    expect(outcome.accepted.map((a) => a.code)).toEqual(['ES', 'PT']);
  });

  it('drops the hallucinated code and keeps the real ones from the same response', async () => {
    const withKosovo = recordings.find((r) => r.responseText.includes('"XK"'));
    expect(withKosovo, 'expected a recording that proposes XK').toBeDefined();

    const outcome = await normaliseLocationText(withKosovo!.locationText, provider);
    expect(outcome.accepted.map((a) => a.code)).not.toContain('XK');
    expect(outcome.rejected).toContainEqual({ proposedCode: 'XK', reason: 'not_iso_3166_1' });
    expect(outcome.accepted.length).toBeGreaterThan(5);
  });

  it('reports an error instead of throwing when the provider fails', async () => {
    const outcome = await normaliseLocationText('Not in the recordings', provider);
    expect(outcome.accepted).toEqual([]);
    expect(outcome.error).toContain('No recorded model response');
  });
});
