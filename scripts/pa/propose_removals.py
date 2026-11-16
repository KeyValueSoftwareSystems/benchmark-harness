#!/usr/bin/env python3
"""Propose removing authored analysis notes that leak the solution into PA worlds.

Checks the notes, Notion pages and Obsidian notes of each world in a selection manifest. An item is
proposed for removal when its id has an authored-note prefix, its text matches a META_LEAK_PATTERNS
entry from review_worlds, and it was created on the execution date or up to --days-before days before it.
Writes the proposals as JSON for review and never modifies worlds.

Usage:
    python scripts/pa/propose_removals.py --manifest FILE [--worlds-dir DIR] [--days-before N] --output FILE.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_claw_anything import ISO_DAY_LENGTH, creation_time  # noqa: E402
from review_worlds import (  # noqa: E402
    AGENT_PREFIX,
    DEFAULT_WORLDS_DIR,
    REPO_ROOT,
    ReviewFailure,
    World,
    fixture_item_id,
    fixture_item_title,
    fixture_items,
    format_table,
    load_manifest_entries,
    load_world,
    matched_meta_leak_pattern,
)


RESOURCES_DIR = REPO_ROOT / "resources"
DEFAULT_DAYS_BEFORE = 3
EXECUTION_DATE_KEY = "execution_date"
REASON = "Authored analysis note that reads like a solution, created on or shortly before the execution date."

AUTHORED_NOTE_FILES = (
    "fixtures/notes/notes.json",
    "fixtures/claw_notion/pages.json",
    "fixtures/claw_obsidian/vault.json",
)
AUTHORED_NOTE_ID_PREFIXES = ("NOTE-", "NPAG-", "OBSN-")


class ProposalFailure(Exception):
    """A problem with the arguments that stops the proposal run."""


@dataclass(frozen=True)
class RemovalProposal:
    world_id: str
    file: str
    item_id: str
    title: str
    created_at: str

    def to_json(self) -> dict[str, str]:
        return {
            "worldId": self.world_id,
            "file": self.file,
            "id": self.item_id,
            "title": self.title,
            "createdAt": self.created_at,
            "reason": REASON,
        }


# ---------------------------------------------------------------------------
# Proposing removals
# ---------------------------------------------------------------------------

def execution_day(world: World) -> date:
    try:
        return date.fromisoformat(world.world_yaml.get(EXECUTION_DATE_KEY))
    except (TypeError, ValueError) as error:
        raise ReviewFailure(f"{world.world_id}: {EXECUTION_DATE_KEY} must be a YYYY-MM-DD date") from error


def is_within_days_before(created: str, execution_day: date, days_before: int) -> bool:
    """True when `created` is on the execution date or up to `days_before` whole days before it."""
    earliest_day = (execution_day - timedelta(days=days_before)).isoformat()
    return earliest_day <= created[:ISO_DAY_LENGTH] <= execution_day.isoformat()


def is_solution_artifact(item: dict, item_id: str) -> bool:
    return item_id.startswith(AUTHORED_NOTE_ID_PREFIXES) and matched_meta_leak_pattern(item) is not None


def propose_for_world(world: World, days_before: int) -> list[RemovalProposal]:
    day = execution_day(world)
    return [
        proposal
        for file in AUTHORED_NOTE_FILES
        for proposal in _proposals_in_file(world, file, day, days_before)
    ]


def _proposals_in_file(world: World, file: str, day: date, days_before: int) -> list[RemovalProposal]:
    service = PurePosixPath(file).parts[1]
    proposals = []
    for item in fixture_items(world.texts.get(AGENT_PREFIX + file, "")):
        created = creation_time(item, service)
        item_id = fixture_item_id(item)
        if created is None or item_id is None or not is_solution_artifact(item, item_id):
            continue
        if is_within_days_before(created, day, days_before):
            proposals.append(RemovalProposal(world.world_id, file, item_id, fixture_item_title(item), created))
    return proposals


def build_proposals(manifest_path: Path, worlds_dir: Path, days_before: int) -> list[RemovalProposal]:
    proposals = []
    for world_id, bucket in load_manifest_entries(manifest_path):
        world = load_world(worlds_dir / world_id, world_id, bucket)
        proposals += propose_for_world(world, days_before)
    return proposals


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def check_output_path(output: Path) -> None:
    if RESOURCES_DIR.resolve() in output.resolve().parents:
        raise ProposalFailure(f"--output must not be inside {RESOURCES_DIR}")


def print_proposals(proposals: Sequence[RemovalProposal]) -> None:
    rows = [[p.world_id, p.file, p.item_id, p.created_at, p.title] for p in proposals]
    print(format_table(["world", "file", "id", "createdAt", "title"], rows))
    print(f"{len(proposals)} removal(s) proposed")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def non_negative_int(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError(f"must be 0 or more, got {value}")
    return number


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Propose removing solution-leaking authored notes. Never modifies worlds.")
    parser.add_argument("--manifest", type=Path, required=True, help="Selection manifest listing the worlds to check")
    parser.add_argument("--worlds-dir", type=Path, default=DEFAULT_WORLDS_DIR, help="Directory holding the world folders")
    parser.add_argument(
        "--days-before",
        type=non_negative_int,
        default=DEFAULT_DAYS_BEFORE,
        help="Check items created on the execution date or up to this many whole days before it (default: %(default)s)",
    )
    parser.add_argument("--output", type=Path, required=True, help="Write the proposals as JSON to this file")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        check_output_path(args.output)
        proposals = build_proposals(args.manifest, args.worlds_dir, args.days_before)
    except (ProposalFailure, ReviewFailure) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print_proposals(proposals)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps([proposal.to_json() for proposal in proposals], indent=2))
    print(f"\nWrote proposals to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
