#!/usr/bin/env python3
"""Review PA world folders for quality problems before a benchmark is published.

Reads the worlds listed in a selection manifest and reports findings. Never modifies worlds.

Usage:
    python scripts/pa/review_worlds.py --manifest FILE [--worlds-dir DIR] [--output FILE.json]
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from collections.abc import Callable, Sequence
from datetime import date
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_claw_anything import (  # noqa: E402
    BARE_HOST_PATTERN,
    EMAIL_OR_URL_PATTERN,
    creation_time,
    is_created_after_execution_date,
    rewrite_domains,
)


REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_WORLDS_DIR = REPO_ROOT / "resources" / "pa" / "worlds"

MANIFEST_TASKS = "tasks"
MANIFEST_BUCKET = "bucket"
MANIFEST_WORLD_ID = "worldId"

WORLD_YAML = "world.yaml"
GRADING_YAML = "grading.yaml"
PERSONA_JSON = "persona.json"
AGENT_PREFIX = "agent/"
FIXTURES_PREFIX = "agent/fixtures/"
JSON_SUFFIX = ".json"

TOOL_NAME_KEY = "tool_name"
CHECK_KEY = "check"
CHECK_TYPE_KEY = "type"
REQUIRED_GRADING_FIELDS = ("judge_rubric", "reference_solution", "scoring_components")
ENGLISH = "en"
MAIL_PROVIDERS = frozenset({"gmail", "outlook", "yahoo", "qq", "163", "hotmail", "icloud"})
PLACEHOLDER_ORGANIZATIONS = frozenset({"personal", "self-employed", "selfemployed", "athlete", "freelance", "unemployed"})
MAX_ORGANIZATION_CHARS = 60

ID_KEY = "id"
ID_KEY_SUFFIX = "_id"
TITLE_KEYS = ("title", "subject", "name", "page_title")
MAX_TITLE_CHARS = 80
META_LEAK_PATTERNS = (
    "hidden conflict",
    "conflict identified",
    "violation detected",
    "critical situation analysis",
    "conflict analysis",
    "ground truth",
    "reference solution",
    "judge rubric",
    "grading rubric",
    "expected answer",
)

MAX_WORLD_BYTES = 2 * 1024 * 1024
BYTES_PER_KB = 1024
SNIPPET_CHARS = 100
EXAMPLE_HOST_LIMIT = 3
SHINGLE_WORDS = 8
MIN_CONTENT_WORDS_PER_SHINGLE = 3
ANSWER_LEAK_NOTE = (
    "answer_leak is a noisy heuristic: shared 8-word phrases are often legitimate facts. "
    "Per-world details are in the JSON output."
)
WORD_PATTERN = re.compile(r"[a-z0-9]+")
MONTH_NAMES = (
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
)
_MONTH_ALTERNATIVES = "|".join(MONTH_NAMES)
# "March 15" or "15 March"
PROMPT_DATE_PATTERN = re.compile(
    rf"\b(?P<month_first>{_MONTH_ALTERNATIVES})\s+(?P<day_after>\d{{1,2}})\b|\b(?P<day_before>\d{{1,2}})\s+(?P<month_second>{_MONTH_ALTERNATIVES})\b",
    re.IGNORECASE,
)
ID_PATTERN = re.compile(r"\b[A-Z]{2,}-\d+\b")
CJK_PATTERN = re.compile(r"[一-鿿]")
STOPWORDS = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "i", "in", "is", "it",
        "its", "of", "on", "or", "that", "the", "this", "to", "was", "were", "will", "with", "you", "your",
    }
)


class FindingKind(str, Enum):
    EMPTY_GRADING_FIELD = "empty_grading_field"
    TOOL_NOT_IN_WORLD = "tool_not_in_world"
    UNAVAILABLE_TOOL_RULE = "unavailable_tool_rule"
    ENDPOINT_PROBLEM = "endpoint_problem"
    SERVICE_WITHOUT_FIXTURE = "service_without_fixture"
    CJK_LEFT = "cjk_left"
    REAL_DOMAIN_LEFT = "real_domain_left"
    ANSWER_LEAK = "answer_leak"
    META_LEAK = "meta_leak"
    FUTURE_DATED_ITEM = "future_dated_item"
    DANGLING_REFERENCE = "dangling_reference"
    PERSONA_PROBLEM = "persona_problem"
    PROMPT_PROBLEM = "prompt_problem"
    PROMPT_DATE_BEFORE_EXECUTION = "prompt_date_before_execution"
    SIZE_WARNING = "size_warning"


class CheckType(str, Enum):
    TOOL_CALLED = "tool_called"
    TOOL_NOT_CALLED = "tool_not_called"


class Severity(str, Enum):
    ERROR = "error"
    WARN = "warn"


KIND_SEVERITY: dict[FindingKind, Severity] = {
    FindingKind.EMPTY_GRADING_FIELD: Severity.ERROR,
    FindingKind.TOOL_NOT_IN_WORLD: Severity.ERROR,
    FindingKind.UNAVAILABLE_TOOL_RULE: Severity.WARN,
    FindingKind.ENDPOINT_PROBLEM: Severity.ERROR,
    FindingKind.SERVICE_WITHOUT_FIXTURE: Severity.WARN,
    FindingKind.CJK_LEFT: Severity.ERROR,
    FindingKind.REAL_DOMAIN_LEFT: Severity.ERROR,
    FindingKind.ANSWER_LEAK: Severity.WARN,
    FindingKind.META_LEAK: Severity.WARN,
    FindingKind.FUTURE_DATED_ITEM: Severity.ERROR,
    FindingKind.DANGLING_REFERENCE: Severity.WARN,
    FindingKind.PERSONA_PROBLEM: Severity.WARN,
    FindingKind.PROMPT_PROBLEM: Severity.ERROR,
    FindingKind.PROMPT_DATE_BEFORE_EXECUTION: Severity.WARN,
    FindingKind.SIZE_WARNING: Severity.WARN,
}

TOOL_RULE_KINDS: dict[CheckType, FindingKind] = {
    CheckType.TOOL_CALLED: FindingKind.TOOL_NOT_IN_WORLD,
    CheckType.TOOL_NOT_CALLED: FindingKind.UNAVAILABLE_TOOL_RULE,
}


class ReviewFailure(Exception):
    """A problem with the manifest or a world directory that stops the review."""


@dataclass(frozen=True)
class Finding:
    world_id: str
    kind: FindingKind
    severity: Severity
    message: str
    file: str | None = None
    snippet: str | None = None
    item_id: str | None = None


@dataclass(frozen=True)
class World:
    world_id: str
    bucket: str
    size_bytes: int
    texts: dict[str, str]
    world_yaml: dict[str, Any]
    grading_yaml: dict[str, Any]
    persona: dict[str, Any] | None


@dataclass
class WorldReport:
    world_id: str
    bucket: str
    size_kb: float
    findings: list[Finding] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Loading worlds
# ---------------------------------------------------------------------------

def load_manifest_entries(manifest_path: Path) -> list[tuple[str, str]]:
    """Return (world_id, bucket) for each manifest task."""
    entries = json.loads(manifest_path.read_text())[MANIFEST_TASKS]
    return [(entry[MANIFEST_WORLD_ID], entry[MANIFEST_BUCKET]) for entry in entries]


def load_world(world_dir: Path, world_id: str, bucket: str) -> World:
    if not world_dir.is_dir():
        raise ReviewFailure(f"world directory not found: {world_dir}")
    files = [path for path in world_dir.rglob("*") if path.is_file()]
    texts = {path.relative_to(world_dir).as_posix(): path.read_text(encoding="utf-8", errors="replace") for path in files}
    persona_text = texts.get(AGENT_PREFIX + PERSONA_JSON)
    return World(
        world_id=world_id,
        bucket=bucket,
        size_bytes=sum(path.stat().st_size for path in files),
        texts=texts,
        world_yaml=_parse_yaml(world_id, texts, WORLD_YAML),
        grading_yaml=_parse_yaml(world_id, texts, GRADING_YAML),
        persona=json.loads(persona_text) if persona_text is not None else None,
    )


def _parse_yaml(world_id: str, texts: dict[str, str], name: str) -> dict[str, Any]:
    try:
        return yaml.safe_load(texts.get(name, "")) or {}
    except yaml.YAMLError as error:
        raise ReviewFailure(f"{world_id}: cannot parse {name}: {error}") from error


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def make_finding(
    world: World,
    kind: FindingKind,
    message: str,
    file: str | None = None,
    snippet: str | None = None,
    item_id: str | None = None,
) -> Finding:
    return Finding(world.world_id, kind, KIND_SEVERITY[kind], message, file, snippet, item_id)


def _is_blank(value: Any) -> bool:
    if isinstance(value, str):
        return not value.strip()
    return not value


def _snippet(text: str, start: int) -> str:
    return " ".join(text[start : start + SNIPPET_CHARS].split())


def _tool_names(world: World) -> set[str]:
    return {tool["name"] for tool in world.world_yaml.get("tools") or []}


def _services(world: World) -> list[dict[str, Any]]:
    return world.world_yaml.get("services") or []


def _agent_text(world: World) -> str:
    return "\n".join(text for path, text in world.texts.items() if path.startswith(AGENT_PREFIX))


def _grading_checks(grading: dict[str, Any]) -> list[dict[str, Any]]:
    scoring_checks = [component.get(CHECK_KEY) or {} for component in grading.get("scoring_components") or []]
    return [*scoring_checks, *(grading.get("safety_checks") or [])]


def fixture_items(text: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    records = _sole_list(data) if isinstance(data, dict) else data
    if not isinstance(records, list):
        return []
    return [record for record in records if isinstance(record, dict)]


def _sole_list(data: dict[str, Any]) -> list[Any] | None:
    lists = [value for value in data.values() if isinstance(value, list)]
    return lists[0] if len(lists) == 1 else None


def json_fixture_service(path: str) -> str | None:
    """Service directory of a JSON file directly under agent/fixtures/<service>/, else None."""
    parts = PurePosixPath(path).parts
    is_service_json = len(parts) == 4 and path.startswith(FIXTURES_PREFIX) and path.endswith(JSON_SUFFIX)
    return parts[2] if is_service_json else None


def fixture_item_id(item: dict[str, Any]) -> str | None:
    for key, value in item.items():
        if (key == ID_KEY or key.endswith(ID_KEY_SUFFIX)) and not _is_blank(value):
            return str(value)
    return None


def fixture_item_title(item: dict[str, Any]) -> str:
    for key in TITLE_KEYS:
        if not _is_blank(item.get(key)):
            return " ".join(str(item[key]).split())[:MAX_TITLE_CHARS]
    return ""


# ---------------------------------------------------------------------------
# Checks: each takes a World and returns its findings
# ---------------------------------------------------------------------------

def check_empty_grading_fields(world: World) -> list[Finding]:
    return [
        make_finding(world, FindingKind.EMPTY_GRADING_FIELD, f"{name} is empty")
        for name in REQUIRED_GRADING_FIELDS
        if _is_blank(world.grading_yaml.get(name))
    ]


def check_tool_rules(world: World) -> list[Finding]:
    declared = _tool_names(world)
    checks = _grading_checks(world.grading_yaml)
    findings = []
    for check_type, kind in TOOL_RULE_KINDS.items():
        undeclared = {
            check[TOOL_NAME_KEY]
            for check in checks
            if check.get(CHECK_TYPE_KEY) == check_type and not _is_blank(check.get(TOOL_NAME_KEY))
            and check[TOOL_NAME_KEY] not in declared
        }
        findings += [
            make_finding(world, kind, f"{name} is used in a {check_type.value} check but not declared in world.yaml")
            for name in sorted(undeclared)
        ]
    return findings


def check_endpoints(world: World) -> list[Finding]:
    endpoints = world.world_yaml.get("tool_endpoints") or []
    service_ports = [service["port"] for service in _services(world)]
    endpointed_tools = {endpoint.get(TOOL_NAME_KEY) for endpoint in endpoints}
    findings = [
        make_finding(world, FindingKind.ENDPOINT_PROBLEM, f"{name} has no tool_endpoints entry")
        for name in sorted(_tool_names(world) - endpointed_tools)
    ]
    findings += [
        make_finding(world, FindingKind.ENDPOINT_PROBLEM, f"{endpoint.get(TOOL_NAME_KEY)} url port {_url_port(endpoint.get('url', ''))} is not a service port")
        for endpoint in endpoints
        if _url_port(endpoint.get("url", "")) not in service_ports
    ]
    findings += [
        make_finding(world, FindingKind.ENDPOINT_PROBLEM, f"two services share port {port}")
        for port, count in Counter(service_ports).items()
        if count > 1
    ]
    return findings


def _url_port(url: str) -> int | None:
    try:
        return urlparse(url).port
    except ValueError:
        return None


def check_service_fixtures(world: World) -> list[Finding]:
    return [
        make_finding(world, FindingKind.SERVICE_WITHOUT_FIXTURE, f"service {service['name']} has no non-empty JSON fixture")
        for service in _services(world)
        if not _has_content_fixture(world, service["name"])
    ]


def _has_content_fixture(world: World, service_name: str) -> bool:
    prefix = f"{FIXTURES_PREFIX}{service_name}/"
    return any(
        _is_non_empty_json(text)
        for path, text in world.texts.items()
        if path.startswith(prefix) and path.endswith(JSON_SUFFIX)
    )


def _is_non_empty_json(text: str) -> bool:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return False
    return isinstance(data, (list, dict)) and bool(data)


def check_cjk(world: World) -> list[Finding]:
    findings = []
    for path, text in world.texts.items():
        match = CJK_PATTERN.search(text)
        if match:
            count = len(CJK_PATTERN.findall(text))
            findings.append(make_finding(world, FindingKind.CJK_LEFT, f"{count} CJK characters", path, _snippet(text, match.start())))
    return findings


def check_real_domains(world: World) -> list[Finding]:
    findings = []
    for path, text in world.texts.items():
        if rewrite_domains(text) == text:
            continue
        hosts = list(dict.fromkeys(_leaked_hosts(text)))[:EXAMPLE_HOST_LIMIT]
        findings.append(make_finding(world, FindingKind.REAL_DOMAIN_LEFT, f"real domains: {', '.join(hosts)}", path))
    return findings


def _leaked_hosts(text: str) -> list[str]:
    candidates = [match.group(0) for pattern in (EMAIL_OR_URL_PATTERN, BARE_HOST_PATTERN) for match in pattern.finditer(text)]
    return [candidate for candidate in candidates if rewrite_domains(candidate) != candidate]


def check_answer_leak(world: World) -> list[Finding]:
    grading = world.grading_yaml
    reference_shingles = set()
    for name in ("reference_solution", "judge_rubric"):
        reference_shingles |= _content_shingles(str(grading.get(name) or ""))
    findings = []
    for path, text in world.texts.items():
        if not path.startswith(AGENT_PREFIX):
            continue
        words = _words(text)
        hits = [i for i in range(len(words) - SHINGLE_WORDS + 1) if tuple(words[i : i + SHINGLE_WORDS]) in reference_shingles]
        if hits:
            snippet = " ".join(words[hits[0] : hits[0] + SHINGLE_WORDS])
            findings.append(make_finding(world, FindingKind.ANSWER_LEAK, f"{len(hits)} reference shingles match", path, snippet[:SNIPPET_CHARS]))
    return findings


def _words(text: str) -> list[str]:
    return WORD_PATTERN.findall(text.lower())


def _content_shingles(text: str) -> set[tuple[str, ...]]:
    words = _words(text)
    shingles = {tuple(words[i : i + SHINGLE_WORDS]) for i in range(len(words) - SHINGLE_WORDS + 1)}
    return {shingle for shingle in shingles if _content_word_count(shingle) >= MIN_CONTENT_WORDS_PER_SHINGLE}


def _content_word_count(shingle: tuple[str, ...]) -> int:
    return sum(word not in STOPWORDS for word in shingle)


def check_meta_leak(world: World) -> list[Finding]:
    findings = []
    for path, text in world.texts.items():
        if not (path.startswith(FIXTURES_PREFIX) and path.endswith(JSON_SUFFIX)):
            continue
        for item in fixture_items(text):
            pattern = matched_meta_leak_pattern(item)
            if pattern is not None:
                findings.append(make_finding(world, FindingKind.META_LEAK, pattern, path, fixture_item_title(item), fixture_item_id(item)))
    return findings


def matched_meta_leak_pattern(item: dict[str, Any]) -> str | None:
    item_text = json.dumps(item, ensure_ascii=False).lower()
    return next((pattern for pattern in META_LEAK_PATTERNS if pattern in item_text), None)


def check_future_dated_items(world: World) -> list[Finding]:
    execution_date = world.world_yaml.get("execution_date")
    if not isinstance(execution_date, str):
        return []
    findings = []
    for path, text in world.texts.items():
        service = json_fixture_service(path)
        if service is None:
            continue
        for item in fixture_items(text):
            if is_created_after_execution_date(item, service, execution_date):
                message = f"created {creation_time(item, service)}, after the execution date"
                findings.append(
                    make_finding(world, FindingKind.FUTURE_DATED_ITEM, message, path, fixture_item_title(item), fixture_item_id(item))
                )
    return findings


def check_dangling_references(world: World) -> list[Finding]:
    prompt_text = str((world.world_yaml.get("prompt") or {}).get("text") or "")
    grading_text = world.texts.get(GRADING_YAML, "")
    agent_text = _agent_text(world)
    identifiers = sorted({token for text in (grading_text, prompt_text) for token in ID_PATTERN.findall(text)})
    return [
        make_finding(world, FindingKind.DANGLING_REFERENCE, f"{identifier} does not appear in any agent file")
        for identifier in identifiers
        if identifier not in agent_text
    ]


def check_persona(world: World) -> list[Finding]:
    if world.persona is None:
        return [make_finding(world, FindingKind.PERSONA_PROBLEM, f"agent/{PERSONA_JSON} is missing")]
    return [make_finding(world, FindingKind.PERSONA_PROBLEM, problem) for problem in _persona_problems(world.persona)]


def _persona_problems(persona: dict[str, Any]) -> list[str]:
    name = str(persona.get("name") or "").strip()
    email = str(persona.get("email") or "").strip()
    organization = str(persona.get("organization") or "").strip()
    role = str(persona.get("role") or "").strip()
    problems = [
        _name_problem(name, email),
        "email is empty" if not email else None,
        _organization_problem(organization, email),
        "role is empty" if not role else None,
        "role equals the email address" if _equals_email(role, email) else None,
        "communication_style is empty" if not str(persona.get("communication_style") or "").strip() else None,
    ]
    return [problem for problem in problems if problem is not None]


def _name_problem(name: str, email: str) -> str | None:
    if not name:
        return "name is empty"
    if any(character.isdigit() for character in name):
        return "name contains a digit"
    if name.lower() == email.split("@")[0].lower():
        return "name equals the email local part"
    return None


def _organization_problem(organization: str, email: str) -> str | None:
    if _equals_email(organization, email):
        return "organization equals the email address"
    if "@" in organization:
        return "organization contains an email address"
    if len(organization) > MAX_ORGANIZATION_CHARS:
        return f"organization is longer than {MAX_ORGANIZATION_CHARS} characters"
    if organization.lower() in MAIL_PROVIDERS:
        return "organization is a mail provider"
    if organization.lower() in PLACEHOLDER_ORGANIZATIONS:
        return "organization is a placeholder, not a company"
    return None


def _equals_email(value: str, email: str) -> bool:
    return bool(email) and value.lower() == email.lower()


def check_prompt(world: World) -> list[Finding]:
    prompt = world.world_yaml.get("prompt") or {}
    problems = [
        "prompt text is empty" if _is_blank(prompt.get("text")) else None,
        f"language is {prompt.get('language')!r}, expected {ENGLISH!r}" if prompt.get("language") != ENGLISH else None,
        "execution_date is not a string" if not isinstance(world.world_yaml.get("execution_date"), str) else None,
    ]
    return [make_finding(world, FindingKind.PROMPT_PROBLEM, problem) for problem in problems if problem is not None]


def _prompt_date(match: re.Match[str], year: int) -> date | None:
    month_name = match.group("month_first") or match.group("month_second")
    day = int(match.group("day_after") or match.group("day_before"))
    try:
        return date(year, MONTH_NAMES.index(month_name.lower()) + 1, day)
    except ValueError:
        return None


def check_prompt_dates(world: World) -> list[Finding]:
    """Flags dates in the prompt that fall before the execution date, for a person to judge.

    A past date can be fine (a review of last week) or wrong (a deadline the assistant would treat as already missed).
    Only month-and-day dates are read, in the execution date's year.
    """
    execution_text = world.world_yaml.get("execution_date")
    prompt_text = (world.world_yaml.get("prompt") or {}).get("text")
    if not isinstance(execution_text, str) or not isinstance(prompt_text, str):
        return []
    execution_date = date.fromisoformat(execution_text)
    findings = []
    for match in PROMPT_DATE_PATTERN.finditer(prompt_text):
        mentioned = _prompt_date(match, execution_date.year)
        if mentioned is None or mentioned >= execution_date:
            continue
        days_before = (execution_date - mentioned).days
        message = f"prompt names {match.group(0)}, {days_before} days before the execution date {execution_text}"
        findings.append(make_finding(world, FindingKind.PROMPT_DATE_BEFORE_EXECUTION, message, WORLD_YAML, _snippet(prompt_text, match.start())))
    return findings


def check_size(world: World) -> list[Finding]:
    if world.size_bytes <= MAX_WORLD_BYTES:
        return []
    size_kb = world.size_bytes // BYTES_PER_KB
    return [make_finding(world, FindingKind.SIZE_WARNING, f"world is {size_kb} KB, over 2 MB")]


WORLD_CHECKS: tuple[Callable[[World], list[Finding]], ...] = (
    check_empty_grading_fields,
    check_tool_rules,
    check_endpoints,
    check_service_fixtures,
    check_cjk,
    check_real_domains,
    check_answer_leak,
    check_meta_leak,
    check_future_dated_items,
    check_dangling_references,
    check_persona,
    check_prompt,
    check_prompt_dates,
    check_size,
)


def review_world(world: World) -> list[Finding]:
    return [finding for check in WORLD_CHECKS for finding in check(world)]


# ---------------------------------------------------------------------------
# Summaries and output
# ---------------------------------------------------------------------------

def build_reports(manifest_path: Path, worlds_dir: Path) -> list[WorldReport]:
    reports = []
    for world_id, bucket in load_manifest_entries(manifest_path):
        world = load_world(worlds_dir / world_id, world_id, bucket)
        reports.append(WorldReport(world_id, bucket, world.size_bytes / BYTES_PER_KB, review_world(world)))
    return reports


def kind_totals(reports: Sequence[WorldReport]) -> Counter[FindingKind]:
    return Counter(finding.kind for report in reports for finding in report.findings)


def bucket_reports(reports: Sequence[WorldReport]) -> dict[str, list[WorldReport]]:
    grouped: dict[str, list[WorldReport]] = defaultdict(list)
    for report in reports:
        grouped[report.bucket].append(report)
    return grouped


def build_output(manifest_path: Path, reports: Sequence[WorldReport]) -> dict[str, Any]:
    return {
        "manifest": str(manifest_path),
        "worlds": [asdict(report) for report in reports],
        "totals": {kind.value: count for kind, count in kind_totals(reports).items()},
    }


def format_table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    cells = [[str(value) for value in row] for row in [headers, *rows]]
    widths = [max(len(row[column]) for row in cells) for column in range(len(headers))]
    lines = ["  ".join(value.ljust(width) for value, width in zip(row, widths)).rstrip() for row in cells]
    return "\n".join([lines[0], "-" * len(lines[0]), *lines[1:]])


def print_world_table(reports: Sequence[WorldReport]) -> None:
    rows = [
        [
            report.world_id,
            report.bucket,
            f"{report.size_kb:.1f}",
            _count(report, Severity.ERROR),
            _count(report, Severity.WARN),
            _kind_count([report], FindingKind.ANSWER_LEAK),
        ]
        for report in reports
    ]
    print(format_table(["world", "bucket", "size_kb", "errors", "warns", "answer_leak"], rows))


def _count(report: WorldReport, severity: Severity) -> int:
    return sum(finding.severity is severity for finding in report.findings)


def print_kind_totals(reports: Sequence[WorldReport]) -> None:
    totals = kind_totals(reports)
    rows = [[kind.value, KIND_SEVERITY[kind].value, totals[kind]] for kind in FindingKind]
    print(format_table(["finding kind", "severity", "total"], rows))
    print(ANSWER_LEAK_NOTE)


def print_meta_leaks(reports: Sequence[WorldReport]) -> None:
    print("meta_leak: world | file | item id | title | pattern")
    for report in reports:
        for finding in report.findings:
            if finding.kind is FindingKind.META_LEAK:
                print(f"{finding.world_id} | {finding.file} | {finding.item_id} | {finding.snippet} | {finding.message}")


def print_bucket_summary(reports: Sequence[WorldReport]) -> None:
    grouped = bucket_reports(reports)
    buckets = list(grouped)
    rows: list[list[Any]] = [
        ["worlds", *(len(grouped[bucket]) for bucket in buckets)],
        ["median size KB", *(f"{statistics.median(r.size_kb for r in grouped[bucket]):.1f}" for bucket in buckets)],
    ]
    for kind in FindingKind:
        rows.append([kind.value, *(_kind_count(grouped[bucket], kind) for bucket in buckets)])
    print(format_table(["per bucket", *buckets], rows))


def _kind_count(reports: Sequence[WorldReport], kind: FindingKind) -> int:
    return sum(finding.kind is kind for report in reports for finding in report.findings)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Review PA worlds for quality problems. Never modifies worlds.")
    parser.add_argument("--manifest", type=Path, required=True, help="Selection manifest listing the worlds to review")
    parser.add_argument("--worlds-dir", type=Path, default=DEFAULT_WORLDS_DIR, help="Directory holding the world folders")
    parser.add_argument("--output", type=Path, help="Write the full findings as JSON to this file")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        reports = build_reports(args.manifest, args.worlds_dir)
    except ReviewFailure as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print_world_table(reports)
    print()
    print_kind_totals(reports)
    print()
    print_meta_leaks(reports)
    print()
    print_bucket_summary(reports)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(build_output(args.manifest, reports), indent=2))
        print(f"\nWrote findings to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
