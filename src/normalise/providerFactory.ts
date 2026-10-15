import { loadConfig } from '../config.js';
import { AnthropicProvider, ReplayProvider } from './provider.js';
import type { NormalisationProvider, RecordedResponse } from './provider.js';
import { readFileSync } from 'node:fs';

/**
 * Choosing a provider.
 *
 * Live API when a key is present, replay otherwise. This is the single place that decision is
 * made, so no other module has to care whether it is talking to a model or to a recording.
 */
export function createProvider(
  config: Pick<ReturnType<typeof loadConfig>, 'anthropicApiKey' | 'anthropicModel'>,
): NormalisationProvider {
  if (config.anthropicApiKey) {
    return new AnthropicProvider(config.anthropicApiKey, config.anthropicModel);
  }
  return new ReplayProvider(loadRecordings(), 'replay');
}

interface RecordingsFile {
  recordings: RecordedResponse[];
}

export function loadRecordings(
  path = new URL('../../tests/fixtures/model-responses.json', import.meta.url),
): RecordedResponse[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RecordingsFile;
  return parsed.recordings;
}
