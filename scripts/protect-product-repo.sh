#!/usr/bin/env bash
# Apply main-branch protection to the product repo the agent builds PRs on.
#
#   PRODUCT_REPO=owner/name [REQUIRED_CHECKS="ci,build"] ./scripts/protect-product-repo.sh
#
# Requires: gh CLI authenticated with admin rights on PRODUCT_REPO
#   (gh auth login — the GH_AGENT_PAT itself can't manage protections).
#
# What it does:
#   1. Classic branch protection on the default branch:
#      - changes must land via PR (direct pushes rejected — this is the wall
#        that keeps the agent's contents:write PAT off main)
#      - 0 required approvals so the pipeline's own squash-merge still works
#      - optional required status checks via REQUIRED_CHECKS
#      - no force pushes, no deletions, enforce_admins
#   2. Best-effort repository ruleset restricting pushes to agent-sensitive
#      paths (.github/workflows, CODEOWNERS, agent config, .env) — needs a
#      plan with push rules; skipped with a warning on free plans.
set -euo pipefail

REPO="${PRODUCT_REPO:?set PRODUCT_REPO=owner/name}"
BRANCH="${PRODUCT_BASE_BRANCH:-main}"
IFS=',' read -ra CHECKS <<< "${REQUIRED_CHECKS:-}"

echo "→ Protecting $BRANCH on $REPO"

checks_json="null"
if [ "${#CHECKS[@]}" -gt 0 ] && [ -n "${CHECKS[0]:-}" ]; then
  contexts=$(printf '%s\n' "${CHECKS[@]}" | jq -R . | jq -sc .)
  checks_json=$(jq -nc --argjson c "$contexts" '{strict: true, contexts: $c}')
fi

gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" \
  --input - <<JSON >/dev/null
{
  "required_status_checks": $checks_json,
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
echo "  ✓ $BRANCH: PR-required, no force-push, no deletion, admins included"

# Push-rule path restrictions (Teams/Enterprise plans or public repos).
RULESET_NAME="agent-protected-paths"
existing_id=$(gh api "repos/$REPO/rulesets" --jq \
  ".[] | select(.name == \"$RULESET_NAME\") | .id" 2>/dev/null | head -1 || true)

ruleset_body=$(cat <<'JSON'
{
  "name": "agent-protected-paths",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    {
      "type": "file_path_restriction",
      "parameters": {
        "restricted_file_paths": [
          ".github/workflows/**",
          ".github/CODEOWNERS",
          "CODEOWNERS",
          "**/.env",
          "**/.env.*",
          "**/AGENTS.md",
          "**/CLAUDE.md",
          ".devin/**",
          ".claude/**",
          ".cursor/**"
        ]
      }
    }
  ]
}
JSON
)

if [ -n "$existing_id" ]; then
  if gh api -X PUT "repos/$REPO/rulesets/$existing_id" --input - <<<"$ruleset_body" >/dev/null 2>&1; then
    echo "  ✓ ruleset '$RULESET_NAME' updated (id $existing_id)"
  else
    echo "  ⚠ ruleset update failed — plan may not support push rules; the in-code diff scan still covers these paths"
  fi
elif gh api -X POST "repos/$REPO/rulesets" --input - <<<"$ruleset_body" >/dev/null 2>&1; then
  echo "  ✓ ruleset '$RULESET_NAME' created"
else
  echo "  ⚠ ruleset skipped — plan may not support push rules; the in-code diff scan still covers these paths"
fi

echo "Done. Remaining manual steps: verify GH_AGENT_PAT is fine-grained with"
echo "contents:write + pull_requests:write only (NO workflows permission), and"
echo "enable 'Automatically delete head branches' if desired."
