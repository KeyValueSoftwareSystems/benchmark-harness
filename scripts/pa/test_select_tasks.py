"""Tests for select_tasks.py. Run with a Python that has pyarrow and pyyaml installed."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest import mock

import pyarrow as pa
import pyarrow.parquet as pq
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import select_tasks as selector  # noqa: E402
from import_claw_anything import (  # noqa: E402
    COLUMN_BUNDLE,
    COLUMN_FIXTURES,
    COLUMN_LOGS,
    COLUMN_SPLIT,
    COLUMN_TASK_ID,
    COLUMN_TASK_YAML,
    ImportFailure,
    TaskKey,
)

PARQUET_FILE = "train-00000-of-00001.parquet"
REVISION = "3daa7e8139aa18c09f40321dc79c12e8d21c626e"
ROUTE_FACTORIES_TEXT = """\
const ROUTE_FACTORIES: Record<string, (load: FixtureLoader) => express.Router> =
\t{
\t\tgmail: gmailRoutes,
\t\tcalendar: calendarRoutes,
\t\ttodo: todoRoutes,
\t\tnotes: notesRoutes,
\t\tfinance: financeRoutes,
\t};
"""
HOMEMAKER_BUNDLE = "he_meilan_homemaker_r25_n20_x"
HOMEMAKER_TASK_ID = "t05_menu"
WORLD_TASK_ID = "T08_EXISTING"

BENCHMARK = "benchmark"
TRAIN = "train"

WORK_KEYS = (
    TaskKey(BENCHMARK, "skill", "T01_inbox_triage"),
    TaskKey(BENCHMARK, "skill", "T02_calendar_fix"),
    TaskKey(BENCHMARK, "tool", "T03_notes_summary"),
    TaskKey(BENCHMARK, "tool", "T03_todo_list"),
    TaskKey(BENCHMARK, "skill", "T04_finance_report"),
)
PERSONAL_BENCHMARK_KEY = TaskKey(BENCHMARK, "skill", "T09_pay_rent")
LIN_BUNDLE = "lin_jiahui_r25_n20_20260422_x"
PERSONAL_TRAIN_KEY = TaskKey(TRAIN, LIN_BUNDLE, "t01_pay_rent")
MIXED_TRAIN_KEY = TaskKey(TRAIN, LIN_BUNDLE, "t02_party")
HOMEMAKER_KEY = TaskKey(TRAIN, HOMEMAKER_BUNDLE, HOMEMAKER_TASK_ID)
HOMEMAKER_CJK_KEY = TaskKey(TRAIN, HOMEMAKER_BUNDLE, "t06_cn")
SELF_EMPLOYED_KEY = TaskKey(TRAIN, "devon_ross_fitness_coach_r25_n20_x", "t04_client")

SMALL_BUCKET_SIZES = {
    selector.Bucket.WORK: (2, 1),
    selector.Bucket.PERSONAL_LIFE: (1, 2),
    selector.Bucket.HOME_FAMILY: (2, 8),
    selector.Bucket.SELF_EMPLOYED: (1, 2),
}


def make_row(
    split: str,
    bundle: str,
    task_id: str,
    prompt: str,
    services: Sequence[str] = ("gmail",),
    apps: bool = False,
    fixture_text: str = "",
) -> dict[str, str]:
    document: dict[str, Any] = {
        "prompt": {"text": prompt},
        "services": [{"name": name, "port": 9000} for name in services],
    }
    if apps:
        document["apps"] = [{"name": "app"}]
    return {
        COLUMN_SPLIT: split,
        COLUMN_BUNDLE: bundle,
        COLUMN_TASK_ID: task_id,
        COLUMN_TASK_YAML: yaml.safe_dump(document, allow_unicode=True),
        COLUMN_FIXTURES: json.dumps({"notes.json": {"encoding": "utf8", "content": fixture_text}}),
        COLUMN_LOGS: "{}",
    }


def standard_rows() -> list[dict[str, str]]:
    return [
        make_row(BENCHMARK, "skill", "T01_inbox_triage", "Triage my inbox", ("gmail",)),
        make_row(BENCHMARK, "skill", "T02_calendar_fix", "Fix my calendar", ("calendar",)),
        make_row(BENCHMARK, "tool", "T03_notes_summary", "Summarize my notes", ("notes",)),
        make_row(BENCHMARK, "tool", "T03_todo_list", "Clean up my todo list", ("todo",)),
        make_row(BENCHMARK, "skill", "T04_finance_report", "Build a finance report", ("finance",)),
        make_row(BENCHMARK, "gui", "T05_gui_task", "Click through the app", ("gmail",)),
        make_row(BENCHMARK, "skill", "T06_cjk_task", "请帮我回复邮件", ("gmail",)),
        make_row(BENCHMARK, "skill", "T07_unsupported", "Use an unknown service", ("nope",)),
        make_row(BENCHMARK, "skill", WORLD_TASK_ID, "Already a world", ("gmail",)),
        make_row(BENCHMARK, "skill", "T09_pay_rent", "Pay my rent on time", ("gmail",)),
        make_row(BENCHMARK, "skill", "T10_apps", "Use the apps", ("gmail",), apps=True),
        make_row(TRAIN, LIN_BUNDLE, "t01_pay_rent", "Pay my rent and reply to my landlord"),
        make_row(TRAIN, LIN_BUNDLE, "t02_party", "Plan a birthday party for my son"),
        make_row(TRAIN, LIN_BUNDLE, "t03_report", "Summarize the quarterly report"),
        make_row(TRAIN, "devon_ross_fitness_coach_r25_n20_x", "t04_client", "Send my client a birthday note"),
        make_row(TRAIN, HOMEMAKER_BUNDLE, HOMEMAKER_TASK_ID, "Plan the weekly menu"),
        make_row(TRAIN, HOMEMAKER_BUNDLE, "t06_cn", "请规划家庭晚餐"),
        make_row(TRAIN, "sam_torres_cafe_owner_11_x", "t07_supplier", "Check the supplier", fixture_text="中文"),
    ]


def standard_tags() -> dict[TaskKey, selector.Tag]:
    tags = {key: selector.Tag.WORK for key in WORK_KEYS}
    tags[PERSONAL_BENCHMARK_KEY] = selector.Tag.PERSONAL
    tags[PERSONAL_TRAIN_KEY] = selector.Tag.PERSONAL
    tags[MIXED_TRAIN_KEY] = selector.Tag.MIXED
    return tags


def standard_context() -> selector.EligibilityContext:
    return selector.EligibilityContext(
        supported_services=frozenset({"gmail", "calendar", "todo", "notes", "finance"}),
        world_task_ids=frozenset({WORLD_TASK_ID.lower()}),
    )


def facts(split: str, bundle: str, task_id: str, persona: str, prompt: str = "x") -> selector.TaskFacts:
    return selector.TaskFacts(
        key=TaskKey(split, bundle, task_id),
        persona=persona,
        prompt=prompt,
        service_names=("gmail",),
        has_apps=False,
        has_cjk=False,
    )


class SelectTasksTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.dataset_dir = self.root / "dataset"
        self.worlds_dir = self.root / "worlds"
        self.route_source = self.root / "start.ts"
        self.route_source.write_text(ROUTE_FACTORIES_TEXT, encoding="utf-8")
        self.add_world(WORLD_TASK_ID.lower())

    def add_world(self, task_id: str) -> None:
        world_dir = self.worlds_dir / task_id
        world_dir.mkdir(parents=True, exist_ok=True)
        (world_dir / "world.yaml").write_text(f"task_id: {task_id}\n", encoding="utf-8")

    def write_dataset(self, rows: Sequence[dict[str, str]]) -> None:
        data_dir = self.dataset_dir / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.Table.from_pylist(list(rows)), data_dir / PARQUET_FILE)

    def write_tags(self, tags: dict[TaskKey, selector.Tag]) -> Path:
        path = self.root / "tags.csv"
        lines = ["split,bundle,task_id,tag,reason"]
        lines += [f"{key.split},{key.bundle},{key.task_id},{tag.value}," for key, tag in tags.items()]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def build(
        self,
        tags: dict[TaskKey, selector.Tag] | None = None,
        rejections: Sequence[selector.Rejection] = (),
    ) -> dict[str, Any]:
        self.write_dataset(standard_rows())
        with mock.patch.object(selector, "BUCKET_SPECS", self.small_specs()):
            return selector.build_manifest(
                selector.scan_dataset(self.dataset_dir),
                standard_context(),
                standard_tags() if tags is None else tags,
                list(rejections),
                REVISION,
                {PARQUET_FILE: "abc"},
            )

    def picked_keys(self, manifest: dict[str, Any], bucket: selector.Bucket) -> list[TaskKey]:
        return [
            TaskKey(task["split"], task["bundle"], task["taskId"])
            for task in manifest["tasks"]
            if task["bucket"] == bucket.value
        ]

    def run_select_cli(self, output: Path, rejections: Path | None = None) -> bytes:
        argv = [
            "select",
            "--dataset-dir", str(self.dataset_dir),
            "--dataset-revision", REVISION,
            "--tags", str(self.write_tags(standard_tags())),
            "--worlds-dir", str(self.worlds_dir),
            "--output", str(output),
        ]
        if rejections is not None:
            argv += ["--rejections", str(rejections)]
        with mock.patch.object(selector, "BUCKET_SPECS", self.small_specs()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(selector.main(argv, route_factories_source=self.route_source), 0)
        return output.read_bytes()

    def small_specs(self) -> tuple[selector.BucketSpec, ...]:
        return tuple(
            replace(spec, count=SMALL_BUCKET_SIZES[spec.name][0], max_per_persona=SMALL_BUCKET_SIZES[spec.name][1])
            for spec in selector.BUCKET_SPECS
        )

    # Persona derivation

    def test_persona_for_benchmark_uses_first_task_id_token(self) -> None:
        persona = selector.derive_persona(TaskKey(BENCHMARK, "skill", "t13_calendar"))
        self.assertEqual(persona, "T13")

    def test_persona_for_train_uses_bundle_prefix_before_marker(self) -> None:
        cases = {
            "devon_ross_fitness_coach_r25_n20_20260422_5task_medium": "devon_ross_fitness_coach",
            "sam_torres_cafe_owner_11_x": "sam_torres_cafe_owner",
            "mia_lee_persona_2_x": "mia_lee",
            "zhou_xinyi_creator_7_x": "zhou_xinyi_creator",
        }
        for bundle, expected in cases.items():
            with self.subTest(bundle=bundle):
                self.assertEqual(selector.derive_persona(TaskKey(TRAIN, bundle, "t1")), expected)

    def test_persona_for_train_without_marker_fails(self) -> None:
        with self.assertRaises(ImportFailure):
            selector.derive_persona(TaskKey(TRAIN, "no_marker_here", "t1"))

    # Eligibility

    def test_eligibility_counts_each_exclusion_rule(self) -> None:
        self.write_dataset(standard_rows())
        report = selector.check_eligibility(selector.scan_dataset(self.dataset_dir), standard_context())
        eligible = {item.key for item in report.eligible}
        self.assertEqual(report.excluded[selector.ExclusionRule.NO_GUI], 2)
        self.assertEqual(report.excluded[selector.ExclusionRule.UNSUPPORTED_SERVICE], 1)
        self.assertEqual(report.excluded[selector.ExclusionRule.ALREADY_A_WORLD], 1)
        self.assertEqual(report.excluded[selector.ExclusionRule.NON_ENGLISH], 2)
        self.assertEqual(len(eligible), 12)
        self.assertIn(HOMEMAKER_CJK_KEY, eligible)
        self.assertNotIn(TaskKey(BENCHMARK, "skill", "T06_cjk_task"), eligible)

    def test_candidates_are_english_benchmark_and_hinted_personal_train_tasks(self) -> None:
        self.write_dataset(standard_rows())
        report = selector.check_eligibility(selector.scan_dataset(self.dataset_dir), standard_context())
        candidates = {item.key for item in report.eligible if selector.is_candidate(item)}
        expected = {*WORK_KEYS, PERSONAL_BENCHMARK_KEY, PERSONAL_TRAIN_KEY, MIXED_TRAIN_KEY}
        self.assertEqual(candidates, expected)

    def test_candidates_subcommand_writes_candidate_entries(self) -> None:
        self.write_dataset(standard_rows())
        output = self.root / "candidates.json"
        with mock.patch.object(selector, "DEFAULT_WORLDS_DIR", self.worlds_dir), contextlib.redirect_stdout(io.StringIO()):
            selector.main(
                ["candidates", "--dataset-dir", str(self.dataset_dir), "--output", str(output)],
                route_factories_source=self.route_source,
            )
        entries = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(len(entries), 8)
        self.assertEqual(set(entries[0]), {"split", "bundle", "taskId", "persona", "prompt"})

    def test_supported_services_come_from_route_factories(self) -> None:
        self.assertEqual(
            selector.load_supported_services(self.route_source),
            frozenset({"gmail", "calendar", "todo", "notes", "finance"}),
        )

    def test_real_start_ts_lists_services(self) -> None:
        services = selector.load_supported_services(selector.ROUTE_FACTORIES_SOURCE)
        self.assertTrue(services)
        self.assertTrue({"gmail", "calendar"} <= services)

    def test_missing_route_factories_fails_loudly(self) -> None:
        empty_source = self.root / "empty.ts"
        empty_source.write_text("export const other = {};\n", encoding="utf-8")
        with self.assertRaises(ImportFailure):
            selector.load_supported_services(empty_source)

    def test_world_task_ids_are_lowercased(self) -> None:
        self.assertEqual(selector.load_world_task_ids(self.worlds_dir), frozenset({WORLD_TASK_ID.lower()}))

    # Tags and rejections

    def test_untagged_benchmark_task_fails_and_lists_keys(self) -> None:
        tags = standard_tags()
        del tags[WORK_KEYS[0]]
        with self.assertRaisesRegex(ImportFailure, "1 eligible benchmark tasks have no tag"):
            self.build(tags=tags)

    def test_tag_on_non_candidate_fails(self) -> None:
        tags = standard_tags()
        tags[TaskKey(BENCHMARK, "gui", "T05_gui_task")] = selector.Tag.WORK
        with self.assertRaisesRegex(ImportFailure, "not candidates"):
            self.build(tags=tags)

    def test_unknown_tag_value_fails(self) -> None:
        path = self.root / "bad_tags.csv"
        path.write_text("split,bundle,task_id,tag,reason\nbenchmark,skill,T01_inbox_triage,fun,\n", encoding="utf-8")
        with self.assertRaises(ImportFailure):
            selector.load_tags(path)

    def test_pool_too_small_fails(self) -> None:
        self.write_dataset(standard_rows())
        specs = tuple(
            replace(spec, count=5, max_per_persona=1) if spec.name is selector.Bucket.WORK else spec
            for spec in selector.BUCKET_SPECS
        )
        with mock.patch.object(selector, "BUCKET_SPECS", specs), self.assertRaisesRegex(ImportFailure, "needs 5"):
            selector.build_manifest(
                selector.scan_dataset(self.dataset_dir), standard_context(), standard_tags(), [], REVISION, {}
            )

    def test_rejected_task_is_replaced_by_next_in_seeded_order(self) -> None:
        baseline = self.build()
        first, second = self.picked_keys(baseline, selector.Bucket.WORK)
        manifest = self.build(rejections=[selector.Rejection(first, "off topic")])

        work = self.picked_keys(manifest, selector.Bucket.WORK)
        self.assertEqual(len(work), 2)
        self.assertIn(second, work)
        self.assertNotIn(first, work)
        self.assertEqual(
            manifest["rejected"],
            [{"split": first.split, "bundle": first.bundle, "taskId": first.task_id, "reason": "off topic"}],
        )

    def test_rejection_of_unknown_task_fails(self) -> None:
        self.write_dataset(standard_rows())
        unknown = selector.Rejection(TaskKey(BENCHMARK, "skill", "T99_missing"), "gone")
        with self.assertRaisesRegex(ImportFailure, "not in the dataset"):
            self.build(rejections=[unknown])

    # Picking

    def test_per_persona_cap_limits_picks_from_one_persona(self) -> None:
        pool = [
            facts(BENCHMARK, "skill", "t01_a", "T01"),
            facts(BENCHMARK, "skill", "t01_b", "T01"),
            facts(BENCHMARK, "skill", "t01_c", "T01"),
            facts(BENCHMARK, "skill", "t02_a", "T02"),
        ]
        tags = {item.key: selector.Tag.WORK for item in pool}
        spec = selector.BucketSpec(selector.Bucket.WORK, 3, 2, "test", selector._is_work_task)
        picks = selector.pick_for_bucket(spec, pool, tags, set())
        personas = [item.persona for item in picks]
        self.assertEqual(sorted(personas), ["T01", "T01", "T02"])

    def test_pool_order_puts_benchmark_before_train(self) -> None:
        train = facts(TRAIN, LIN_BUNDLE, "t01", "lin_jiahui")
        benchmark = facts(BENCHMARK, "skill", "T09_pay_rent", "T09")
        self.assertEqual(sorted([train, benchmark], key=selector.pool_order), [benchmark, train])

    def test_seeded_rank_is_sha256_of_seed_and_key(self) -> None:
        key = TaskKey(BENCHMARK, "skill", "T01_inbox_triage")
        expected = hashlib.sha256(b"everyday-v1:benchmark:skill:T01_inbox_triage").hexdigest()
        self.assertEqual(selector.seeded_rank(key), expected)

    def test_personal_bucket_takes_benchmark_task_first(self) -> None:
        manifest = self.build()
        personal = self.picked_keys(manifest, selector.Bucket.PERSONAL_LIFE)
        self.assertEqual(personal, [PERSONAL_BENCHMARK_KEY])

    def test_home_family_is_translated_and_self_employed_is_not(self) -> None:
        manifest = self.build()
        flags = {(task["bucket"], task["translated"]) for task in manifest["tasks"]}
        self.assertIn((selector.Bucket.HOME_FAMILY.value, True), flags)
        self.assertIn((selector.Bucket.SELF_EMPLOYED.value, False), flags)
        self.assertIn(SELF_EMPLOYED_KEY, self.picked_keys(manifest, selector.Bucket.SELF_EMPLOYED))

    def test_manifest_records_world_exclusion_count_and_world_ids(self) -> None:
        manifest = self.build()
        self.assertEqual(manifest["rules"]["excludedBecauseAlreadyAWorld"], 1)
        world_ids = {task["worldId"] for task in manifest["tasks"]}
        self.assertIn("bench_t01_inbox_triage", world_ids)
        homemaker_digest = hashlib.sha1(HOMEMAKER_BUNDLE.encode("utf-8")).hexdigest()[:6]
        self.assertIn(f"he_meilan_homemaker_t05_menu_{homemaker_digest}", world_ids)

    def test_duplicate_world_ids_fail(self) -> None:
        picked = [
            selector.PickedTask(selector.Bucket.WORK, facts(BENCHMARK, "a", "T1", "T1"), "bench_t1", False),
            selector.PickedTask(selector.Bucket.WORK, facts(BENCHMARK, "b", "T1", "T1"), "bench_t1", False),
        ]
        with self.assertRaisesRegex(ImportFailure, "not unique"):
            selector.check_world_ids(picked)

    def test_slugify_limits_length_and_strips_separators(self) -> None:
        self.assertEqual(selector.slugify("  T13 -- Calendar!! ", 70), "t13_calendar")
        self.assertEqual(selector.slugify("abcdef", 4), "abcd")

    # Whole CLI run

    def test_select_cli_is_byte_identical_across_runs(self) -> None:
        self.write_dataset(standard_rows())
        first = self.run_select_cli(self.root / "first.json")
        second = self.run_select_cli(self.root / "second.json")
        self.assertEqual(first, second)
        self.assertTrue(first.endswith(b"\n"))

    def test_select_cli_manifest_has_expected_top_level_keys(self) -> None:
        self.write_dataset(standard_rows())
        manifest = json.loads(self.run_select_cli(self.root / "manifest.json"))
        self.assertEqual(list(manifest), ["name", "dataset", "seed", "rules", "tasks", "rejected"])
        self.assertEqual(manifest["dataset"]["revision"], REVISION)
        self.assertEqual(manifest["dataset"]["files"], {PARQUET_FILE: hashlib.sha256(
            (self.dataset_dir / "data" / PARQUET_FILE).read_bytes()
        ).hexdigest()})

    def test_select_cli_applies_rejections_file(self) -> None:
        self.write_dataset(standard_rows())
        rejections = self.root / "rejections.json"
        rejections.write_text(
            json.dumps([{"split": BENCHMARK, "bundle": "skill", "taskId": "T09_pay_rent", "reason": "not everyday"}]),
            encoding="utf-8",
        )
        manifest = json.loads(self.run_select_cli(self.root / "with_rejections.json", rejections))
        self.assertEqual(manifest["rejected"][0]["reason"], "not everyday")
        self.assertNotIn("T09_pay_rent", [task["taskId"] for task in manifest["tasks"]])


if __name__ == "__main__":
    unittest.main()
