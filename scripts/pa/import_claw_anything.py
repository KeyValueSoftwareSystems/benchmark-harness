#!/usr/bin/env python3
"""Import Claw-Anything benchmark tasks from Hugging Face parquet files into PA worlds.

Each selected task becomes a world under resources/pa/worlds/{world_id}/:

    world.yaml      - API-side setup: prompt, tools, services, environment
    grading.yaml    - API-side scoring: rubric, expected actions, safety checks
    agent/          - copied into the PI agent container
        persona.json
        fixtures/   - mock service data
        logs/       - work journal and timelines

Email addresses and http(s) URLs in the task are rewritten to the `.example` domain.
Fixture items created after the execution date are dropped; items created on that day are kept.

Requires pyarrow and pyyaml.

Usage:
    python scripts/pa/import_claw_anything.py --dataset-dir DIR (--manifest FILE | --task SPLIT:BUNDLE:TASK_ID ...)
        [--output DIR] [--overlay FILE] [--force]

--overlay applies a reviewed JSON file that overrides persona fields, removes fixture items and edits grading text in imported worlds.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import shutil
import sys
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Any

import pyarrow.parquet as pq
import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_WORLDS_DIR = REPO_ROOT / "resources" / "pa" / "worlds"

DATASET_DATA_DIR = "data"
PARQUET_GLOB = "*.parquet"

COLUMN_SPLIT = "split"
COLUMN_BUNDLE = "bundle"
COLUMN_TASK_ID = "task_id"
COLUMN_TASK_YAML = "task_yaml"
COLUMN_FIXTURES = "fixtures"
COLUMN_LOGS = "logs"
KEY_COLUMNS = (COLUMN_SPLIT, COLUMN_BUNDLE, COLUMN_TASK_ID)
CONTENT_COLUMNS = (COLUMN_TASK_YAML, COLUMN_FIXTURES, COLUMN_LOGS)
SCAN_BATCH_ROWS = 8

FIXTURES_DIR = "fixtures"
LOGS_DIR = "logs"
AGENT_DIR = "agent"
AGENT_SUBDIRS = frozenset({FIXTURES_DIR, LOGS_DIR})
WORLD_YAML = "world.yaml"
GRADING_YAML = "grading.yaml"
PERSONA_JSON = "persona.json"
WORK_JOURNAL = "work_journal.md"

ENTRY_ENCODING = "encoding"
ENTRY_CONTENT = "content"

MANIFEST_TASKS = "tasks"
MANIFEST_SPLIT = "split"
MANIFEST_BUNDLE = "bundle"
MANIFEST_TASK_ID = "taskId"
MANIFEST_WORLD_ID = "worldId"
WORLD_ID_PATTERN = re.compile(r"[a-z0-9_]+")

EXAMPLE_TLD = "example"
RESERVED_TLDS = frozenset({EXAMPLE_TLD, "test", "invalid", "localhost"})
HOST_PATTERN = r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+"
EMAIL_LOCAL_PART_CHARS = r"A-Za-z0-9._%+-"
EMAIL_OR_URL_PATTERN = re.compile(
    rf"(?P<prefix>(?<![{EMAIL_LOCAL_PART_CHARS}])[{EMAIL_LOCAL_PART_CHARS}]+@|https?://)(?P<host>{HOST_PATTERN})"
)
PREFIX_GROUP = "prefix"
HOST_GROUP = "host"
BARE_HOST_TLDS = frozenset(
    {
        "com", "org", "net", "io", "co", "ai", "edu", "gov", "app", "dev", "info", "biz", "cn", "uk", "de",
        "fr", "jp", "in", "sg", "ae", "it", "es", "au", "ca", "us", "eu",
    }
)
BARE_HOST_PATTERN = re.compile(
    r"(?<![\w@.-])((?:[a-z0-9-]+\.)+(?:" + "|".join(sorted(BARE_HOST_TLDS)) + r"))(?![\w-]|\.\w)"
)


class ImportFailure(Exception):
    """A problem with the dataset, the selection or the output that stops the import."""


class FileEncoding(str, Enum):
    UTF8 = "utf8"
    BASE64 = "base64"


class PersonaField(str, Enum):
    NAME = "name"
    EMAIL = "email"
    ROLE = "role"
    ORGANIZATION = "organization"
    COMMUNICATION_STYLE = "communication_style"


class GradingTextField(str, Enum):
    REFERENCE_SOLUTION = "reference_solution"
    JUDGE_RUBRIC = "judge_rubric"


@dataclass(frozen=True)
class TaskKey:
    split: str
    bundle: str
    task_id: str


@dataclass(frozen=True)
class TaskSelection:
    key: TaskKey
    world_id: str | None = None


@dataclass(frozen=True)
class TaskRecord:
    task_yaml: str
    fixtures: str
    logs: str


@dataclass(frozen=True)
class StagedWorld:
    world_id: str
    path: Path
    dropped_fixture_items: Mapping[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class FixtureItemRemoval:
    file: str
    item_id: str
    reason: str


@dataclass(frozen=True)
class GradingEdit:
    field: GradingTextField
    find: str
    replace: str
    reason: str


@dataclass(frozen=True)
class WorldOverlay:
    persona: str | None
    removals: tuple[FixtureItemRemoval, ...]
    grading_edits: tuple[GradingEdit, ...]


@dataclass(frozen=True)
class Overlay:
    personas: Mapping[str, Mapping[PersonaField, str]]
    worlds: Mapping[str, WorldOverlay]


# ---------------------------------------------------------------------------
# Domain rewriting
# ---------------------------------------------------------------------------

def rewrite_domains(text: str) -> str:
    """Replace the top-level domain of every email address, http(s) host and known-TLD bare host with `example`."""
    with_urls_rewritten = EMAIL_OR_URL_PATTERN.sub(_rewrite_match, text)
    return BARE_HOST_PATTERN.sub(_rewrite_bare_match, with_urls_rewritten)


def _rewrite_match(match: re.Match[str]) -> str:
    return match.group(PREFIX_GROUP) + _example_host(match.group(HOST_GROUP))


def _rewrite_bare_match(match: re.Match[str]) -> str:
    return _example_host(match.group(1))


def _example_host(host: str) -> str:
    labels = host.split(".")
    top_label = labels[-1]
    if top_label.lower() in RESERVED_TLDS or top_label.isdigit():
        return host
    return ".".join([*labels[:-1], EXAMPLE_TLD])


# ---------------------------------------------------------------------------
# Selecting and reading rows from parquet
# ---------------------------------------------------------------------------

def parse_task_argument(value: str) -> TaskKey:
    parts = value.split(":", 2)
    if len(parts) != 3 or not all(parts):
        raise ImportFailure(f"--task must be SPLIT:BUNDLE:TASK_ID, got {value!r}")
    split, bundle, task_id = parts
    return TaskKey(split, bundle, task_id)


def load_manifest(path: Path) -> list[TaskSelection]:
    entries = json.loads(path.read_text())[MANIFEST_TASKS]
    return [_manifest_selection(entry) for entry in entries]


def _manifest_selection(entry: Mapping[str, Any]) -> TaskSelection:
    world_id = entry.get(MANIFEST_WORLD_ID)
    if world_id is not None and not WORLD_ID_PATTERN.fullmatch(world_id):
        raise ImportFailure(f"worldId must match [a-z0-9_]+, got {world_id!r}")
    key = TaskKey(entry[MANIFEST_SPLIT], entry[MANIFEST_BUNDLE], entry[MANIFEST_TASK_ID])
    return TaskSelection(key, world_id)


def read_selected_rows(dataset_dir: Path, keys: set[TaskKey]) -> dict[TaskKey, TaskRecord]:
    parquet_files = sorted((dataset_dir / DATASET_DATA_DIR).glob(PARQUET_GLOB))
    if not parquet_files:
        raise ImportFailure(f"no parquet files found in {dataset_dir / DATASET_DATA_DIR}")
    found: dict[TaskKey, TaskRecord] = {}
    for parquet_file in parquet_files:
        found.update(scan_parquet_for_keys(parquet_file, keys - set(found)))
    missing = sorted(keys - set(found), key=str)
    if missing:
        raise ImportFailure(f"tasks not found in dataset: {missing}")
    return found


def scan_parquet_for_keys(parquet_path: Path, wanted: set[TaskKey]) -> dict[TaskKey, TaskRecord]:
    """Stream the file in small batches so only a few rows are in memory at once."""
    found: dict[TaskKey, TaskRecord] = {}
    if not wanted:
        return found
    columns = [*KEY_COLUMNS, *CONTENT_COLUMNS]
    for batch in pq.ParquetFile(parquet_path).iter_batches(batch_size=SCAN_BATCH_ROWS, columns=columns):
        for row in batch.to_pylist():
            key = TaskKey(row[COLUMN_SPLIT], row[COLUMN_BUNDLE], row[COLUMN_TASK_ID])
            if key not in wanted:
                continue
            if key in found:
                raise ImportFailure(f"{key} appears more than once in {parquet_path.name}")
            found[key] = TaskRecord(row[COLUMN_TASK_YAML], row[COLUMN_FIXTURES], row[COLUMN_LOGS])
    return found


# ---------------------------------------------------------------------------
# Writing agent files
# ---------------------------------------------------------------------------

def write_file_map(file_map: Mapping[str, Mapping[str, str]], agent_dir: Path) -> None:
    """Write a dataset `{path: {encoding, content}}` map below agent_dir."""
    for relative_path, entry in file_map.items():
        destination = agent_dir / checked_agent_path(relative_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(decode_entry(entry))


def checked_agent_path(relative_path: str) -> PurePosixPath:
    path = PurePosixPath(relative_path)
    if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] not in AGENT_SUBDIRS:
        raise ImportFailure(f"unexpected file path {relative_path!r}: must start with fixtures/ or logs/")
    return path


def decode_entry(entry: Mapping[str, str]) -> bytes:
    encoding = parse_encoding(entry[ENTRY_ENCODING])
    content = entry[ENTRY_CONTENT]
    if encoding is FileEncoding.UTF8:
        return rewrite_domains(content).encode("utf-8")
    try:
        return base64.b64decode(content, validate=True)
    except ValueError as error:
        raise ImportFailure(f"invalid base64 content: {error}") from error


def parse_encoding(value: str) -> FileEncoding:
    try:
        return FileEncoding(value)
    except ValueError as error:
        raise ImportFailure(f"unsupported file encoding {value!r}") from error


# ---------------------------------------------------------------------------
# Persona extraction helpers
# ---------------------------------------------------------------------------

INBOX_FIXTURE = Path("gmail") / "inbox.json"
CONTACTS_FIXTURE = Path("contacts") / "contacts.json"
DEFAULT_COMMUNICATION_STYLE = "professional"
COMMUNICATION_STYLE_KEYWORDS: dict[str, tuple[str, ...]] = {
    "direct, detail-oriented": ("confirmed", "verified", "calculated", "assessed"),
    "analytical, methodical": ("analyzed", "categorized", "cross-referenced", "framework"),
    "collaborative, inclusive": ("coordinated", "discussed", "consulted", "team"),
    "decisive, action-oriented": ("approved", "decided", "committed", "launched"),
}
DOMAIN_TOOL_GROUPS: dict[str, frozenset[str]] = {
    "finance": frozenset({"finance_list_transactions", "finance_get_transaction", "finance_report_submit"}),
    "procurement": frozenset({"inventory_list_products", "inventory_get_product", "inventory_create_order"}),
    "client management": frozenset({"crm_list_customers", "crm_get_customer"}),
    "support operations": frozenset({"helpdesk_list_tickets", "helpdesk_get_ticket"}),
    "scheduling": frozenset({"scheduler_list_jobs", "scheduler_get_job"}),
}
NON_PROSE_PREFIXES = ("http", "www", "+")
ROLE_PATTERN = re.compile(r"[A-Za-z][A-Za-z&/,'. -]{2,80}")
MAX_ROLE_WORDS = 8


def load_json_list(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with open(path) as f:
        return json.load(f)


def is_plausible_role(text: str) -> bool:
    return (
        len(text.split()) <= MAX_ROLE_WORDS
        and ROLE_PATTERN.fullmatch(text) is not None
        and not text.startswith(NON_PROSE_PREFIXES)
    )


def extract_persona_email(fixtures_dir: Path) -> str:
    """Find the persona's email — the most common 'to' address in the inbox."""
    messages = load_json_list(fixtures_dir / INBOX_FIXTURE)
    to_counts: Counter[str] = Counter()
    for msg in messages:
        to_field = msg.get("to", "")
        for addr in to_field.split(","):
            addr = addr.strip()
            if addr and "@" in addr:
                to_counts[addr] += 1
    if not to_counts:
        return ""
    return to_counts.most_common(1)[0][0]


