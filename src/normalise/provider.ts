import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

/**
 * Model providers.
 *
 * There are two. AnthropicProvider talks to the real API. ReplayProvider answers from a recorded
 * fixture and refuses to invent anything, which is what lets the whole suite run with no API key
 * and no network. The normalisation pipeline is written against the interface, so the code under
 * test in CI is the same code that runs in production, with only the transport swapped.
 */

/** The raw, unverified shape a model is asked to return. Parsed, not trusted. */
export const modelResponseSchema = z.object({
  countries: z.array(
    z.object({
      code: z.string(),
      confidence: z.number(),
    }),
  ),
  reasoning: z.string().optional(),
});

export type ModelResponse = z.infer<typeof modelResponseSchema>;

export interface NormalisationProvider {
  readonly modelName: string;
  propose(rawLocationText: string): Promise<ModelResponse>;
}

export class ModelResponseError extends Error {
  constructor(
    message: string,
    readonly rawText: string,
  ) {
    super(message);
    this.name = 'ModelResponseError';
  }
}

/**
 * Parse a model's text output into the expected shape.
 *
 * Tolerates a surrounding code fence and leading prose, because models add them, but does not
 * repair the contents. A response that is not JSON of the right shape is an error, not something
 * to guess at.
 */
export function parseModelText(text: string): ModelResponse {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? sliceFirstJsonObject(text) ?? text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.trim());
  } catch {
    throw new ModelResponseError('Model response was not valid JSON', text);
  }

  const result = modelResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new ModelResponseError(
      `Model response did not match the expected shape: ${result.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
      text,
    );
  }
  return result.data;
}

function sliceFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

export class AnthropicProvider implements NormalisationProvider {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly modelName: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async propose(rawLocationText: string): Promise<ModelResponse> {
    const message = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(rawLocationText) }],
    });

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    if (!text.trim()) {
      throw new ModelResponseError('Model returned no text content', '');
    }
    return parseModelText(text);
  }
}

/** A recorded model response, keyed by the exact location text that produced it. */
export interface RecordedResponse {
  readonly locationText: string;
  readonly model: string;
  readonly responseText: string;
}

/**
 * Replays recorded responses.
 *
 * Mirrors the replay provider pattern used in the groundwork toolkit: the test suite exercises
 * the real parsing and verification path against real model output captured once, rather than
 * against hand written mocks that drift away from what the model actually emits.
 */
export class ReplayProvider implements NormalisationProvider {
  private readonly byText: Map<string, RecordedResponse>;

  constructor(
    recordings: readonly RecordedResponse[],
    readonly modelName = 'replay',
  ) {
    this.byText = new Map(recordings.map((r) => [r.locationText, r]));
  }

  async propose(rawLocationText: string): Promise<ModelResponse> {
    const recorded = this.byText.get(rawLocationText);
    if (!recorded) {
      throw new ModelResponseError(
        `No recorded model response for location text ${JSON.stringify(rawLocationText)}. ` +
          'Record one with `npm run fixtures:refresh` rather than loosening this check.',
        '',
      );
    }
    return parseModelText(recorded.responseText);
  }
}
