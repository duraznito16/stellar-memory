/**
 * The optional AI layer.
 *
 * Everything else in this tool is deterministic. This module is the one place
 * that infers, and it is strictly additive: `scan`, `resume` and `graph` never
 * call it, and `explain` falls back to ranked search when it is unavailable.
 *
 * The model is given the project digest and nothing else, and is told to answer
 * only from it. A memory that confidently invents a contract is worse than no
 * memory at all.
 */

import type { ProjectMemory } from '../core/types.js';
import { contextDigest } from '../core/query.js';

/** Opus 5 is the default; override for cost or latency with STELLAR_MEMORY_MODEL. */
const DEFAULT_MODEL = 'claude-opus-5';
const MAX_TOKENS = 16_000;

export interface AiAnswer {
  text: string;
  model: string;
}

export class AiUnavailable extends Error {}

const SYSTEM = [
  'You are the memory of a Stellar/Soroban project, answering its developer.',
  '',
  'You are given a factual digest produced by static analysis of the repository',
  'and by read-only queries to the Stellar CLI. Answer only from that digest.',
  '',
  'Rules:',
  '- If the digest does not contain the answer, say so plainly and name what',
  '  would need to be scanned or deployed to find out. Never invent contracts,',
  '  functions, addresses, or behaviour.',
  '- Cite concrete anchors — contract names, function names, file paths,',
  '  contract IDs — so the developer can verify you.',
  '- Prefer explaining how the pieces relate over restating the list.',
  '- Be brief. A returning developer wants orientation, not an essay.',
].join('\n');

export async function answerWithAi(
  memory: ProjectMemory,
  question: string,
): Promise<AiAnswer> {
  const Anthropic = await loadSdk();
  const model = process.env.STELLAR_MEMORY_MODEL ?? DEFAULT_MODEL;

  try {
    // Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or a
    // profile created by `ant auth login` — so do not demand an env var here.
    // Constructed inside the try because the SDK floats on a caret range and
    // has validated credentials from the constructor before; anything thrown
    // out here reaches the user as a stack trace instead of the fallback.
    const client = new Anthropic();
    const digest = contextDigest(memory);

    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `<project_digest>\n${digest}\n</project_digest>\n\nQuestion: ${question}`,
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      throw new AiUnavailable('The model declined to answer this question.');
    }

    const text = response.content
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { text: string }) => block.text)
      .join('\n')
      .trim();

    if (!text) throw new AiUnavailable('The model returned an empty answer.');
    return { text, model: response.model ?? model };
  } catch (error) {
    throw translate(error);
  }
}

/**
 * The SDK is an optional dependency, so a developer who only wants the
 * deterministic half never has to install it.
 */
async function loadSdk(): Promise<new (opts?: unknown) => AnthropicLike> {
  try {
    const mod = await import('@anthropic-ai/sdk');
    return (mod.default ?? mod) as unknown as new (opts?: unknown) => AnthropicLike;
  } catch {
    throw new AiUnavailable(
      'The AI layer needs @anthropic-ai/sdk. Install it with `npm install @anthropic-ai/sdk`, ' +
        'or drop --ai to use deterministic search.',
    );
  }
}

interface AnthropicLike {
  messages: {
    create(params: unknown): Promise<{
      content: { type: string; text: string }[];
      model?: string;
      stop_reason?: string;
    }>;
  };
}

function translate(error: unknown): Error {
  if (error instanceof AiUnavailable) return error;
  const status = (error as { status?: number })?.status;
  const message = error instanceof Error ? error.message : String(error);

  // With no credentials the SDK throws while it builds the request headers,
  // before a socket is opened, so this arrives as a plain Error with no status
  // to match on. It is the most likely failure of all — most people run this
  // without a key — and it deserves the instructions, not the SDK's wording.
  if (/authentication method|apiKey|authToken/i.test(message) && status === undefined) {
    return new AiUnavailable(
      'No Anthropic credentials found. Set ANTHROPIC_API_KEY, or run `ant auth login`. ' +
        'Without --ai the same question is answered from the local index.',
    );
  }

  if (status === 401) {
    return new AiUnavailable(
      'No usable Anthropic credentials. Set ANTHROPIC_API_KEY, or run `ant auth login`. ' +
        'Drop --ai to answer from the local index instead.',
    );
  }
  if (status === 429) {
    return new AiUnavailable('Rate limited by the Anthropic API. Try again shortly.');
  }
  if (status === 404) {
    return new AiUnavailable(
      `Model "${process.env.STELLAR_MEMORY_MODEL ?? DEFAULT_MODEL}" was not found. ` +
        'Check STELLAR_MEMORY_MODEL.',
    );
  }
  return new AiUnavailable(`The AI layer failed: ${message}`);
}
