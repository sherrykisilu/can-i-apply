import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGreenhousePayload } from '../src/ingest/greenhouse.js';
import { extractDeelJobs, parseDeelJobs } from '../src/ingest/deel.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const greenhouse = fixture('greenhouse-canonical.json');
const deel = fixture('deel-open-roles.json') as { jobs: unknown[] };

describe('greenhouse ingest', () => {
  const postings = parseGreenhousePayload(greenhouse, 'canonical', 'Canonical');

  it('reads real postings from the committed board capture', () => {
    expect(postings.length).toBeGreaterThan(10);
    expect(postings.every((p) => p.source === 'greenhouse')).toBe(true);
    expect(postings.every((p) => p.externalId.length > 0)).toBe(true);
  });

  it('keeps the location string verbatim', () => {
    const emea = postings.find((p) => p.rawLocationText === 'Home based - EMEA');
    expect(emea, 'expected the regex defeating string in the capture').toBeDefined();
    expect(emea?.url).toContain('greenhouse.io');
  });

  it('skips postings with no location text rather than inventing one', () => {
    const parsed = parseGreenhousePayload(
      { jobs: [{ id: 1, title: 'x', absolute_url: 'u', location: { name: '  ' } }] },
      'canonical',
    );
    expect(parsed).toEqual([]);
  });
});

describe('deel ingest', () => {
  const jobs = extractDeelJobs(JSON.stringify(deel.jobs));
  const postings = parseDeelJobs(jobs);

  it('recovers postings from the embedded payload', () => {
    expect(jobs.length).toBeGreaterThan(10);
    expect(postings.length).toBe(jobs.length);
  });

  it('prefers all_locations over the single location_name', () => {
    const multi = postings.find((p) => p.rawLocationText.includes(','));
    expect(multi).toBeDefined();
  });

  it('handles the nested objects that a regex alone would truncate', () => {
    const html = `prefix {"ashby_id":"abc","title":"Engineer","location_name":"Kenya","all_locations":["Kenya"],"nested":{"a":{"b":"}"}},"external_link":"https://example.com"} suffix`;
    const recovered = extractDeelJobs(html);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.title).toBe('Engineer');
  });

  it('unescapes a payload embedded in a JavaScript string literal', () => {
    const escaped = 'x.push("{\\"ashby_id\\":\\"z1\\",\\"title\\":\\"Dev\\",\\"all_locations\\":[\\"Spain\\"]}")';
    const recovered = extractDeelJobs(escaped);
    expect(recovered[0]?.ashby_id).toBe('z1');
    expect(recovered[0]?.all_locations).toEqual(['Spain']);
  });
});

describe('the strings that defeat a regex', () => {
  const all = [
    ...parseGreenhousePayload(greenhouse, 'canonical', 'Canonical'),
    ...parseDeelJobs(extractDeelJobs(JSON.stringify(deel.jobs))),
  ];

  it('includes a posting whose eligibility is a region, not a country', () => {
    expect(all.some((p) => /EMEA|APAC|Americas|Worldwide/i.test(p.rawLocationText))).toBe(true);
  });

  it('includes a posting that names a city alongside countries', () => {
    const berlin = all.find((p) => p.rawLocationText.startsWith('Berlin,'));
    expect(berlin, 'expected the Berlin plus 29 countries posting').toBeDefined();
  });

  it('includes a posting naming a place with no ISO 3166-1 code', () => {
    expect(all.some((p) => p.rawLocationText.includes('Kosovo'))).toBe(true);
  });
});
