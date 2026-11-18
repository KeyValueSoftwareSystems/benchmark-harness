#!/usr/bin/env python3
"""Prepare PA worlds for LLM translation of their Chinese text, then write the translations back.

extract: list every Chinese text unit across the worlds, dedupe them and write chunk files for the translator.
apply:   check the translations against the originals, then replace each unit in the worlds.

Usage:
    python scripts/pa/translate_world.py extract --chunk-chars N --out-dir DIR WORLD_DIR [WORLD_DIR ...]
    python scripts/pa/translate_world.py apply --translations-dir DIR WORLD_DIR [WORLD_DIR ...]

Requires pyyaml.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Any

import yaml


class TranslateFailure(Exception):
    """A problem with the worlds or the translations that stops the run."""


class FileKind(str, Enum):
    JSON = "json"
    YAML = "yaml"
    TEXT = "text"


class ProblemKind(str, Enum):
    MISSING = "no translation"
    DUPLICATE = "translated more than once"
    UNKNOWN_ID = "id is not in the manifest"
    EMPTY = "translation is empty"
    CJK_LEFT = "translation still contains CJK characters"
    NEWLINE_MISMATCH = "newline count differs from original"
    DROPPED_TOKEN = "placeholder or ID token missing"


@dataclass(frozen=True)
class WorldFile:
    path: Path
    kind: FileKind


@dataclass(frozen=True)
class WorldDocument:
    world_file: WorldFile
    content: Any
    ends_with_newline: bool


@dataclass(frozen=True)
class TextUnit:
    unit_id: int
    text: str


@dataclass(frozen=True)
class WorldSummary:
    name: str
    unit_count: int
    chars: int


@dataclass(frozen=True)
class Problem:
    unit_id: int
    kind: ProblemKind
    detail: str
    sample: str


@dataclass(frozen=True)
class ApplyReport:
    translation_count: int
    replaced_units: int
    changed_files: list[Path]
    prompt_languages_set: int


CHINESE_PATTERN = re.compile(r"[一-鿿]")
CJK_ISH_PATTERN = re.compile(r"[　-〿一-鿿＀-￯]")
REQUIRED_TOKEN_PATTERN = re.compile(r"\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Z]{2,}-\d+")
PREVIEW_CHARS = 80

WORLD_YAML = "world.yaml"
GRADING_YAML = "grading.yaml"
PERSONA_JSON = "agent/persona.json"
ROOT_YAML_FILES = frozenset({WORLD_YAML, GRADING_YAML})
SCANNED_PREFIXES = frozenset({("agent", "fixtures"), ("agent", "logs")})
SUFFIX_KINDS = {".json": FileKind.JSON, ".md": FileKind.TEXT, ".txt": FileKind.TEXT}

MANIFEST_FILE = "manifest.json"
CHUNK_FILE_TEMPLATE = "chunk_{number:03d}.json"
TRANSLATED_SUFFIX = ".en.json"

KEY_ID = "id"
KEY_TEXT = "text"
KEY_FILE = "file"
KEY_IDS = "ids"
KEY_CHARS = "chars"
KEY_CHUNKS = "chunks"
KEY_UNIT_COUNT = "unitCount"
KEY_TOTAL_CHARS = "totalChars"
KEY_PROMPT = "prompt"
KEY_LANGUAGE = "language"
LANGUAGE_EN = "en"


# ---------------------------------------------------------------------------
# Finding the files and text units in a world
# ---------------------------------------------------------------------------

def has_chinese(text: str) -> bool:
    return CHINESE_PATTERN.search(text) is not None


def discover_world_files(world_dir: Path) -> list[WorldFile]:
    if not world_dir.is_dir():
        raise TranslateFailure(f"not a world directory: {world_dir}")
    entries = sorted(world_dir.rglob("*"), key=lambda path: path.relative_to(world_dir).as_posix())
    for entry in entries:
        if has_chinese(entry.relative_to(world_dir).as_posix()):
            raise TranslateFailure(f"file or directory name contains Chinese: {entry}")
    world_files = []
    for entry in entries:
        kind = file_kind(PurePosixPath(entry.relative_to(world_dir).as_posix()))
        if kind is not None and entry.is_file():
            world_files.append(WorldFile(entry, kind))
    return world_files


def file_kind(relative: PurePosixPath) -> FileKind | None:
    if relative.as_posix() in ROOT_YAML_FILES:
        return FileKind.YAML
    if relative.as_posix() == PERSONA_JSON:
        return FileKind.JSON
    if relative.parts[:2] in SCANNED_PREFIXES:
        return SUFFIX_KINDS.get(relative.suffix)
    return None


def load_document(world_file: WorldFile) -> WorldDocument:
    text = world_file.path.read_text(encoding="utf-8")
    return WorldDocument(world_file, parse_text(text, world_file.kind), text.endswith("\n"))


def parse_text(text: str, kind: FileKind) -> Any:
    if kind is FileKind.JSON:
        return json.loads(text)
    if kind is FileKind.YAML:
        return yaml.safe_load(text)
    return text.split("\n")


def render_document(document: WorldDocument) -> str:
    kind = document.world_file.kind
    if kind is FileKind.JSON:
        text = json.dumps(document.content, ensure_ascii=False, indent=2)
        return text + "\n" if document.ends_with_newline else text
    if kind is FileKind.YAML:
        return yaml.safe_dump(document.content, allow_unicode=True, sort_keys=False, default_flow_style=False)
    return "\n".join(document.content)


def write_atomically(path: Path, text: str) -> None:
    temp_path = path.with_name(f"{path.name}.tmp")
    temp_path.write_text(text, encoding="utf-8")
    temp_path.replace(path)


def iter_strings(node: Any, source: Path) -> Iterator[str]:
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for item in node:
            yield from iter_strings(item, source)
    elif isinstance(node, dict):
        for key, value in node.items():
            if isinstance(key, str) and has_chinese(key):
                raise TranslateFailure(f"{source}: dict key contains Chinese: {key!r}")
            yield from iter_strings(value, source)


def map_strings(node: Any, transform: Callable[[str], str]) -> Any:
    if isinstance(node, str):
        return transform(node)
    if isinstance(node, list):
        return [map_strings(item, transform) for item in node]
    if isinstance(node, dict):
        return {key: map_strings(value, transform) for key, value in node.items()}
    return node


def unit_texts(document: WorldDocument) -> list[str]:
    """Chinese strings in document order; text files contribute their lines."""
    return [text for text in iter_strings(document.content, document.world_file.path) if has_chinese(text)]


def world_unit_texts(world_dir: Path) -> list[str]:
    return [
        text
        for world_file in discover_world_files(world_dir)
        for text in unit_texts(load_document(world_file))
    ]


# ---------------------------------------------------------------------------
# extract
# ---------------------------------------------------------------------------

def extract_units(world_dirs: Sequence[Path]) -> tuple[list[TextUnit], list[WorldSummary]]:
    summaries: list[WorldSummary] = []
    texts: list[str] = []
    for world_dir in world_dirs:
        world_texts = list(dict.fromkeys(world_unit_texts(world_dir)))
        summaries.append(WorldSummary(world_dir.name, len(world_texts), total_chars_of_texts(world_texts)))
        texts.extend(world_texts)
    unique_texts = list(dict.fromkeys(texts))
    return [TextUnit(index, text) for index, text in enumerate(unique_texts)], summaries


def chunk_units(units: Sequence[TextUnit], max_chars: int) -> list[list[TextUnit]]:
    chunks: list[list[TextUnit]] = []
    current: list[TextUnit] = []
    for unit in units:
        if current and total_chars(current) + len(unit.text) > max_chars:
            chunks.append(current)
            current = []
        current.append(unit)
    if current:
        chunks.append(current)
    return chunks


def write_chunks(out_dir: Path, units: Sequence[TextUnit], chunks: Sequence[Sequence[TextUnit]]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_chunks = []
    for number, chunk in enumerate(chunks, start=1):
        file_name = CHUNK_FILE_TEMPLATE.format(number=number)
        write_json(out_dir / file_name, [{KEY_ID: unit.unit_id, KEY_TEXT: unit.text} for unit in chunk])
        manifest_chunks.append(
            {KEY_FILE: file_name, KEY_IDS: [chunk[0].unit_id, chunk[-1].unit_id], KEY_CHARS: total_chars(chunk)}
        )
    write_json(
        out_dir / MANIFEST_FILE,
        {KEY_UNIT_COUNT: len(units), KEY_TOTAL_CHARS: total_chars(units), KEY_CHUNKS: manifest_chunks},
    )


def total_chars(units: Sequence[TextUnit]) -> int:
    return total_chars_of_texts([unit.text for unit in units])


def total_chars_of_texts(texts: Sequence[str]) -> int:
    return sum(len(text) for text in texts)


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    if not path.is_file():
        raise TranslateFailure(f"missing file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def read_units(path: Path) -> list[TextUnit]:
    return [TextUnit(item[KEY_ID], item[KEY_TEXT]) for item in read_json(path)]


def run_extract(args: argparse.Namespace) -> None:
    units, summaries = extract_units(args.worlds)
    chunks = chunk_units(units, args.chunk_chars)
    write_chunks(args.out_dir, units, chunks)
    print(f"Units: {len(units)}")
    print(f"Total chars: {total_chars(units)}")
    print(f"Chunks: {len(chunks)} written to {args.out_dir}")
    for summary in summaries:
        print(f"  {summary.name}: {summary.unit_count} units, {summary.chars} chars")


# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------

def translated_name(chunk_file: str) -> str:
    return f"{Path(chunk_file).stem}{TRANSLATED_SUFFIX}"


def translation_defects(original_text: str, translated_text: str) -> list[tuple[ProblemKind, str]]:
    defects: list[tuple[ProblemKind, str]] = []
    if not translated_text.strip():
        defects.append((ProblemKind.EMPTY, ""))
    if CJK_ISH_PATTERN.search(translated_text):
        defects.append((ProblemKind.CJK_LEFT, ""))
    original_newlines = original_text.count("\n")
    translated_newlines = translated_text.count("\n")
    if original_newlines != translated_newlines:
        defects.append((ProblemKind.NEWLINE_MISMATCH, f"{translated_newlines} vs {original_newlines}"))
    dropped = [token for token in required_tokens(original_text) if token not in translated_text]
    if dropped:
        defects.append((ProblemKind.DROPPED_TOKEN, ", ".join(dropped)))
    return defects


def required_tokens(text: str) -> list[str]:
    return sorted(set(REQUIRED_TOKEN_PATTERN.findall(text)))


def find_problems(originals: Mapping[int, TextUnit], translated: Sequence[TextUnit]) -> list[Problem]:
    counts = Counter(unit.unit_id for unit in translated)
    problems: list[Problem] = []
    for unit_id, original in originals.items():
        if counts[unit_id] == 0:
            problems.append(Problem(unit_id, ProblemKind.MISSING, "", original.text))
        elif counts[unit_id] > 1:
            problems.append(Problem(unit_id, ProblemKind.DUPLICATE, f"{counts[unit_id]} entries", original.text))
    for unit in translated:
        original = originals.get(unit.unit_id)
        if original is None:
            problems.append(Problem(unit.unit_id, ProblemKind.UNKNOWN_ID, "", unit.text))
            continue
        problems.extend(
            Problem(unit.unit_id, kind, detail, unit.text)
            for kind, detail in translation_defects(original.text, unit.text)
        )
    return problems


def format_problems(problems: Sequence[Problem]) -> str:
    lines = [f"{len(problems)} translation problem(s), nothing was written:"]
    for problem in sorted(problems, key=lambda problem: problem.unit_id):
        detail = f" ({problem.detail})" if problem.detail else ""
        sample = problem.sample[:PREVIEW_CHARS]
        lines.append(f"  id {problem.unit_id}: {problem.kind.value}{detail}: {sample!r}")
    return "\n".join(lines)


def translate_document(document: WorldDocument, replacements: Mapping[str, str]) -> tuple[WorldDocument, int]:
    replaced = sum(1 for text in iter_strings(document.content, document.world_file.path) if text in replacements)
    content = map_strings(document.content, lambda text: replacements.get(text, text))
    return replace(document, content=content), replaced


def mark_prompt_english(document: WorldDocument) -> tuple[WorldDocument, bool]:
    """Set prompt.language to en in a world.yaml that has a prompt mapping; returns whether it changed."""
    if document.world_file.path.name != WORLD_YAML or not isinstance(document.content, dict):
        return document, False
    prompt = document.content.get(KEY_PROMPT)
    if not isinstance(prompt, dict) or prompt.get(KEY_LANGUAGE) == LANGUAGE_EN:
        return document, False
    content = {**document.content, KEY_PROMPT: {**prompt, KEY_LANGUAGE: LANGUAGE_EN}}
    return replace(document, content=content), True


def apply_translations(translations_dir: Path, world_dirs: Sequence[Path]) -> ApplyReport:
    chunk_files = [entry[KEY_FILE] for entry in read_json(translations_dir / MANIFEST_FILE)[KEY_CHUNKS]]
    originals = {unit.unit_id: unit for file in chunk_files for unit in read_units(translations_dir / file)}
    translated = [unit for file in chunk_files for unit in read_units(translations_dir / translated_name(file))]
    problems = find_problems(originals, translated)
    if problems:
        raise TranslateFailure(format_problems(problems))

    replacements = {originals[unit.unit_id].text: unit.text for unit in translated}
    documents = [
        load_document(world_file)
        for world_dir in world_dirs
        for world_file in discover_world_files(world_dir)
    ]
    replaced_units = 0
    prompt_languages_set = 0
    changed_files: list[Path] = []
    for document in documents:
        updated, replaced = translate_document(document, replacements)
        updated, language_set = mark_prompt_english(updated)
        replaced_units += replaced
        prompt_languages_set += language_set
        if updated.content != document.content:
            write_atomically(updated.world_file.path, render_document(updated))
            changed_files.append(updated.world_file.path)

    leftovers = [str(document.world_file.path) for document in documents if unit_texts(load_document(document.world_file))]
    if leftovers:
        raise TranslateFailure(f"Chinese text remains after apply in: {leftovers}")
    return ApplyReport(len(translated), replaced_units, changed_files, prompt_languages_set)


def run_apply(args: argparse.Namespace) -> None:
    report = apply_translations(args.translations_dir, args.worlds)
    print(
        f"Applied {report.translation_count} translations: replaced {report.replaced_units} units "
        f"in {len(report.changed_files)} files; set prompt.language to en in {report.prompt_languages_set} worlds"
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, got {value}")
    return number


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Translate the Chinese text in PA worlds with an LLM")
    subcommands = parser.add_subparsers(dest="command", required=True)

    extract_parser = subcommands.add_parser("extract", help="write chunk files of Chinese text units")
    extract_parser.add_argument("--chunk-chars", type=positive_int, required=True, help="max characters per chunk")
    extract_parser.add_argument("--out-dir", type=Path, required=True, help="directory for chunk and manifest files")
    extract_parser.add_argument("worlds", type=Path, nargs="+", help="world directories")
    extract_parser.set_defaults(run=run_extract)

    apply_parser = subcommands.add_parser("apply", help="replace Chinese text units with translations")
    apply_parser.add_argument("--translations-dir", type=Path, required=True, help="directory holding manifest and translations")
    apply_parser.add_argument("worlds", type=Path, nargs="+", help="world directories")
    apply_parser.set_defaults(run=run_apply)

    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        args.run(args)
    except TranslateFailure as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