def extract_persona_name(email: str, fixtures_dir: Path) -> str:
    """Derive persona name from contacts or email local part."""
    for contact in load_json_list(fixtures_dir / CONTACTS_FIXTURE):
        if contact.get("email", "").lower() == email.lower():
            return contact.get("name", "")
    local = email.split("@")[0] if "@" in email else email
    parts = re.split(r"[._-]", local)
    return " ".join(p.capitalize() for p in parts if p)


def extract_persona_org(email: str, fixtures_dir: Path, persona_name: str) -> str:
    """Derive organization from email signatures or domain fallback."""
    name_lower = persona_name.lower()
    for msg in load_json_list(fixtures_dir / INBOX_FIXTURE):
        if email.lower() not in msg.get("from", "").lower():
            continue
        lines = [line.strip() for line in msg.get("body", "").strip().split("\n") if line.strip()]
        for i, line in enumerate(lines):
            if name_lower in line.lower() and i + 2 < len(lines):
                org_candidate = lines[i + 2]
                if not org_candidate.startswith(NON_PROSE_PREFIXES) and len(org_candidate) > 3:
                    return org_candidate
    if "@" not in email:
        return ""
    domain = email.split("@")[1]
    return domain.split(".")[0].replace("-", " ").title()


def extract_persona_role(fixtures_dir: Path, persona_email: str, persona_name: str) -> str:
    """Try to find the persona's role from contacts or email signatures."""
    for contact in load_json_list(fixtures_dir / CONTACTS_FIXTURE):
        if contact.get("email", "").lower() == persona_email.lower():
            title = contact.get("title", "")
            if title and is_plausible_role(title):
                return title
    name_lower = persona_name.lower()
    for msg in load_json_list(fixtures_dir / INBOX_FIXTURE):
        if persona_email.lower() not in msg.get("from", "").lower():
            continue
        lines = [line.strip() for line in msg.get("body", "").strip().split("\n") if line.strip()]
        for i, line in enumerate(lines):
            if name_lower in line.lower() and i + 1 < len(lines):
                candidate = lines[i + 1]
                if len(candidate.split()) >= 2 and is_plausible_role(candidate):
                    return candidate
    return ""


