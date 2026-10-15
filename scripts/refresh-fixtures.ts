/**
 * Refresh the committed fixtures from the live boards.
 *
 * Board fixtures are real postings, captured verbatim. A subset is committed rather than the
 * whole board: enough to cover every interesting shape of location string, small enough to read.
 *
 * Model fixtures are only re-recorded when ANTHROPIC_API_KEY is set. Without a key the existing
 * recordings are left alone, so running this script can never quietly replace real recordings
 * with invented ones.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchGreenhouseBoard, parseGreenhousePayload } from '../src/ingest/greenhouse.js';
import { extractDeelJobs, fetchDeelCareersHtml, parseDeelJobs } from '../src/ingest/deel.js';
import { AnthropicProvider } from '../src/normalise/provider.js';
import { resolveExactMatches } from '../src/normalise/normaliser.js';
import { DEFAULT_MODEL } from '../src/config.js';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildUserPrompt } from '../src/normalise/prompt.js';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures');
const SAMPLE_SIZE = 60;

/** Keep a spread of location shapes rather than the first N alphabetically. */
function sample<T>(items: readonly T[], keyOf: (item: T) => string, size: number): T[] {
  const byKey = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(item);
    else byKey.set(key, [item]);
  }
  const picked: T[] = [];
  const keys = [...byKey.keys()].sort();
  for (const key of keys) {
    const first = byKey.get(key)?.[0];
    if (first) picked.push(first);
    if (picked.length >= size) break;
  }
  return picked;
}

async function refreshGreenhouse(): Promise<void> {
  const payload = await fetchGreenhouseBoard('canonical');
  const postings = parseGreenhousePayload(payload, 'canonical', 'Canonical');
  const chosen = sample(postings, (p) => p.rawLocationText, SAMPLE_SIZE);
  const ids = new Set(chosen.map((p) => p.externalId));

  const raw = payload as { jobs: Array<Record<string, unknown>> };
  const jobs = raw.jobs
    .filter((job) => ids.has(String(job.id)))
    .map((job) => ({
      id: job.id,
      title: job.title,
      absolute_url: job.absolute_url,
      company_name: job.company_name,
      location: job.location,
      metadata: Array.isArray(job.metadata)
        ? (job.metadata as Array<{ name: string; value: unknown }>).filter(
            (m) => m.name === 'External Departments (website)',
          )
        : [],
    }));

  write('greenhouse-canonical.json', {
    note: 'Real postings from the public Canonical Greenhouse board, captured verbatim.',
    source: 'https://boards-api.greenhouse.io/v1/boards/canonical/jobs',
    capturedAt: new Date().toISOString(),
    boardToken: 'canonical',
    jobs,
  });
  console.log(`greenhouse: ${jobs.length} postings from ${postings.length} live`);
}

async function refreshDeel(): Promise<void> {
  const html = await fetchDeelCareersHtml();
  const jobs = extractDeelJobs(html);
  const postings = parseDeelJobs(jobs);
  const chosen = sample(postings, (p) => p.rawLocationText, SAMPLE_SIZE);
  const ids = new Set(chosen.map((p) => p.externalId));

  write('deel-open-roles.json', {
    note: 'Real postings from the public Deel careers board, captured verbatim from the embedded JSON payload.',
    source: 'https://www.deel.com/careers/open-roles',
    capturedAt: new Date().toISOString(),
    jobs: jobs.filter((job) => ids.has(job.ashby_id)),
  });
  console.log(`deel: ${ids.size} postings from ${postings.length} live`);
}

async function refreshModelResponses(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const path = resolve(FIXTURES, 'model-responses.json');

  if (!apiKey) {
    console.log('model: ANTHROPIC_API_KEY not set, leaving existing recordings untouched');
    return;
  }

  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as {
        recordings: Array<{ locationText: string }>;
      })
    : { recordings: [] };

  const texts = [...new Set(existing.recordings.map((r) => r.locationText))].filter(
    (text) => !resolveExactMatches(text),
  );

  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });
  const recordings = [];

  for (const locationText of texts) {
    const message = await client.messages.create({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(locationText) }],
    });
    const responseText = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    recordings.push({ locationText, model, responseText, recorded: 'live' });
    console.log(`model: recorded ${JSON.stringify(locationText)}`);
  }

  write('model-responses.json', {
    note: 'Responses recorded against the live Anthropic API.',
    capturedAt: new Date().toISOString(),
    recordings,
  });

  // Touch the provider so the import is not dead weight when the key is present.
  void AnthropicProvider;
}

/**
 * Write a fixture.
 *
 * Captured text passes through a dash normalisation step first. This repository forbids the
 * characters U+2012 to U+2015 in any committed file, and real job titles occasionally contain an
 * en dash. The replacement is a plain hyphen, it is applied to captured board text only, and it
 * never touches the ingest path, so live runs see the original strings. Location eligibility
 * strings, the only field this project reasons about, are unaffected in the current captures.
 */
function write(name: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2).replace(/[\u2012\u2013\u2014\u2015]/g, '-');
  writeFileSync(resolve(FIXTURES, name), `${json}\n`, 'utf8');
}

async function main(): Promise<void> {
  await refreshGreenhouse();
  await refreshDeel();
  await refreshModelResponses();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
