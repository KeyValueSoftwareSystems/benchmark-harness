"""Tests for propose_removals.py. Run with a Python that has pyarrow and pyyaml installed."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import propose_removals as proposer  # noqa: E402
from review_worlds import ReviewFailure, load_world  # noqa: E402

EXECUTION_DATE = "2026-04-05"
EXECUTION_DAY = date(2026, 4, 5)
BUCKET = "work"
LEAKY_TEXT = "Hidden conflict: the venue is double-booked on Friday."
PLAIN_TEXT = "Weekly planning notes for the team."
NOTES_FILE = "fixtures/notes/notes.json"
NOTION_FILE = "fixtures/claw_notion/pages.json"
OBSIDIAN_FILE = "fixtures/claw_obsidian/vault.json"


def write_world(root: Path, world_id: str, fixtures: dict[str, Any], execution_date: str = EXECUTION_DATE) -> Path:
    world_dir = root / world_id
    agent_dir = world_dir / "agent"
    agent_dir.mkdir(parents=True)
    (world_dir / "world.yaml").write_text(yaml.safe_dump({"execution_date": execution_date}))
    for relative_path, data in fixtures.items():
        destination = agent_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(data, indent=2))
    return world_dir


def write_manifest(root: Path, world_ids: list[str]) -> Path:
    manifest = root / "manifest.json"
    manifest.write_text(json.dumps({"tasks": [{"worldId": world_id, "bucket": BUCKET} for world_id in world_ids]}))
    return manifest


def note(note_id: str, created_at: str, content: str = LEAKY_TEXT) -> dict[str, str]:
    return {"note_id": note_id, "title": f"Title of {note_id}", "created_at": created_at, "content": content}


class ProposeRemovalsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def propose(self, fixtures: dict[str, Any], days_before: int = 3) -> list[proposer.RemovalProposal]:
        world_dir = write_world(self.root, "world_a", fixtures)
        world = load_world(world_dir, "world_a", BUCKET)
        return proposer.propose_for_world(world, days_before)

    def test_proposes_leaky_authored_note_created_shortly_before_the_execution_date(self) -> None:
        proposals = self.propose({NOTES_FILE: [note("NOTE-1", "2026-04-04T10:00:00")]})

        self.assertEqual(
            proposals,
            [proposer.RemovalProposal("world_a", NOTES_FILE, "NOTE-1", "Title of NOTE-1", "2026-04-04T10:00:00")],
        )

    def test_skips_items_outside_the_window_or_after_the_execution_date(self) -> None:
        proposals = self.propose(
            {
                NOTES_FILE: [
                    note("NOTE-2", "2026-03-01T10:00:00"),
                    note("NOTE-3", "2026-04-06T00:00:00"),
                ]
            }
        )

        self.assertEqual(proposals, [])

    def test_skips_ids_without_an_authored_prefix(self) -> None:
        proposals = self.propose({NOTES_FILE: [note("TASK-4", "2026-04-04T10:00:00")]})

        self.assertEqual(proposals, [])

    def test_skips_authored_notes_without_leak_wording(self) -> None:
        proposals = self.propose({NOTES_FILE: [note("NOTE-5", "2026-04-04T10:00:00", PLAIN_TEXT)]})

        self.assertEqual(proposals, [])

    def test_only_checks_the_three_authored_note_files(self) -> None:
        proposals = self.propose(
            {
                "fixtures/todo/tasks.json": [{"task_id": "NOTE-6", "created_at": "2026-04-04T10:00:00", "description": LEAKY_TEXT}],
            }
        )

        self.assertEqual(proposals, [])

    def test_checks_notion_and_obsidian_prefixes_and_fields(self) -> None:
        proposals = self.propose(
            {
                NOTION_FILE: [
                    {"page_id": "NPAG-1", "title": "Decision page", "created_at": "2026-04-03T08:00:00", "blocks": [LEAKY_TEXT]}
                ],
                OBSIDIAN_FILE: [
                    {"note_id": "OBSN-1", "title": "Vault note", "created_at": "2026-04-02T08:00:00", "content": LEAKY_TEXT}
                ],
            }
        )

        self.assertEqual(
            [(p.file, p.item_id, p.title, p.created_at) for p in proposals],
            [
                (NOTION_FILE, "NPAG-1", "Decision page", "2026-04-03T08:00:00"),
                (OBSIDIAN_FILE, "OBSN-1", "Vault note", "2026-04-02T08:00:00"),
            ],
        )

    def test_days_before_zero_checks_only_the_execution_date_itself(self) -> None:
        proposals = self.propose(
            {
                NOTES_FILE: [
                    note("NOTE-7", "2026-04-04T23:59:59"),
                    note("NOTE-8", "2026-04-05T08:00:00"),
                    note("NOTE-9", "2026-04-05T23:59:59"),
                    note("NOTE-12", "2026-04-06T00:00:00"),
                ]
            },
            days_before=0,
        )

        self.assertEqual([p.item_id for p in proposals], ["NOTE-8", "NOTE-9"])

    def test_window_starts_at_midnight_the_given_number_of_days_before(self) -> None:
        proposals = self.propose(
            {
                NOTES_FILE: [
                    note("NOTE-10", "2026-04-02T00:00:00"),
                    note("NOTE-11", "2026-04-01T23:59:59"),
                ]
            },
            days_before=3,
        )

        self.assertEqual([p.item_id for p in proposals], ["NOTE-10"])

    def test_missing_execution_date_is_a_review_failure(self) -> None:
        world_dir = write_world(self.root, "world_a", {NOTES_FILE: []}, execution_date="soon")
        world = load_world(world_dir, "world_a", BUCKET)

        with self.assertRaises(ReviewFailure):
            proposer.propose_for_world(world, 3)

    def test_is_within_days_before_uses_naive_wall_clock_times(self) -> None:
        self.assertTrue(proposer.is_within_days_before("2026-04-02T00:00:00", EXECUTION_DAY, 3))
        self.assertTrue(proposer.is_within_days_before("2026-04-05T23:00:00", EXECUTION_DAY, 3))
        self.assertFalse(proposer.is_within_days_before("2026-04-01T12:00:00", EXECUTION_DAY, 3))
        self.assertFalse(proposer.is_within_days_before("2026-04-06T00:00:00", EXECUTION_DAY, 3))


class ProposeRemovalsCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.worlds_dir = self.root / "worlds"
        self.world_dir = write_world(self.worlds_dir, "world_a", {NOTES_FILE: [note("NOTE-1", "2026-04-04T10:00:00")]})
        self.manifest = write_manifest(self.root, ["world_a"])

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_cli(self, output: Path) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        argv = ["--manifest", str(self.manifest), "--worlds-dir", str(self.worlds_dir), "--output", str(output)]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = proposer.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_writes_json_proposals_with_fixed_reason(self) -> None:
        output = self.root / "out" / "removals.json"

        code, stdout, _ = self.run_cli(output)

        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(output.read_text()),
            [
                {
                    "worldId": "world_a",
                    "file": NOTES_FILE,
                    "id": "NOTE-1",
                    "title": "Title of NOTE-1",
                    "createdAt": "2026-04-04T10:00:00",
                    "reason": proposer.REASON,
                }
            ],
        )
        self.assertIn("NOTE-1", stdout)

    def test_does_not_modify_the_worlds(self) -> None:
        notes = self.world_dir / "agent" / NOTES_FILE
        before = notes.read_bytes()

        self.run_cli(self.root / "removals.json")

        self.assertEqual(notes.read_bytes(), before)

    def test_refuses_output_inside_resources(self) -> None:
        output = proposer.RESOURCES_DIR / "pa" / "removals.json"

        code, _, stderr = self.run_cli(output)

        self.assertEqual(code, 1)
        self.assertIn("must not be inside", stderr)
        self.assertFalse(output.exists())

    def test_rejects_negative_days_before(self) -> None:
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            proposer.parse_args(["--manifest", "m.json", "--output", "o.json", "--days-before", "-1"])


if __name__ == "__main__":
    unittest.main()
