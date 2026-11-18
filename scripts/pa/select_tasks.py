#!/usr/bin/env python3
"""Select the Claw-Anything tasks for the public `everyday-v1` personal assistant comparison.

Subcommands:
    candidates  Write every eligible English task that still needs a work/personal/mixed tag.
    select      Fill each bucket from the tags file and write the selection manifest that
                scripts/pa/import_claw_anything.py reads through --manifest.

Usage:
    python scripts/pa/select_tasks.py candidates --dataset-dir DIR --output FILE
    python scripts/pa/select_tasks.py select --dataset-dir DIR --dataset-revision SHA --tags FILE
        [--rejections FILE] [--worlds-dir DIR] [--output FILE]

Requires pyarrow and pyyaml.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_claw_anything import (  # noqa: E402
    COLUMN_BUNDLE,
    COLUMN_FIXTURES,
    COLUMN_LOGS,
    COLUMN_SPLIT,
    COLUMN_TASK_ID,
    COLUMN_TASK_YAML,
    CONTENT_COLUMNS,
    DATASET_DATA_DIR,
    DEFAULT_WORLDS_DIR,
    KEY_COLUMNS,
    PARQUET_GLOB,
    REPO_ROOT,
    SCAN_BATCH_ROWS,
    WORLD_ID_PATTERN,
    WORLD_YAML,
    ImportFailure,
    TaskKey,
)


DATASET_ID = "LiberCoders/Claw-Anything"
SELECTION_NAME = "everyday-v1"
SELECTION_SEED = "everyday-v1"
DEFAULT_OUTPUT = REPO_ROOT / "resources" / "pa" / "selections" / f"{SELECTION_NAME}.json"
ROUTE_FACTORIES_SOURCE = REPO_ROOT / "src" / "pa" / "mock-services" / "start.ts"
ROUTE_FACTORIES_BLOCK_PATTERN = re.compile(r"\bROUTE_FACTORIES\b[^{]*\{(?P<entries>[^}]*)\}")
ROUTE_ENTRY_NAME_PATTERN = re.compile(r"^\s*([A-Za-z_]\w*)\s*:", re.MULTILINE)
ENTRIES_GROUP = "entries"
WORLD_TASK_ID_KEY = "task_id"
YAML_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
HASH_CHUNK_BYTES = 1024 * 1024

BENCHMARK_SPLIT = "benchmark"
TRAIN_SPLIT = "train"
GUI_BUNDLE = "gui"
PERSONA_PATTERN = re.compile(r"^(.*?)(_r25_|_11_|_persona_|_\d)")
PERSONA_GROUP = 1
CJK_CHARACTER_PATTERN = re.compile(r"[一-鿿]")
CJK_CODE_POINTS = range(0x4E00, 0x9FFF + 1)
UNICODE_ESCAPE_PATTERN = re.compile(r"\\u([0-9a-fA-F]{4})")
HOMEMAKER_PERSONA = "he_meilan_homemaker"
SELF_EMPLOYED_PERSONAS = (
    "devon_ross_fitness_coach",
    "nina_caldwell_travel_creator",
    "rachel_summers_wedding_planner",
    "kenji_tanaka_indie_musician",
    "sam_torres_cafe_owner",
    "mia_lee_freelance_illustrator",
    "zhou_xinyi_creator",
    "oscar_navarro_freelance_translator",
)
PERSONAL_LIFE_HINT = re.compile(
    r"\b(my (kids?|son|daughter|wife|husband|partner|mom|mother|dad|father|parents|family|sister|brother"
    r"|landlord|apartment|lease|dentist|doctor|therapist)"
    r"|birthday|anniversary|vacation|family trip|household|babysitter|daycare|vet|subscription|refund"
    r"|grocer(y|ies)|health insurance|gym membership|rent)\b",
    re.IGNORECASE,
)

CSV_TAG_COLUMN = "tag"
ENTRY_SPLIT = "split"
ENTRY_BUNDLE = "bundle"
ENTRY_TASK_ID = "taskId"
ENTRY_PERSONA = "persona"
ENTRY_PROMPT = "prompt"
ENTRY_REASON = "reason"

BENCHMARK_WORLD_PREFIX = "bench"
BENCHMARK_SLUG_MAX_LENGTH = 70
TRAIN_TASK_SLUG_MAX_LENGTH = 40
BUNDLE_HASH_LENGTH = 6
NON_SLUG_CHARACTERS = re.compile(r"[^a-z0-9]+")


class Command(str, Enum):
    CANDIDATES = "candidates"
    SELECT = "select"


class Tag(str, Enum):
    WORK = "work"
    PERSONAL = "personal"
    MIXED = "mixed"


PERSONAL_LIFE_TAGS = frozenset({Tag.PERSONAL, Tag.MIXED})


class Bucket(str, Enum):
    WORK = "work"
    PERSONAL_FAMILY = "personal_family"
    SELF_EMPLOYED = "self_employed"


class ExclusionRule(str, Enum):
    NO_GUI = "no_gui"
    UNSUPPORTED_SERVICE = "unsupported_service"
    ALREADY_A_WORLD = "already_a_world"
    NON_ENGLISH = "non_english"


@dataclass(frozen=True)
class TaskFacts:
    key: TaskKey
    persona: str
    prompt: str
    service_names: tuple[str, ...]
    has_apps: bool
    has_cjk: bool


@dataclass(frozen=True)
class EligibilityContext:
    supported_services: frozenset[str]
    world_task_ids: frozenset[str]


@dataclass(frozen=True)
class EligibilityReport:
    eligible: list[TaskFacts]
    excluded: Counter[ExclusionRule]


@dataclass(frozen=True)
class Rejection:
    key: TaskKey
    reason: str


@dataclass(frozen=True)
class BucketSpec:
    name: Bucket
    count: int
    max_per_persona: int
    pool: str
    is_member: Callable[[TaskFacts, Tag | None], bool]
    translated: bool = False


@dataclass(frozen=True)
class PickedTask:
    bucket: Bucket
    facts: TaskFacts
    world_id: str
    translated: bool


# ---------------------------------------------------------------------------
# Reading the dataset
# ---------------------------------------------------------------------------

def key_order(key: TaskKey) -> tuple[str, str, str]:
    return (key.split, key.bundle, key.task_id)


def derive_persona(key: TaskKey) -> str:
    if key.split == BENCHMARK_SPLIT:
        return key.task_id.split("_")[0].upper()
    match = PERSONA_PATTERN.match(key.bundle)
    if match is None:
        raise ImportFailure(f"cannot derive persona from bundle {key.bundle!r}")
    return match.group(PERSONA_GROUP)


def contains_cjk(text: str) -> bool:
    """JSON and YAML writers may store CJK as \\uXXXX escapes, so both forms are checked."""
    if CJK_CHARACTER_PATTERN.search(text):
        return True
    return any(int(code, 16) in CJK_CODE_POINTS for code in UNICODE_ESCAPE_PATTERN.findall(text))


def task_facts_from_row(row: Mapping[str, Any]) -> TaskFacts:
    key = TaskKey(row[COLUMN_SPLIT], row[COLUMN_BUNDLE], row[COLUMN_TASK_ID])
    task_yaml = yaml.load(row[COLUMN_TASK_YAML], Loader=YAML_LOADER)
    texts = (row[COLUMN_TASK_YAML], row[COLUMN_FIXTURES], row[COLUMN_LOGS])
    return TaskFacts(
        key=key,
        persona=derive_persona(key),
        prompt=task_yaml["prompt"]["text"],
        service_names=tuple(service["name"] for service in task_yaml.get("services") or []),
        has_apps="apps" in task_yaml,
        has_cjk=any(contains_cjk(text) for text in texts),
    )


def list_parquet_files(dataset_dir: Path) -> list[Path]:
    parquet_files = sorted((dataset_dir / DATASET_DATA_DIR).glob(PARQUET_GLOB))
    if not parquet_files:
        raise ImportFailure(f"no parquet files found in {dataset_dir / DATASET_DATA_DIR}")
    return parquet_files


def scan_dataset(dataset_dir: Path) -> list[TaskFacts]:
    facts = [item for path in list_parquet_files(dataset_dir) for item in scan_parquet(path)]
    if len({item.key for item in facts}) != len(facts):
        raise ImportFailure("the same task key appears more than once in the dataset")
    return sorted(facts, key=lambda item: key_order(item.key))


def scan_parquet(parquet_path: Path) -> list[TaskFacts]:
    """Stream the file in small batches so that only a few rows are in memory at once."""
    facts: list[TaskFacts] = []
    columns = [*KEY_COLUMNS, *CONTENT_COLUMNS]
    for batch in pq.ParquetFile(parquet_path).iter_batches(batch_size=SCAN_BATCH_ROWS, columns=columns):
        facts.extend(task_facts_from_row(row) for row in batch.to_pylist())
    return facts


def hash_parquet_files(dataset_dir: Path) -> dict[str, str]:
    return {path.name: sha256_file(path) for path in list_parquet_files(dataset_dir)}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(HASH_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Eligibility
# ---------------------------------------------------------------------------

def load_eligibility_context(worlds_dir: Path, route_factories_source: Path) -> EligibilityContext:
    return EligibilityContext(
        supported_services=load_supported_services(route_factories_source),
        world_task_ids=load_world_task_ids(worlds_dir),
    )


def load_supported_services(source: Path) -> frozenset[str]:
    """Service names are the keys of ROUTE_FACTORIES in the mock services entrypoint."""
    block = ROUTE_FACTORIES_BLOCK_PATTERN.search(source.read_text(encoding="utf-8"))
    if block is None:
        raise ImportFailure(f"ROUTE_FACTORIES block not found in {source}")
    names = frozenset(ROUTE_ENTRY_NAME_PATTERN.findall(block.group(ENTRIES_GROUP)))
    if not names:
        raise ImportFailure(f"ROUTE_FACTORIES lists no services in {source}")
    return names


def load_world_task_ids(worlds_dir: Path) -> frozenset[str]:
    task_ids = set()
    for world_yaml in sorted(worlds_dir.glob(f"*/{WORLD_YAML}")):
        world = yaml.load(world_yaml.read_text(encoding="utf-8"), Loader=YAML_LOADER)
        task_ids.add(str(world[WORLD_TASK_ID_KEY]).lower())
    return frozenset(task_ids)


def first_exclusion(facts: TaskFacts, ctx: EligibilityContext) -> ExclusionRule | None:
    if facts.has_apps or facts.key.bundle == GUI_BUNDLE:
        return ExclusionRule.NO_GUI
    if not set(facts.service_names) <= ctx.supported_services:
        return ExclusionRule.UNSUPPORTED_SERVICE
    if facts.key.task_id.lower() in ctx.world_task_ids:
        return ExclusionRule.ALREADY_A_WORLD
    if facts.has_cjk and facts.persona != HOMEMAKER_PERSONA:
        return ExclusionRule.NON_ENGLISH
    return None


def check_eligibility(facts: Sequence[TaskFacts], ctx: EligibilityContext) -> EligibilityReport:
    eligible: list[TaskFacts] = []
    excluded: Counter[ExclusionRule] = Counter()
    for item in facts:
        rule = first_exclusion(item, ctx)
        if rule is None:
            eligible.append(item)
        else:
            excluded[rule] += 1
    return EligibilityReport(eligible, excluded)


def is_candidate(facts: TaskFacts) -> bool:
    if facts.key.split == BENCHMARK_SPLIT:
        return True
    return (
        facts.persona != HOMEMAKER_PERSONA
        and facts.persona not in SELF_EMPLOYED_PERSONAS
        and PERSONAL_LIFE_HINT.search(facts.prompt) is not None
    )


# ---------------------------------------------------------------------------
# Tags and rejections
# ---------------------------------------------------------------------------

def load_tags(path: Path) -> dict[TaskKey, Tag]:
    tags: dict[TaskKey, Tag] = {}
    with path.open(newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            key = TaskKey(row[COLUMN_SPLIT], row[COLUMN_BUNDLE], row[COLUMN_TASK_ID])
            if key in tags:
                raise ImportFailure(f"{key} is tagged more than once")
            tags[key] = parse_tag(row[CSV_TAG_COLUMN], key)
    return tags


def parse_tag(value: str, key: TaskKey) -> Tag:
    try:
        return Tag(value)
    except ValueError as error:
        raise ImportFailure(f"unknown tag {value!r} for {key}") from error


def load_rejections(path: Path | None) -> list[Rejection]:
    if path is None:
        return []
    entries = json.loads(path.read_text(encoding="utf-8"))
    return [
        Rejection(TaskKey(entry[ENTRY_SPLIT], entry[ENTRY_BUNDLE], entry[ENTRY_TASK_ID]), entry[ENTRY_REASON])
        for entry in entries
    ]


def validate_tags(candidates: Sequence[TaskFacts], tags: Mapping[TaskKey, Tag]) -> None:
    candidate_keys = {item.key for item in candidates}
    untagged = [item.key for item in candidates if item.key.split == BENCHMARK_SPLIT and item.key not in tags]
    if untagged:
        raise ImportFailure(f"{len(untagged)} eligible benchmark tasks have no tag; first 5: {untagged[:5]}")
    not_candidates = [key for key in tags if key not in candidate_keys]
    if not_candidates:
        raise ImportFailure(f"{len(not_candidates)} tagged tasks are not candidates; first 5: {not_candidates[:5]}")


def check_rejections_known(rejections: Sequence[Rejection], facts: Sequence[TaskFacts]) -> None:
    known = {item.key for item in facts}
    unknown = [rejection.key for rejection in rejections if rejection.key not in known]
    if unknown:
        raise ImportFailure(f"rejected tasks are not in the dataset: {unknown}")


# ---------------------------------------------------------------------------
# Bucket membership and seeded picking
# ---------------------------------------------------------------------------

def _is_work_task(facts: TaskFacts, tag: Tag | None) -> bool:
    return facts.key.split == BENCHMARK_SPLIT and tag is Tag.WORK


def _is_personal_life_task(_facts: TaskFacts, tag: Tag | None) -> bool:
    return tag in PERSONAL_LIFE_TAGS


def _is_home_family_task(facts: TaskFacts, _tag: Tag | None) -> bool:
    return facts.key.split == TRAIN_SPLIT and facts.persona == HOMEMAKER_PERSONA


def _is_self_employed_task(facts: TaskFacts, _tag: Tag | None) -> bool:
    return facts.key.split == TRAIN_SPLIT and facts.persona in SELF_EMPLOYED_PERSONAS


BUCKET_SPECS = (
    BucketSpec(Bucket.WORK, 30, 3, "benchmark tasks tagged work", _is_work_task),
    BucketSpec(
        Bucket.PERSONAL_FAMILY,
        9,
        4,
        "benchmark tasks tagged personal or mixed, then train tasks tagged personal or mixed",
        _is_personal_life_task,
    ),
    BucketSpec(
        Bucket.PERSONAL_FAMILY,
        10,
        10,
        "train tasks of the homemaker persona",
        _is_home_family_task,
        translated=True,
    ),
    BucketSpec(
        Bucket.SELF_EMPLOYED,
        31,
        8,
        "eligible English train tasks of self-employed personas",
        _is_self_employed_task,
    ),
)


def seeded_rank(key: TaskKey) -> str:
    return hashlib.sha256(f"{SELECTION_SEED}:{key.split}:{key.bundle}:{key.task_id}".encode("utf-8")).hexdigest()


def pool_order(facts: TaskFacts) -> tuple[bool, str]:
    """Benchmark tasks come before train tasks; within each split the order is the seeded rank."""
    return (facts.key.split != BENCHMARK_SPLIT, seeded_rank(facts.key))


def pick_for_bucket(
    spec: BucketSpec,
    usable: Sequence[TaskFacts],
    tags: Mapping[TaskKey, Tag],
    taken: set[TaskKey],
) -> list[TaskFacts]:
    pool = sorted(
        (item for item in usable if item.key not in taken and spec.is_member(item, tags.get(item.key))),
        key=pool_order,
    )
    picks: list[TaskFacts] = []
    picks_per_persona: Counter[str] = Counter()
    for item in pool:
        if len(picks) == spec.count:
            break
        if picks_per_persona[item.persona] >= spec.max_per_persona:
            continue
        picks.append(item)
        picks_per_persona[item.persona] += 1
    if len(picks) < spec.count:
        raise ImportFailure(
            f"bucket {spec.name.value} needs {spec.count} tasks but only {len(picks)} fit its pool of {len(pool)}"
        )
    return picks


def select_tasks(usable: Sequence[TaskFacts], tags: Mapping[TaskKey, Tag]) -> list[PickedTask]:
    taken: set[TaskKey] = set()
    picked: list[PickedTask] = []
    for spec in BUCKET_SPECS:
        for item in pick_for_bucket(spec, usable, tags, taken):
            picked.append(
                PickedTask(
                    bucket=spec.name,
                    facts=item,
                    world_id=world_id_for(item),
                    translated=spec.translated,
                )
            )
            taken.add(item.key)
    return picked


# ---------------------------------------------------------------------------
# World ids
# ---------------------------------------------------------------------------

def slugify(text: str, max_length: int) -> str:
    return NON_SLUG_CHARACTERS.sub("_", text.lower()).strip("_")[:max_length].rstrip("_")


def world_id_for(facts: TaskFacts) -> str:
    if facts.key.split == BENCHMARK_SPLIT:
        return f"{BENCHMARK_WORLD_PREFIX}_{slugify(facts.key.task_id, BENCHMARK_SLUG_MAX_LENGTH)}"
    bundle_digest = hashlib.sha1(facts.key.bundle.encode("utf-8")).hexdigest()[:BUNDLE_HASH_LENGTH]
    task_slug = slugify(facts.key.task_id, TRAIN_TASK_SLUG_MAX_LENGTH)
    return f"{facts.persona.lower()}_{task_slug}_{bundle_digest}"


def check_world_ids(picked: Sequence[PickedTask]) -> None:
    world_ids = [item.world_id for item in picked]
    invalid = [world_id for world_id in world_ids if not WORLD_ID_PATTERN.fullmatch(world_id)]
    if invalid:
        raise ImportFailure(f"worldId must match [a-z0-9_]+, got {invalid}")
    duplicates = sorted({world_id for world_id in world_ids if world_ids.count(world_id) > 1})
    if duplicates:
        raise ImportFailure(f"worldIds are not unique: {duplicates}")


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def key_entry(key: TaskKey) -> dict[str, str]:
    return {ENTRY_SPLIT: key.split, ENTRY_BUNDLE: key.bundle, ENTRY_TASK_ID: key.task_id}


def candidate_entry(facts: TaskFacts) -> dict[str, str]:
    return {**key_entry(facts.key), ENTRY_PERSONA: facts.persona, ENTRY_PROMPT: facts.prompt}


def picked_entry(picked: PickedTask) -> dict[str, Any]:
    return {
        "bucket": picked.bucket.value,
        **key_entry(picked.facts.key),
        ENTRY_PERSONA: picked.facts.persona,
        "worldId": picked.world_id,
        "translated": picked.translated,
    }


def rejection_entry(rejection: Rejection) -> dict[str, str]:
    return {**key_entry(rejection.key), ENTRY_REASON: rejection.reason}


def build_manifest(
    facts: Sequence[TaskFacts],
    ctx: EligibilityContext,
    tags: Mapping[TaskKey, Tag],
    rejections: Sequence[Rejection],
    dataset_revision: str,
    dataset_files: Mapping[str, str],
) -> dict[str, Any]:
    report = check_eligibility(facts, ctx)
    validate_tags([item for item in report.eligible if is_candidate(item)], tags)
    check_rejections_known(rejections, facts)
    rejected_keys = {rejection.key for rejection in rejections}
    usable = [item for item in report.eligible if item.key not in rejected_keys]
    picked = select_tasks(usable, tags)
    check_world_ids(picked)
    return {
        "name": SELECTION_NAME,
        "dataset": {"id": DATASET_ID, "revision": dataset_revision, "files": dict(dataset_files)},
        "seed": SELECTION_SEED,
        "rules": {
            "englishOnly": True,
            "noGui": True,
            "supportedServicesOnly": True,
            "excludedBecauseAlreadyAWorld": report.excluded[ExclusionRule.ALREADY_A_WORLD],
            "buckets": [
                {
                    "bucket": spec.name.value,
                    "count": spec.count,
                    "maxPerPersona": spec.max_per_persona,
                    "pool": spec.pool,
                }
                for spec in BUCKET_SPECS
            ],
        },
        "tasks": [picked_entry(item) for item in picked],
        "rejected": [rejection_entry(rejection) for rejection in rejections],
    }


def write_json(payload: Any, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def print_exclusions(report: EligibilityReport) -> None:
    for rule in ExclusionRule:
        print(f"  removed by {rule.value}: {report.excluded[rule]}")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def run_candidates(args: argparse.Namespace, route_factories_source: Path) -> None:
    facts = scan_dataset(args.dataset_dir)
    report = check_eligibility(facts, load_eligibility_context(DEFAULT_WORLDS_DIR, route_factories_source))
    candidates = [item for item in report.eligible if is_candidate(item)]
    write_json([candidate_entry(item) for item in candidates], args.output)
    print_exclusions(report)
    benchmark_count = sum(item.key.split == BENCHMARK_SPLIT for item in candidates)
    print(f"Wrote {benchmark_count} benchmark and {len(candidates) - benchmark_count} train candidates to {args.output}")


def run_select(args: argparse.Namespace, route_factories_source: Path) -> None:
    manifest = build_manifest(
        facts=scan_dataset(args.dataset_dir),
        ctx=load_eligibility_context(args.worlds_dir, route_factories_source),
        tags=load_tags(args.tags),
        rejections=load_rejections(args.rejections),
        dataset_revision=args.dataset_revision,
        dataset_files=hash_parquet_files(args.dataset_dir),
    )
    write_json(manifest, args.output)
    print(f"Selected {len(manifest['tasks'])} tasks, recorded {len(manifest['rejected'])} rejections in {args.output}")


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Select the everyday-v1 Claw-Anything tasks")
    subparsers = parser.add_subparsers(required=True)

    candidates = subparsers.add_parser(Command.CANDIDATES.value, help="list tasks that need a work/personal/mixed tag")
    candidates.add_argument("--dataset-dir", type=Path, required=True, help="Dataset root containing data/*.parquet")
    candidates.add_argument("--output", type=Path, required=True, help="JSON file to write")
    candidates.set_defaults(handler=run_candidates)

    select = subparsers.add_parser(Command.SELECT.value, help="write the everyday-v1 selection manifest")
    select.add_argument("--dataset-dir", type=Path, required=True, help="Dataset root containing data/*.parquet")
    select.add_argument("--dataset-revision", required=True, help="Dataset commit SHA recorded in the manifest")
    select.add_argument("--tags", type=Path, required=True, help="CSV with split,bundle,task_id,tag,reason")
    select.add_argument("--rejections", type=Path, help="JSON list of tasks to drop, with reasons")
    select.add_argument("--worlds-dir", type=Path, default=DEFAULT_WORLDS_DIR, help="Existing worlds directory")
    select.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Manifest JSON to write")
    select.set_defaults(handler=run_select)

    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None, route_factories_source: Path = ROUTE_FACTORIES_SOURCE) -> int:
    args = parse_args(argv)
    try:
        args.handler(args, route_factories_source)
    except ImportFailure as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