def extract_communication_style(work_journal_path: Path) -> str:
    """Infer communication style from work journal entries."""
    if not work_journal_path.exists():
        return DEFAULT_COMMUNICATION_STYLE
    text = work_journal_path.read_text().lower()
    scores = {
        style: sum(text.count(keyword) for keyword in keywords)
        for style, keywords in COMMUNICATION_STYLE_KEYWORDS.items()
    }
    return max(scores, key=scores.get) if scores else DEFAULT_COMMUNICATION_STYLE


def extract_domain_knowledge(task_yaml: dict[str, Any]) -> list[str]:
    """Extract domain knowledge areas from task category and tools."""
    domains = set()
    category = task_yaml.get("category", "")
    if category:
        domains.add(category.replace("_", " "))
    tool_names = {t["name"] for t in task_yaml.get("tools", [])}
    for domain, group_tools in DOMAIN_TOOL_GROUPS.items():
        if tool_names & group_tools:
            domains.add(domain)
    return sorted(domains)


# ---------------------------------------------------------------------------
# Build output artifacts
# ---------------------------------------------------------------------------

def build_persona(task_yaml: dict[str, Any], fixtures_dir: Path, logs_dir: Path) -> dict[str, Any]:
    """Build persona.json — agent-side identity data."""
    email = extract_persona_email(fixtures_dir)
    name = extract_persona_name(email, fixtures_dir)
    return {
        "persona_id": task_yaml.get("task_id", "unknown"),
        "name": name,
        "email": email,
        "role": extract_persona_role(fixtures_dir, email, name),
        "organization": extract_persona_org(email, fixtures_dir, name),
        "communication_style": extract_communication_style(logs_dir / WORK_JOURNAL),
        "domain_knowledge": extract_domain_knowledge(task_yaml),
        "execution_date": str(task_yaml.get("execution_date", "")),
    }


