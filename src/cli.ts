#!/usr/bin/env node
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import type { DataSource } from 'typeorm';
import { loadConfig } from './config.js';
import { createDataSource } from './data-source.js';
import { fetchGreenhouseBoard, parseGreenhousePayload } from './ingest/greenhouse.js';
import { extractDeelJobs, fetchDeelCareersHtml, parseDeelJobs } from './ingest/deel.js';
import { ingestPostings, seedLocations } from './ingest/ingestService.js';
import type { RawPosting } from './ingest/types.js';
import { normalisePendingPostings } from './normalise/normalisationService.js';
import { createProvider } from './normalise/providerFactory.js';
import {
  countEligiblePostings,
  explainEligibilityQuery,
  findEligiblePostings,
} from './query/eligibility.js';
import { RejectedCode } from './entities/RejectedCode.js';

const USAGE = `can-i-apply

  ingest [--source greenhouse|deel|all] [--board <token>] [--fixtures]
      Pull postings from a board and store them. --fixtures reads the committed sample instead
      of the network, which is how to try this without hitting anyone's servers.

  normalise [--limit <n>] [--all]
      Turn stored location text into verified country codes. Uses the live model when
      ANTHROPIC_API_KEY is set and recorded responses otherwise.

  eligible --country <ISO alpha-2> [--limit <n>] [--company <slug>]
      List postings a resident of that country could hold.

  rejections [--limit <n>]
      Show country codes the verification gate refused.

  explain --country <ISO alpha-2>
      Print EXPLAIN ANALYZE for the eligibility query exactly as it runs.
`;

function arg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function fixturePostings(source: string, board: string): RawPosting[] {
  const read = (file: string): unknown =>
    JSON.parse(readFileSync(new URL(`../tests/fixtures/${file}`, import.meta.url), 'utf8'));

  const postings: RawPosting[] = [];
  if (source === 'greenhouse' || source === 'all') {
    postings.push(...parseGreenhousePayload(read('greenhouse-canonical.json'), board, 'Canonical'));
  }
  if (source === 'deel' || source === 'all') {
    const payload = read('deel-open-roles.json') as { jobs: unknown[] };
    postings.push(...parseDeelJobs(extractDeelJobs(JSON.stringify(payload.jobs))));
  }
  return postings;
}

async function commandIngest(dataSource: DataSource, argv: readonly string[]): Promise<void> {
  const source = arg(argv, 'source') ?? 'all';
  const board = arg(argv, 'board') ?? 'canonical';

  const seeded = await seedLocations(dataSource);
  if (seeded > 0) console.log(`seeded ${seeded} countries`);

  let postings: RawPosting[];
  if (flag(argv, 'fixtures')) {
    postings = fixturePostings(source, board);
    console.log(`read ${postings.length} postings from committed fixtures`);
  } else {
    postings = [];
    if (source === 'greenhouse' || source === 'all') {
      const payload = await fetchGreenhouseBoard(board);
      postings.push(...parseGreenhousePayload(payload, board));
    }
    if (source === 'deel' || source === 'all') {
      postings.push(...parseDeelJobs(extractDeelJobs(await fetchDeelCareersHtml())));
    }
    console.log(`fetched ${postings.length} postings`);
  }

  const summary = await ingestPostings(dataSource, postings);
  console.log(
    `inserted ${summary.inserted}, updated ${summary.updated}, unchanged ${summary.unchanged}`,
  );
}

async function commandNormalise(dataSource: DataSource, argv: readonly string[]): Promise<void> {
  const config = loadConfig();
  const provider = createProvider(config);
  console.log(`provider: ${provider.modelName}`);

  const limitValue = arg(argv, 'limit');
  const summary = await normalisePendingPostings(dataSource, provider, {
    ...(limitValue ? { limit: Number.parseInt(limitValue, 10) } : {}),
    includeNormalised: flag(argv, 'all'),
  });

  console.log(
    `processed ${summary.processed}, normalised ${summary.normalised}, failed ${summary.failed}`,
  );
  console.log(
    `wrote ${summary.edgesWritten} eligibility edges, gate rejected ${summary.codesRejected} proposed codes`,
  );
}

async function commandEligible(dataSource: DataSource, argv: readonly string[]): Promise<void> {
  const country = arg(argv, 'country');
  if (!country) throw new Error('eligible requires --country, for example --country KE');

  const limitValue = arg(argv, 'limit');
  const companySlug = arg(argv, 'company');
  const results = await findEligiblePostings(dataSource, {
    countryCode: country,
    limit: limitValue ? Number.parseInt(limitValue, 10) : 25,
    ...(companySlug ? { companySlug } : {}),
  });

  const total = await countEligiblePostings(dataSource, country);
  console.log(`${total} postings open to a resident of ${country.toUpperCase()}\n`);

  for (const posting of results) {
    const confidence = posting.confidence === null ? 'exact' : posting.confidence.toFixed(2);
    console.log(`${posting.title}`);
    console.log(`  ${posting.company}  [${posting.derivation} ${confidence}]`);
    console.log(`  says: ${truncate(posting.rawLocationText, 110)}`);
    console.log(`  ${posting.url}\n`);
  }
}

async function commandRejections(dataSource: DataSource, argv: readonly string[]): Promise<void> {
  const limitValue = arg(argv, 'limit');
  const rows = await dataSource
    .getRepository(RejectedCode)
    .createQueryBuilder('r')
    .orderBy('r.id', 'ASC')
    .take(limitValue ? Number.parseInt(limitValue, 10) : 20)
    .getMany();

  if (rows.length === 0) {
    console.log('the gate has rejected nothing');
    return;
  }

  console.log(`${rows.length} rejected codes\n`);
  for (const row of rows) {
    console.log(`${row.proposedCode}  ${row.reason}  (model: ${row.model})`);
    console.log(`  from: ${truncate(row.rawLocationText, 110)}\n`);
  }
}

async function commandExplain(dataSource: DataSource, argv: readonly string[]): Promise<void> {
  const country = arg(argv, 'country');
  if (!country) throw new Error('explain requires --country, for example --country KE');
  const plan = await explainEligibilityQuery(dataSource, { countryCode: country, limit: 50 });
  for (const line of plan) console.log(line);
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  const dataSource = createDataSource(config.databaseUrl);
  await dataSource.initialize();

  try {
    switch (command) {
      case 'ingest':
        await commandIngest(dataSource, argv);
        break;
      case 'normalise':
        await commandNormalise(dataSource, argv);
        break;
      case 'eligible':
        await commandEligible(dataSource, argv);
        break;
      case 'rejections':
        await commandRejections(dataSource, argv);
        break;
      case 'explain':
        await commandExplain(dataSource, argv);
        break;
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
