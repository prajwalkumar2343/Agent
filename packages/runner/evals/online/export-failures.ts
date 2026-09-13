import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTrace } from '../../src/trace.ts';
import type { EvalTask } from '../src/types.ts';

/**
 * Failure→dataset pipeline — the loop that makes the eval suite grow with
 * production reality. Selects failed/flagged production traces and drafts
 * candidate eval tasks (reference left for a human to author — a candidate
 * is NOT a task until a human writes its reference trajectory and graders
 * are reviewed).
 *
 *   export-failures.ts --traces <dir> [--scores <file>]
 *
 * Emits evals/online/candidates.jsonl (deduped by failure signature).
 * Secrets hygiene: exports spec text + tool NAMES + error classes only —
 * never tool inputs/outputs (traces store input hashes; raw args stay put).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ONLINE = HERE;

interface Candidate {
  id: string;
  draft: true;
  suite: 'regression' | 'capability';
  task_type: 'adversarial' | 'recovery' | 'tool_required';
  rationale: string;
  input: { spec: { title: string; slug: string; summary: string; acceptance: string[] }; flag_key: string };
  environment: { fixture: string; github_mock?: string };
  reference: { expected_outcome: string };
  graders: { type: 'deterministic'; check: string }[];
  _provenance: { session_id: string; failure_signature: string; exported_at: string };
}

function failureSignature(t: AgentTrace): { sig: string; kind: string; rationale: string } {
  const errCalls = (t.toolCalls ?? []).filter((c) => c.isError);
  const errTools = [...new Set(errCalls.map((c) => c.toolName))];
  if (t.truncated) {
    return {
      sig: `truncated:${errTools.join('+') || 'none'}`,
      kind: 'recovery',
      rationale: `Production run hit the step cap${errTools.length ? ` after ${errTools.join(',')} errors` : ''} — replay guard against burn-down loops.`,
    };
  }
  if (errCalls.length) {
    return {
      sig: `tool_errors:${errTools.sort().join('+')}`,
      kind: 'recovery',
      rationale: `Production run saw ${errTools.join(',')} tool error(s) and ${t.text ? 'finished' : 'did not finish'} — pin the recovery shape.`,
    };
  }
  if (t.finish_reason && t.finish_reason !== 'stop') {
    return {
      sig: `finish:${t.finish_reason}`,
      kind: 'adversarial',
      rationale: `Run ended with finish_reason=${t.finish_reason} — unusual termination worth a case.`,
    };
  }
  return {
    sig: 'failed:no_pr',
    kind: 'tool_required',
    rationale: 'Run completed without producing a PR — handoff chain broke somewhere.',
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

function draftTask(t: AgentTrace, sig: { sig: string; kind: string; rationale: string }): Candidate {
  // The spec text is not recoverable from the trace (it lives in the prompt,
  // not the spans) — the reviewer fills it from the run's Slack context.
  const title = `prod failure: ${sig.sig}`;
  return {
    id: `cand-${slugify(sig.sig)}-${(t.meta.session_id ?? 'x').slice(-6)}`,
    draft: true,
    suite: sig.kind === 'adversarial' ? 'capability' : 'regression',
    task_type: sig.kind as Candidate['task_type'],
    rationale: sig.rationale + ` Seen in prod session ${t.meta.session_id}.`,
    input: {
      spec: {
        title,
        slug: slugify(sig.sig),
        summary: 'TODO(reviewer): reconstruct the spec from the run context.',
        acceptance: ['TODO(reviewer)'],
      },
      flag_key: 'feat_TODO',
    },
    environment: { fixture: 'flag-app' },
    reference: { expected_outcome: 'TODO(reviewer): script the known-good trajectory via gen-dataset patterns.' },
    graders: [
      { type: 'deterministic', check: `no_forbidden_action()` },
      { type: 'deterministic', check: `NOT loop_detected()` },
      ...(t.truncated ? [{ type: 'deterministic' as const, check: `NOT truncated()` }] : []),
    ],
    _provenance: { session_id: t.meta.session_id ?? '', failure_signature: sig.sig, exported_at: new Date().toISOString() },
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1]! : undefined;
  };
  const tracesDir = path.resolve(get('traces') ?? process.env.TRACE_DIR ?? path.join(ONLINE, 'traces'));
  if (!existsSync(tracesDir)) {
    console.log(`no trace dir at ${tracesDir}`);
    return;
  }
  const outFile = path.join(ONLINE, 'candidates.jsonl');
  const seen = new Set(
    existsSync(outFile)
      ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Candidate)._provenance.failure_signature)
      : [],
  );

  let exported = 0;
  for (const f of readdirSync(tracesDir).filter((f) => f.endsWith('.json'))) {
    let t: AgentTrace;
    try {
      t = JSON.parse(readFileSync(path.join(tracesDir, f), 'utf8')) as AgentTrace;
    } catch {
      continue;
    }
    const interesting =
      t.truncated ||
      (t.toolCalls ?? []).some((c) => c.isError) ||
      (t.finish_reason && t.finish_reason !== 'stop');
    if (!interesting) continue;
    const sig = failureSignature(t);
    if (seen.has(sig.sig)) continue;
    appendFileSync(outFile, JSON.stringify(draftTask(t, sig)) + '\n');
    seen.add(sig.sig);
    exported++;
  }
  mkdirSync(ONLINE, { recursive: true });
  writeFileSync(path.join(ONLINE, 'last-export.json'), JSON.stringify({ at: new Date().toISOString(), exported }, null, 2));
  console.log(`exported ${exported} new candidate task(s) → ${outFile}`);
  if (exported) console.log('Next: a human authors reference.script + graders, then move into dataset.jsonl.');
}

main();