def build_world(task_yaml: dict[str, Any]) -> dict[str, Any]:
    """Build world.yaml — API-side setup data (prompt, tools, services, environment).

    Contains everything needed to configure the run. No grading fields.
    """
    return {
        "task_id": task_yaml.get("task_id"),
        "task_name": task_yaml.get("task_name"),
        "category": task_yaml.get("category"),
        "difficulty": task_yaml.get("difficulty"),
        "prompt": task_yaml.get("prompt"),
        "execution_date": str(task_yaml["execution_date"]),
        "tools": [_build_tool(tool) for tool in task_yaml.get("tools", [])],
        "tool_endpoints": task_yaml.get("tool_endpoints", []),
        "services": [{"name": s["name"], "port": s["port"]} for s in task_yaml.get("services", [])],
        "environment": task_yaml.get("environment", {}),
    }


def _build_tool(tool: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "name": tool["name"],
        "description": tool["description"],
        "input_schema": tool["input_schema"],
    }


CHECK_KEY = "check"
CHECK_TYPE_KEY = "type"
CHECK_DESCRIPTION_KEY = "description"
KEYWORDS_PRESENT = "keywords_present"
KEYWORDS_KEY = "keywords"
FORBIDDEN_KEYWORDS_KEY = "forbidden_keywords"


