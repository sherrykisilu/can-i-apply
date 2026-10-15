import { z } from 'zod';
import type { RawPosting } from './types.js';

/**
 * Greenhouse job boards.
 *
 * Public and unauthenticated: https://boards-api.greenhouse.io/v1/boards/{token}/jobs
 * Location eligibility lives in a single free text field, location.name, which is where strings
 * such as "Home based - EMEA" come from.
 */

export const GREENHOUSE_API_BASE = 'https://boards-api.greenhouse.io/v1/boards';

const greenhouseJobSchema = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  company_name: z.string().optional(),
  location: z.object({ name: z.string() }).optional(),
  metadata: z
    .array(
      z.object({
        name: z.string(),
        value: z.unknown(),
      }),
    )
    .optional(),
});

const greenhousePayloadSchema = z.object({
  jobs: z.array(greenhouseJobSchema),
});

export type GreenhousePayload = z.infer<typeof greenhousePayloadSchema>;

export function parseGreenhousePayload(
  payload: unknown,
  boardToken: string,
  companyName?: string,
): RawPosting[] {
  const parsed = greenhousePayloadSchema.parse(payload);
  const postings: RawPosting[] = [];

  for (const job of parsed.jobs) {
    const rawLocationText = job.location?.name?.trim() ?? '';
    if (!rawLocationText) continue;

    postings.push({
      source: 'greenhouse',
      externalId: String(job.id),
      companySlug: boardToken,
      companyName: job.company_name ?? companyName ?? boardToken,
      title: job.title,
      department: readDepartment(job.metadata),
      url: job.absolute_url,
      rawLocationText,
    });
  }

  return postings;
}

function readDepartment(
  metadata: ReadonlyArray<{ name: string; value: unknown }> | undefined,
): string | null {
  const entry = metadata?.find((item) => item.name === 'External Departments (website)');
  if (!entry) return null;
  const value = entry.value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].slice(0, 128);
  if (typeof value === 'string') return value.slice(0, 128);
  return null;
}

export async function fetchGreenhouseBoard(boardToken: string): Promise<unknown> {
  const response = await fetch(`${GREENHOUSE_API_BASE}/${boardToken}/jobs`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `Greenhouse board ${boardToken} responded ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}
