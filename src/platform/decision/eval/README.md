# TaskClassifier eval harness

Objective, repeatable evaluation of `TaskClassifier` against the `TaskContract`
schema. Use it to compare LLM models (e.g. `hydra/gpt-5-mini` vs a self-hosted
candidate) on a fixed dataset, with structured per-field metrics and per-tag
breakdowns.

> **Hard rule:** the eval harness never parses prompt text. It only invokes
> `TaskClassifierAdapter.classify(...)` and compares structured fields. Any
> heuristic over user prompts must live in the classifier itself.
> See `lint:routing:no-prompt-parsing`.

## Layout

| File | Purpose |
| --- | --- |
| `golden-set.json` | Pre-authored cases — prompts + expected partial `TaskContract`. |
| `golden-set.ts` | Loader + zod-validated typing for the dataset. |
| `types.ts` | Shared types: `GoldenCase`, `CaseResult`, `EvalSnapshot`. |
| `scoring.ts` | Pure scoring (Jaccard, exact match, aggregates, per-tag rollups). |
| `runner.ts` | `runEvaluation({ adapter, cases, config, cfg })` — pure runner. |
| `render.ts` | Markdown report renderer. |
| `compare.ts` | Snapshot-vs-snapshot diff + zod schema for snapshots. |

CLI entry points live in `scripts/eval-classifier.ts` and
`scripts/eval-classifier-compare.ts`.

## Run an eval

```pwsh
pnpm eval:classifier --backend pi-simple --model hydra/gpt-5-mini
```

A markdown report is printed to stdout. A JSON snapshot is written to
`eval-results/<timestamp>__<backend>__<model>.json`.

Useful flags:

```pwsh
pnpm eval:classifier --limit 10                   # smoke run on first 10 cases
pnpm eval:classifier --filter-tag russian         # only Russian cases
pnpm eval:classifier --label baseline             # appended to snapshot filename
pnpm eval:classifier --dry-run                    # validate dataset + adapter
pnpm eval:classifier --model my-self-hosted/llama # try a different model
```

The `--backend` argument is matched against the registry built into
`task-classifier.ts`. Out of the box only `pi-simple` is available; new
backends register through `resolveTaskClassifierAdapter`'s `registry`
parameter — extend the CLI when wiring a self-hosted runner.

## Read the report

| Metric | Meaning |
| --- | --- |
| `accuracy.primaryOutcome` | Cases where the classifier picked the correct outcome / cases that specified one. |
| `accuracy.interactionMode` | Same idea for interaction mode. |
| `accuracy.deliverableKind` | Same for `deliverable.kind`. |
| `accuracy.deliverablePreferredFormat` | Same for `deliverable.preferredFormat` — only counted when a case specifies it. |
| `accuracy.requiredCapabilitiesExact` | Cases where the capability set matches exactly / cases that specified one. |
| `jaccard.requiredCapabilities.mean` | Mean Jaccard similarity over all graded cases — partial credit. |
| `latencyMs.{mean,p50,p95}` | Per-case classifier latency in ms (network + parse). |

The "Per-tag breakdown" table reuses the same metrics but bucketed by every tag
the cases declare (`russian`, `cron`, `provider:bybit`, `low-confidence`, …).

## Compare two runs

```pwsh
pnpm eval:classifier:compare `
  --baseline eval-results/2026-04-23__pi-simple__hydra_gpt-5-mini.json `
  --candidate eval-results/2026-04-23__local__my-llama.json
```

The compare CLI prints a delta table per metric and lists per-case regressions
and improvements. If the dataset hashes differ the report opens with a warning
because the runs are no longer apples-to-apples.

## Adding cases

Edit `golden-set.json`. Each entry has:

```json
{
  "id": "unique-id",
  "prompt": "...",
  "fileNames": ["optional.pdf"],
  "tags": ["russian", "document_package", "pdf"],
  "expectedTaskContract": {
    "primaryOutcome": "document_package",
    "interactionMode": "artifact_iteration",
    "requiredCapabilities": ["needs_multimodal_authoring"],
    "deliverable": { "kind": "document", "preferredFormat": "pdf" }
  }
}
```

Rules:

- IDs must be unique. The loader asserts this on every run.
- `expectedTaskContract` is partial — fields you omit are simply not graded for
  that case. Use this to keep cases focused on what they actually test.
- Tags drive the per-tag breakdown; pick a small, consistent vocabulary.
- Whatever you put in `expectedTaskContract` must reflect the **normalised**
  output of `task-classifier.ts` (e.g. `interactionMode: "tool_execution"` for
  any case with `needs_workspace_mutation`), not the raw LLM emission.

## Updating the baseline

When you intentionally change classifier behaviour:

1. Run `pnpm eval:classifier --label baseline-before` against the old code.
2. Apply your change.
3. Run `pnpm eval:classifier --label baseline-after`.
4. Run `pnpm eval:classifier:compare --baseline ... --candidate ...`.
5. Update `golden-set.json` only if the regressions are intentional and the
   new behaviour is desired. Commit the dataset change in the same PR.