def build_grading(task_yaml: dict[str, Any]) -> dict[str, Any]:
    """Build grading.yaml — API-side scoring data (rubric, expected actions, safety).

    Only the API reads this file; it is never copied into any agent container.
    """
    task_id = task_yaml.get("task_id")
    grading = {
        "task_id": task_id,
        "scoring_components": task_yaml.get("scoring_components", []),
        "safety_checks": task_yaml.get("safety_checks", []),
        "expected_actions": task_yaml.get("expected_actions", []),
        "judge_rubric": task_yaml.get("judge_rubric", ""),
        "reference_solution": task_yaml.get("reference_solution", ""),
        "primary_dimensions": task_yaml.get("primary_dimensions", []),
    }
    return _normalize_keyword_checks(grading, task_id)


def _normalize_keyword_checks(grading: dict[str, Any], task_id: str | None) -> dict[str, Any]:
    """Rename the dataset's `forbidden_keywords` to the loader's `keywords` on keywords_present checks."""
    safety_checks = [_normalize_keyword_check(check, task_id) for check in grading["safety_checks"]]
    scoring_components = [
        {**component, CHECK_KEY: _normalize_keyword_check(component[CHECK_KEY], task_id)}
        for component in grading["scoring_components"]
    ]
    return {**grading, "safety_checks": safety_checks, "scoring_components": scoring_components}


def _normalize_keyword_check(check: dict[str, Any], task_id: str | None) -> dict[str, Any]:
    if check.get(CHECK_TYPE_KEY) != KEYWORDS_PRESENT:
        return check
    has_keywords = KEYWORDS_KEY in check
    has_forbidden_keywords = FORBIDDEN_KEYWORDS_KEY in check
    if has_keywords == has_forbidden_keywords:
        raise ImportFailure(
            f"task {task_id}: {KEYWORDS_PRESENT} check {check.get(CHECK_DESCRIPTION_KEY)!r} must have exactly one of "
            f"{KEYWORDS_KEY} or {FORBIDDEN_KEYWORDS_KEY}"
        )
    if has_keywords:
        return check
    renamed = dict(check)
    renamed[KEYWORDS_KEY] = renamed.pop(FORBIDDEN_KEYWORDS_KEY)
    return renamed


def derive_world_id(task_id: str, persona_name: str) -> str:
    """Create a human-readable world ID from persona name and task ID."""
    name_slug = re.sub(r"[^a-z0-9]+", "_", persona_name.lower()).strip("_")
    task_slug = re.sub(r"[^a-z0-9]+", "_", task_id.lower()).strip("_")
    if name_slug:
        max_task = 70 - len(name_slug)
        return f"{name_slug}_{task_slug[:max_task]}"
    return task_slug[:80]


# ---------------------------------------------------------------------------
# Execution date: fixture items created after the execution date
# ---------------------------------------------------------------------------

ISO_DAY_LENGTH = len("YYYY-MM-DD")
MIDNIGHT_SUFFIX = "T00:00:00"
TIMESTAMP_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?")

# Fixture directory -> key holding each item's creation (or receipt, post or sent) time.
# Calendar events, scheduler jobs and due dates are absent on purpose: they may refer to the future.
CREATION_TIME_KEYS: Mapping[str, tuple[str, ...]] = {
    "claw_linkedin": ("posted_at",),
    "claw_notion": ("created_at",),
    "claw_obsidian": ("created_at",),
    "claw_slack": ("created_at",),
    "claw_zotero": ("date_added",),
    "finance": ("date",),
    "gmail": ("date",),
    "helpdesk": ("created_at",),
    "kb": ("created_at",),
    "meeting": ("created_at",),
    "notes": ("created_at",),
    "rss": ("published_at",),
    "sheet": ("created_at",),
    "slide": ("created_at",),
    "todo": ("created_at",),
    "workmail": ("date",),
}


def creation_time(record: Mapping[str, Any], service: str) -> str | None:
    """Naive `YYYY-MM-DDTHH:MM:SS` creation time of a fixture record (UTC offset ignored), or None when it has none."""
    for key in CREATION_TIME_KEYS.get(service, ()):
        value = record.get(key)
        match = TIMESTAMP_PATTERN.match(value) if isinstance(value, str) else None
        if match is not None:
            return _as_naive_datetime(match.group(0))
    return None


def _as_naive_datetime(timestamp: str) -> str:
    return timestamp if len(timestamp) > ISO_DAY_LENGTH else timestamp + MIDNIGHT_SUFFIX


def is_created_after_execution_date(record: Mapping[str, Any], service: str, execution_date: str) -> bool:
    """True when the record's creation day is later than the execution date; items on that day are kept."""
    created = creation_time(record, service)
    return created is not None and created[:ISO_DAY_LENGTH] > execution_date


