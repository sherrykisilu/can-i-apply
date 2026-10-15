import { z } from 'zod';
import type { RawPosting } from './types.js';

/**
 * The Deel careers board.
 *
 * Deel does not publish a JSON endpoint. The board is server rendered and the posting data is
 * embedded in the page as escaped JSON inside the React streaming payload, so ingesting it means
 * recovering that JSON rather than scraping markup. Each posting carries location_name (a single
 * string) and all_locations (an array), and the two disagree often enough that both are kept:
 * all_locations is used when present because it is the fuller statement of eligibility.
 */

export const DEEL_CAREERS_URL = 'https://www.deel.com/careers/open-roles';

const deelJobSchema = z.object({
  ashby_id: z.string(),
  title: z.string(),
  department_name: z.string().nullable().optional(),
  location_name: z.string().nullable().optional(),
  all_locations: z.array(z.string()).nullable().optional(),
  external_link: z.string().nullable().optional(),
  is_listed: z.boolean().optional(),
});

export type DeelJob = z.infer<typeof deelJobSchema>;

/**
 * Recover the embedded posting objects from the careers page HTML.
 *
 * The payload is JSON that has been escaped for embedding in a JavaScript string literal, so the
 * escaping is undone first and then each object is read with a brace matcher that is aware of
 * string literals. A regex alone cannot do this correctly because the objects nest.
 */
export function extractDeelJobs(html: string): DeelJob[] {
  const unescaped = html.replace(/\\"/g, '"');
  const marker = '{"ashby_id":';
  const jobs: DeelJob[] = [];
  const seen = new Set<string>();

  let cursor = unescaped.indexOf(marker);
  while (cursor !== -1) {
    const block = readBalancedObject(unescaped, cursor);
    if (block) {
      const parsed = deelJobSchema.safeParse(safeJsonParse(block));
      if (parsed.success && !seen.has(parsed.data.ashby_id)) {
        seen.add(parsed.data.ashby_id);
        jobs.push(parsed.data);
      }
    }
    cursor = unescaped.indexOf(marker, cursor + marker.length);
  }

  return jobs;
}

export function parseDeelJobs(jobs: readonly DeelJob[]): RawPosting[] {
  const postings: RawPosting[] = [];

  for (const job of jobs) {
    if (job.is_listed === false) continue;

    const all = job.all_locations?.map((value) => value.trim()).filter(Boolean) ?? [];
    const rawLocationText = all.length > 0 ? all.join(', ') : (job.location_name?.trim() ?? '');
    if (!rawLocationText) continue;

    postings.push({
      source: 'deel',
      externalId: job.ashby_id,
      companySlug: 'deel',
      companyName: 'Deel',
      title: job.title,
      department: job.department_name?.slice(0, 128) ?? null,
      url: job.external_link ?? `https://jobs.deel.com/deel/job-details/${job.ashby_id}`,
      rawLocationText,
    });
  }

  return postings;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readBalancedObject(source: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return undefined;
}

export async function fetchDeelCareersHtml(): Promise<string> {
  const response = await fetch(DEEL_CAREERS_URL, {
    headers: { accept: 'text/html' },
  });
  if (!response.ok) {
    throw new Error(`Deel careers page responded ${response.status} ${response.statusText}`);
  }
  return response.text();
}
