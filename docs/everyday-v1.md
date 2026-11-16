# The everyday-v1 selection

A 40-task PA selection (everyday life plus work) with multi-trial runs. See [pa.md](pa.md) for the PA benchmark itself.

`everyday-v1` is a set of 40 tasks that mix everyday life and work. They come from the [Claw-Anything](https://huggingface.co/datasets/LiberCoders/Claw-Anything) dataset (Apache-2.0, [paper](https://arxiv.org/abs/2605.26086)). Thanks to its authors. `resources/pa/selections/everyday-v1.json` records the dataset revision and the sha256 of both parquet files.

| Bucket | Worlds | Source | Max per persona |
|---|---|---|---|
| `work` | 16 | benchmark split, tagged `work` | 2 |
| `personal_life` | 8 | benchmark split tagged `personal` or `mixed`, then train split tagged the same | 2 |
| `home_family` | 8 | train split, homemaker persona (the text is Chinese, translated to English) | 8 |
| `self_employed` | 8 | train split, freelance and creator personas (such as a fitness coach or a travel creator) | 2 |

Selection rules:
- No GUI tasks.
- Every service the task uses is supported by the mock services (`src/pa/mock-services/start.ts`).
- English only, except the translated `home_family` bucket.
- Tasks that already exist as older worlds are excluded.
- Within a bucket, tasks are ordered by the sha256 of `everyday-v1:<split>:<bundle>:<taskId>`, so the selection is reproducible. Benchmark tasks come before train tasks.
- Work or personal comes from the tags in `resources/pa/selections/everyday-v1.tags.csv`.

Data corrections applied on import:
- Email addresses, URLs and bare host names have their top-level domain replaced with `.example`.
- Fixture items created after the world's execution date are removed.
- Analysis notes that describe the task's own answer are removed. Each removal and its reason is listed in `resources/pa/selections/everyday-v1.overlay.json`.
- Persona name, role and organization are corrected from each world's own data (the overlay).
- The scenario clock tool `get_current_datetime` is added to every world when the API copies it into the assistant container (`src/pa/scenario-clock.ts`).

The judge prompt includes `reference_solution`, so where a removed note appears in the gold text the overlay rewrites that step with an exact-match `editGrading` entry (three worlds: `bench_t05_t13_consolidate_q1_emergency_shelter_program`, `he_meilan_homemaker_hx_hml_10_t07_detect_hidden_conflict_bet_ddb7b8`, `he_meilan_homemaker_hx_hml_10_t08_resolve_concurrent_activit_ddb7b8`). The review script reports any grading text that still mentions an item missing from the data.

## Running a selection with trials

Queue every world of a selection, three trials each:

```sh
curl -X POST localhost:3000/jobs -H 'content-type: application/json' -H "x-mgmt-key: $MGMT_KEY" \
  -d '{"benchmark": "pa", "selection": "everyday-v1", "assistant": "hermes", "trials": 3, "models": ["model-name"]}'
```

- Give exactly one of `world` or `selection`.
- `trials` is an integer from 1 to 10 (default 1). The API creates one job per world, model and trial, and each run records its trial.
- In reports, a re-run of the same world and trial replaces the earlier run.

Report the selection:

```bash
docker compose run --rm reports --benchmark pa --model <model-name> --assistants openclaw,hermes --selection everyday-v1
```

The report opens with a one-sentence verdict and a ranked table with one row per assistant (pass rate, mean score split into check points and judge points, cost per passed task, median time, safety violations; the best value in each column is bold), then a score-versus-cost chart. With a selection it covers only that selection's worlds and adds a by-bucket table. Closed sections hold the tasks where assistants differ (score gap above 0.2 or a different verdict, with missed checks and the judge's reasoning), the task-by-task matrix, and tool-call counts with unusually high counts flagged. When some worlds have more than one trial, it also shows the mean pass rate across trials with the spread between them, pass@N (at least one trial passed), pass^N (every trial passed, "all trials pass"), flaky tasks (passed in some trials and failed in others), passes out of N for each task, and coverage (worlds with no run for an assistant). Task names come from `task_name` in each `world.yaml`. The behaviour section shows the cache hit share and total cost per run (assistant, simulated user and judge). Cost uses `cost.cacheRead` and `cost.cacheWrite` from the model's entry in `MODELS` when they are set; cached tokens otherwise cost the input price.

## Rebuilding or extending a selection

The tools in `scripts/pa/` are Python and run in a pinned container, so the host needs no Python. Inside the container the dataset is at `/dataset`, so pass `--dataset-dir /dataset`. The repo mount must be writable for scripts that write into `resources/`:

```bash
docker run --rm -v "$PWD":/repo -v "<dataset-dir>":/dataset:ro -w /repo python:3.12-slim sh -c "pip install -q --no-cache-dir pyarrow==21.0.0 PyYAML==6.0.3 && python -I scripts/pa/<script>.py <args>"
```

Get the dataset at the revision recorded in the manifest, for example:

```python
from huggingface_hub import snapshot_download
snapshot_download(repo_id="LiberCoders/Claw-Anything", repo_type="dataset", revision="<revision from the manifest>")
```

The returned folder must contain `data/*.parquet`. The pipeline runs in this order:

1. `select_tasks.py candidates` lists the English tasks that still need a tag.
2. Tag them in `everyday-v1.tags.csv` as `work`, `personal` or `mixed`, with a reason.
3. `select_tasks.py select` fills the buckets and writes the selection manifest.
4. `import_claw_anything.py --manifest ... --overlay ...` writes the worlds.
5. `translate_world.py` extract, translate and apply, for the worlds with Chinese text.
6. `review_worlds.py` reports quality problems. `propose_removals.py` lists analysis notes to remove; approved removals go into the overlay, and the worlds are re-imported with `--force`.

| Script | Purpose | Key arguments |
|---|---|---|
| `select_tasks.py candidates` | writes every eligible English task that still needs a tag | `--dataset-dir`, `--output` |
| `select_tasks.py select` | writes the selection manifest from the tags | `--dataset-dir`, `--dataset-revision`, `--tags`, `--rejections`, `--worlds-dir`, `--output` |
| `import_claw_anything.py` | writes PA worlds for a manifest or named tasks | `--dataset-dir`, `--manifest` or `--task SPLIT:BUNDLE:TASK_ID` (repeatable), `--overlay`, `--output`, `--force` |
| `translate_world.py extract` | writes chunk files of Chinese text for translation | `--chunk-chars`, `--out-dir`, world directories |
| `translate_world.py apply` | checks the translations and writes them into the worlds | `--translations-dir`, world directories |
| `review_worlds.py` | reports quality problems in a selection's worlds; never modifies them | `--manifest`, `--worlds-dir`, `--output` |
| `propose_removals.py` | proposes analysis notes that leak the answer; never modifies worlds | `--manifest`, `--worlds-dir`, `--days-before`, `--output` (required) |

For translation, `extract` writes `chunk_NNN.json` files and a `manifest.json` into `--out-dir`. A translator (an LLM or a person) writes `chunk_NNN.en.json` beside each chunk, with an English translation of every string. `apply` checks them against the originals and replaces the text in the worlds.