def drop_items_after_execution_date(agent_dir: Path, execution_date: str) -> Counter[str]:
    """Remove fixture items created after the execution date; returns the number dropped per service."""
    dropped: Counter[str] = Counter()
    for service in CREATION_TIME_KEYS:
        for path in sorted((agent_dir / FIXTURES_DIR / service).glob("*.json")):
            dropped[service] += _drop_items_in_file(path, service, execution_date)
    return dropped


def _drop_items_in_file(path: Path, service: str, execution_date: str) -> int:
    text = path.read_text(encoding="utf-8")
    data = json.loads(text)
    records = fixture_records(data, str(path))
    kept = [record for record in records if not is_created_after_execution_date(record, service, execution_date)]
    dropped = len(records) - len(kept)
    if dropped:
        records[:] = kept
        path.write_text(_render_json(data, text.endswith("\n")), encoding="utf-8")
    return dropped


def describe_dropped(dropped: Mapping[str, int]) -> str:
    counts = [f"{service} {count}" for service, count in dropped.items() if count]
    return ", ".join(counts) if counts else "none"


# ---------------------------------------------------------------------------
# Stage and place worlds
# ---------------------------------------------------------------------------

def stage_world(record: TaskRecord, world_id: str | None, staging_root: Path) -> StagedWorld:
    """Write one world into a temporary directory so the output is untouched until all tasks succeed."""
    task_yaml = yaml.safe_load(rewrite_domains(record.task_yaml))
    staging_dir = Path(tempfile.mkdtemp(dir=staging_root))
    agent_dir = staging_dir / AGENT_DIR
    write_file_map(json.loads(record.fixtures), agent_dir)
    write_file_map(json.loads(record.logs), agent_dir)
    dropped = drop_items_after_execution_date(agent_dir, str(task_yaml["execution_date"]))

    persona = build_persona(task_yaml, agent_dir / FIXTURES_DIR, agent_dir / LOGS_DIR)
    resolved_world_id = world_id or derive_world_id(task_yaml["task_id"], persona["name"])

    _write_yaml(staging_dir / WORLD_YAML, build_world(task_yaml))
    _write_yaml(staging_dir / GRADING_YAML, build_grading(task_yaml))
    write_persona(agent_dir / PERSONA_JSON, persona)
    return StagedWorld(resolved_world_id, staging_dir, dropped)


def _write_yaml(path: Path, data: Mapping[str, Any]) -> None:
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def write_persona(path: Path, persona: Mapping[str, Any]) -> None:
    with open(path, "w") as f:
        json.dump(persona, f, indent=2)


def place_worlds(staged_worlds: Sequence[StagedWorld], output_dir: Path, force: bool) -> None:
    world_ids = [world.world_id for world in staged_worlds]
    duplicate_ids = sorted({wid for wid in world_ids if world_ids.count(wid) > 1})
    if duplicate_ids:
        raise ImportFailure(f"selected tasks share world ids {duplicate_ids}; set worldId in the manifest")
    existing_ids = [wid for wid in world_ids if (output_dir / wid).exists()]
    if existing_ids and not force:
        raise ImportFailure(f"worlds already exist {existing_ids}; use --force to overwrite")

    output_dir.mkdir(parents=True, exist_ok=True)
    for world in staged_worlds:
        destination = output_dir / world.world_id
        if destination.exists():
            shutil.rmtree(destination)
        shutil.move(str(world.path), str(destination))
        print(f"Created {world.world_id} (time filter dropped: {describe_dropped(world.dropped_fixture_items)})")
    print(f"Imported {len(staged_worlds)} worlds into {output_dir}")


# ---------------------------------------------------------------------------
# Reviewed overlay
# ---------------------------------------------------------------------------

OVERLAY_PERSONAS = "personas"
OVERLAY_WORLDS = "worlds"
OVERLAY_PERSONA = "persona"
OVERLAY_REMOVE_ITEMS = "removeFixtureItems"
OVERLAY_ITEM_FILE = "file"
OVERLAY_ITEM_ID = "id"
OVERLAY_ITEM_REASON = "reason"
OVERLAY_EDIT_GRADING = "editGrading"
OVERLAY_EDIT_FIELD = "field"
OVERLAY_EDIT_FIND = "find"
OVERLAY_EDIT_REPLACE = "replace"
OVERLAY_EDIT_REASON = "reason"
FIND_PREVIEW_CHARS = 60
OPTIONAL_EMPTY_PERSONA_FIELDS = frozenset({PersonaField.ORGANIZATION})
ID_KEY = "id"
ID_KEY_SUFFIX = "_id"


def load_overlay(path: Path) -> Overlay:
    return parse_overlay(json.loads(path.read_text()))


