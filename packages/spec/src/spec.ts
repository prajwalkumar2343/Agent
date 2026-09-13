import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import { flagKeyFor, slugify, type Spec } from '../../shared/src/index.ts';

export const SpecSchema = z.object({
  title: z.string().min(1).max(80),
  summary: z.string().min(1).max(500),
  acceptance: z.array(z.string().min(1)).min(1).max(8),
});

const SYSTEM = `You turn one-line Slack feature ideas into tight spec cards.
Rules: title is a concrete feature name (≤6 words), summary is one paragraph
of user-visible behavior, acceptance is 1-8 testable criteria phrased as
"user can …". Do not invent scope the idea didn't ask for.`;

/**
 * Idea → Spec card. Slug is derived here (not by the model) so flag_key
 * stays deterministic per docs/CONTRACTS.md naming rules.
 */
export async function generateSpec(idea: string, model: LanguageModel): Promise<Spec> {
  const { object } = await generateObject({
    model,
    schema: SpecSchema,
    system: SYSTEM,
    prompt: idea,
  });
  return { ...object, slug: slugify(object.title) };
}

/** Convenience wrapper for the flag key a spec will deploy under. */
export function flagKeyForSpec(spec: Spec): string {
  return flagKeyFor(spec.slug || spec.title);
}
