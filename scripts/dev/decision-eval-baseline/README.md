# decision-eval baseline (PR-1 lock)

`baseline.json` is the bit-identical decision-eval snapshot captured **before**
any commitment-kernel work landed. It contains only the deterministic parts of
the eval payload:

- `summary` — total / passed / failed / errorTagCounts
- `results` — per-case decision (sorted by case order in `cases.jsonl`)

Non-deterministic fields are intentionally excluded:

- `generatedAt` — `new Date().toISOString()` differs per run
- `casesPath`   — absolute path differs per machine / CI runner

The bit-identical test (`test/scripts/decision-eval-bit-identical.test.ts`)
runs `pnpm eval:decision` as a subprocess, slices the same two fields out of
the live payload, and compares with deep equality. Any drift is a `production
routing change`, which is **out of scope for any PR that does not explicitly
opt into refreshing this baseline**.

## When the baseline must change

Refreshing the baseline is allowed **only** when:

1. The PR is explicitly labelled as touching legacy decision routing.
2. The reason fits one of the frozen-layer categories declared in the PR body
   (telemetry-only / bug-fix / compatibility / emergency-rollback — see
   `.github/PULL_REQUEST_TEMPLATE.md`).
3. The refresh lands as a **separate commit** with a commit message that:
   - Names the trigger PR / issue.
   - States the category.
   - Describes the intentional diff in routing semantics.

## How to refresh

```sh
pnpm eval:decision -- --output scripts/dev/decision-eval-baseline/_raw.json --json
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('scripts/dev/decision-eval-baseline/_raw.json','utf8')); fs.writeFileSync('scripts/dev/decision-eval-baseline/baseline.json', JSON.stringify({summary:j.summary,results:j.results},null,2)+'\n','utf8'); fs.unlinkSync('scripts/dev/decision-eval-baseline/_raw.json');"
```

The bit-identical test must pass after every refresh on a clean checkout.

## Why we do not patch the runner

Removing the non-deterministic fields by editing `scripts/dev/decision-eval.ts`
(adding `--deterministic`, mocking `Date`, etc.) is **out of scope for PR-1**.
The runner stays untouched; determinism is enforced by selecting which fields
participate in equality, not by changing the runner.