def parse_overlay(data: Mapping[str, Any]) -> Overlay:
    _check_keys(data, {OVERLAY_PERSONAS, OVERLAY_WORLDS}, "overlay")
    personas = {
        key: _parse_persona_override(key, fields) for key, fields in data.get(OVERLAY_PERSONAS, {}).items()
    }
    worlds = {
        world_id: _parse_world_overlay(world_id, entry, personas)
        for world_id, entry in data.get(OVERLAY_WORLDS, {}).items()
    }
    return Overlay(personas, worlds)


def _parse_persona_override(key: str, fields: Mapping[str, Any]) -> dict[PersonaField, str]:
    _check_keys(fields, {field.value for field in PersonaField}, f"persona {key!r}")
    overrides: dict[PersonaField, str] = {}
    for raw_name, value in fields.items():
        field = PersonaField(raw_name)
        if not isinstance(value, str) or (field not in OPTIONAL_EMPTY_PERSONA_FIELDS and not value.strip()):
            raise ImportFailure(f"persona {key!r}: {raw_name} must be a non-empty string")
        overrides[field] = value
    return overrides


def _parse_world_overlay(world_id: str, entry: Mapping[str, Any], personas: Mapping[str, Any]) -> WorldOverlay:
    context = f"world {world_id!r}"
    _check_keys(entry, {OVERLAY_PERSONA, OVERLAY_REMOVE_ITEMS, OVERLAY_EDIT_GRADING}, context)
    persona = entry.get(OVERLAY_PERSONA)
    if persona is not None and persona not in personas:
        raise ImportFailure(f"{context}: persona {persona!r} is not defined in personas")
    removals = tuple(_parse_removal(context, item) for item in entry.get(OVERLAY_REMOVE_ITEMS, []))
    grading_edits = tuple(_parse_grading_edit(context, item) for item in entry.get(OVERLAY_EDIT_GRADING, []))
    return WorldOverlay(persona, removals, grading_edits)


def _parse_removal(context: str, entry: Mapping[str, Any]) -> FixtureItemRemoval:
    _check_keys(entry, {OVERLAY_ITEM_FILE, OVERLAY_ITEM_ID, OVERLAY_ITEM_REASON}, context)
    return FixtureItemRemoval(
        file=_required_text(entry, OVERLAY_ITEM_FILE, context),
        item_id=_required_text(entry, OVERLAY_ITEM_ID, context),
        reason=_required_text(entry, OVERLAY_ITEM_REASON, context),
    )


def _parse_grading_edit(context: str, entry: Mapping[str, Any]) -> GradingEdit:
    _check_keys(entry, {OVERLAY_EDIT_FIELD, OVERLAY_EDIT_FIND, OVERLAY_EDIT_REPLACE, OVERLAY_EDIT_REASON}, context)
    replace = entry.get(OVERLAY_EDIT_REPLACE)
    if not isinstance(replace, str):
        raise ImportFailure(f"{context}: {OVERLAY_EDIT_REPLACE} must be a string")
    return GradingEdit(
        field=_parse_grading_field(context, entry.get(OVERLAY_EDIT_FIELD)),
        find=_required_text(entry, OVERLAY_EDIT_FIND, context),
        replace=replace,
        reason=_required_text(entry, OVERLAY_EDIT_REASON, context),
    )


def _parse_grading_field(context: str, raw_name: Any) -> GradingTextField:
    try:
        return GradingTextField(raw_name)
    except ValueError:
        allowed = sorted(field.value for field in GradingTextField)
        raise ImportFailure(f"{context}: {OVERLAY_EDIT_FIELD} must be one of {allowed}, got {raw_name!r}") from None


def _check_keys(entry: Mapping[str, Any], allowed: set[str], context: str) -> None:
    unknown = sorted(set(entry) - allowed)
    if unknown:
        raise ImportFailure(f"{context}: unknown key(s) {unknown}")


def _required_text(entry: Mapping[str, Any], key: str, context: str) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ImportFailure(f"{context}: {key} must be a non-empty string")
    return value


def apply_overlay(staged_worlds: Sequence[StagedWorld], overlay: Overlay) -> None:
    staged_ids = {world.world_id for world in staged_worlds}
    unknown = sorted(set(overlay.worlds) - staged_ids)
    if unknown:
        raise ImportFailure(f"overlay refers to worlds not imported in this run: {unknown}")

    persona_count = 0
    for world in staged_worlds:
        world_overlay = overlay.worlds.get(world.world_id)
        if world_overlay is None:
            continue
        agent_dir = world.path / AGENT_DIR
        if world_overlay.persona is not None:
            override_persona(agent_dir / PERSONA_JSON, overlay.personas[world_overlay.persona])
            persona_count += 1
        for removal in world_overlay.removals:
            remove_fixture_item(agent_dir, removal, world.world_id)
        if world_overlay.grading_edits:
            edit_grading(world.path / GRADING_YAML, world_overlay.grading_edits, world.world_id)
        print(
            f"Overlay {world.world_id}: removed {len(world_overlay.removals)} fixture item(s), "
            f"{len(world_overlay.grading_edits)} grading edit(s)"
        )
    print(f"Overlay: overrode {persona_count} persona(s)")


