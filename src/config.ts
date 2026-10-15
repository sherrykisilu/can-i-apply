/**
 * Process configuration.
 *
 * Reads .env if present, but never requires it: everything that is optional has a default and
 * the one thing that is not optional (the database URL) fails loudly rather than silently
 * connecting somewhere unexpected.
 */

export interface AppConfig {
  readonly databaseUrl: string;
  readonly anthropicApiKey: string | undefined;
  readonly anthropicModel: string;
  readonly port: number;
}

export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d` and export it.',
    );
  }

  const port = Number.parseInt(env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got ${String(env.PORT)}`);
  }

  return {
    databaseUrl,
    anthropicApiKey: env.ANTHROPIC_API_KEY ? env.ANTHROPIC_API_KEY : undefined,
    anthropicModel: env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
    port,
  };
}
