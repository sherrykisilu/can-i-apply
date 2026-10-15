import 'reflect-metadata';
import express from 'express';
import type { Express, Request, Response } from 'express';
import type { DataSource } from 'typeorm';
import { loadConfig } from '../config.js';
import { createDataSource } from '../data-source.js';
import { isIsoAlpha2, lookupIsoAlpha2 } from '../iso/countries.js';
import { countEligiblePostings, findEligiblePostings } from '../query/eligibility.js';
import { RejectedCode } from '../entities/RejectedCode.js';

/**
 * A small read only HTTP API over the same query the CLI uses.
 *
 * Three endpoints, no auth, no write paths. The country code is validated against the same ISO
 * register the verification gate uses, so a request for a country that does not exist is a 400
 * rather than an empty result that looks like an answer.
 */
export function createApp(dataSource: DataSource): Express {
  const app = express();

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/eligible/:countryCode', (req: Request, res: Response) => {
    void (async () => {
      const countryCode = String(req.params.countryCode ?? '')
        .trim()
        .toUpperCase();

      if (!isIsoAlpha2(countryCode)) {
        res.status(400).json({
          error: 'unknown_country_code',
          message: `${countryCode} is not an assigned ISO 3166-1 alpha-2 country code`,
        });
        return;
      }

      const limit = clamp(Number.parseInt(String(req.query.limit ?? '25'), 10), 1, 200, 25);
      const offset = clamp(Number.parseInt(String(req.query.offset ?? '0'), 10), 0, 100_000, 0);
      const companySlug = typeof req.query.company === 'string' ? req.query.company : undefined;

      const [postings, total] = await Promise.all([
        findEligiblePostings(dataSource, {
          countryCode,
          limit,
          offset,
          ...(companySlug ? { companySlug } : {}),
        }),
        countEligiblePostings(dataSource, countryCode),
      ]);

      res.json({
        country: { code: countryCode, name: lookupIsoAlpha2(countryCode)?.name },
        total,
        limit,
        offset,
        postings,
      });
    })().catch((error: unknown) => {
      res.status(500).json({ error: 'internal_error', message: describe(error) });
    });
  });

  app.get('/rejections', (req: Request, res: Response) => {
    void (async () => {
      const limit = clamp(Number.parseInt(String(req.query.limit ?? '50'), 10), 1, 500, 50);
      const rows = await dataSource
        .getRepository(RejectedCode)
        .createQueryBuilder('r')
        .orderBy('r.id', 'DESC')
        .take(limit)
        .getMany();

      res.json({
        total: rows.length,
        rejections: rows.map((row) => ({
          proposedCode: row.proposedCode,
          reason: row.reason,
          rawLocationText: row.rawLocationText,
          model: row.model,
        })),
      });
    })().catch((error: unknown) => {
      res.status(500).json({ error: 'internal_error', message: describe(error) });
    });
  });

  return app;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dataSource = createDataSource(config.databaseUrl);
  await dataSource.initialize();
  createApp(dataSource).listen(config.port, () => {
    console.log(`listening on http://localhost:${config.port}`);
  });
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].includes('server');
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(describe(error));
    process.exit(1);
  });
}