def override_persona(persona_path: Path, overrides: Mapping[PersonaField, str]) -> None:
    persona = json.loads(persona_path.read_text())
    persona.update({field.value: value for field, value in overrides.items()})
    write_persona(persona_path, persona)


def remove_fixture_item(agent_dir: Path, removal: FixtureItemRemoval, world_id: str) -> None:
    path = agent_dir / checked_agent_path(removal.file)
    context = f"world {world_id}: {removal.file}"
    if not path.is_file():
        raise ImportFailure(f"{context} not found")
    text = path.read_text(encoding="utf-8")
    data = json.loads(text)
    records = fixture_records(data, context)
    matches = [record for record in records if _has_id(record, removal.item_id)]
    if len(matches) != 1:
        raise ImportFailure(f"{context}: expected 1 item with id {removal.item_id!r}, found {len(matches)}")
    records.remove(matches[0])
    path.write_text(_render_json(data, text.endswith("\n")), encoding="utf-8")


def edit_grading(grading_path: Path, edits: Sequence[GradingEdit], world_id: str) -> None:
    grading = yaml.safe_load(grading_path.read_text())
    for edit in edits:
        key = edit.field.value
        grading[key] = _replace_exactly_once(grading.get(key), edit, world_id)
    _write_yaml(grading_path, grading)


def _replace_exactly_once(text: Any, edit: GradingEdit, world_id: str) -> str:
    occurrences = text.count(edit.find) if isinstance(text, str) else 0
    if occurrences != 1:
        preview = edit.find[:FIND_PREVIEW_CHARS]
        raise ImportFailure(
            f"world {world_id}: {edit.field.value} find {preview!r}: expected 1 match, found {occurrences}"
        )
    return text.replace(edit.find, edit.replace, 1)


def fixture_records(data: Any, context: str) -> list[Any]:
    records = data if isinstance(data, list) else _sole_list(data)
    if records is None:
        raise ImportFailure(f"{context}: expected a list of objects or a dict holding exactly one list")
    if not all(isinstance(record, dict) for record in records):
        raise ImportFailure(f"{context}: list must contain only objects")
    return records


def _sole_list(data: Any) -> list[Any] | None:
    if not isinstance(data, dict):
        return None
    lists = [value for value in data.values() if isinstance(value, list)]
    return lists[0] if len(lists) == 1 else None


def _has_id(record: Mapping[str, Any], item_id: str) -> bool:
    return any(
        isinstance(value, str) and value == item_id and _is_id_key(key) for key, value in record.items()
    )


def _is_id_key(key: str) -> bool:
    return key == ID_KEY or key.endswith(ID_KEY_SUFFIX)


def _render_json(data: Any, trailing_newline: bool) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    return text + "\n" if trailing_newline else text


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import Claw-Anything tasks from parquet into PA worlds")
    parser.add_argument("--dataset-dir", type=Path, required=True, help="Dataset root containing data/*.parquet")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--manifest", type=Path, help="JSON file listing the tasks to import")
    source.add_argument("--task", action="append", metavar="SPLIT:BUNDLE:TASK_ID", help="Task to import (repeatable)")
    parser.add_argument("--output", type=Path, default=DEFAULT_WORLDS_DIR, help="Output directory for worlds")
    parser.add_argument("--overlay", type=Path, help="Reviewed JSON file of persona and fixture corrections")
    parser.add_argument("--force", action="store_true", help="Overwrite existing worlds")
    return parser.parse_args(argv)


def load_selections(args: argparse.Namespace) -> list[TaskSelection]:
    if args.manifest is not None:
        return load_manifest(args.manifest)
    return [TaskSelection(parse_task_argument(value)) for value in args.task]


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        selections = load_selections(args)
        records = read_selected_rows(args.dataset_dir, {selection.key for selection in selections})
        overlay = load_overlay(args.overlay) if args.overlay is not None else None
        with tempfile.TemporaryDirectory(prefix="claw-import-") as staging_root:
            staged = [
                stage_world(records[selection.key], selection.world_id, Path(staging_root))
                for selection in selections
            ]
            if overlay is not None:
                apply_overlay(staged, overlay)
            place_worlds(staged, args.output, args.force)
    except ImportFailure as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
