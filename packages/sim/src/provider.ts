import type { Evidence, FeatureCheck, SimReport, Spec } from '../../shared/src/index.ts';

/**
 * What the audience simulation sees. Providers must treat this as untrusted
 * input (it embeds LLM-generated spec text) and only ever read it.
 */
export interface SimInput {
  spec: Spec;
  feature_check?: FeatureCheck;
  evidence?: Evidence;
  pr_url?: string;
}

/**
 * Audience-simulation port — A6 owns real providers. Implementations are
 * keyed by name and selected via SIM_PROVIDER. Keep them side-effect free
 * beyond their own API call: orchestration (state, Slack, flags) happens in
 * api/.
 */
export interface SimProvider {
  readonly name: string;
  simulate(input: SimInput): Promise<SimReport>;
}
