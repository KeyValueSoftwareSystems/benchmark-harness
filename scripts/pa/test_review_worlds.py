"""Tests for review_worlds.py. Run with a Python that has pyarrow and pyyaml installed."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import review_worlds as reviewer  # noqa: E402
from review_worlds import FindingKind, Severity  # noqa: E402

WORLD_ID = "demo_world"
BUCKET = "work"
PERSONA_NAME = "Carlos Rivera"
PERSONA_EMAIL = "carlos.rivera@carlosdesigns.example"
GMAIL_PORT = 9100
CRM_PORT = 9110
GMAIL_TOOL = "gmail_list_messages"
GMAIL_URL = f"http://localhost:{GMAIL_PORT}/gmail/messages"
CRM_TOOL = "crm_get_customer"
CRM_URL = f"http://localhost:{CRM_PORT}/crm/get"
REFERENCE_SOLUTION = "First triage the urgent vendor invoice then reply to the client about the revised delivery window"
JUDGE_RUBRICS = "The agent must flag the overdue invoice from the supplier before anything else"
AGENT_FIXTURE_TEXT = "Hello team, the weekly shelter report is attached for your review. Thanks."

GMAIL_FIXTURE = [{"id": "m1", "subject": "Weekly report", "from": "ops@studio.example"}]
CRM_FIXTURE = [{"id": "c1", "name": "Acme Client"}]


def clean_spec() -> dict[str, Any]:
    """A world description that produces no findings."""
    return {
        "world": {
            "prompt": {"text": "Triage my inbox and draft replies.", "language": "en"},
            "execution_date": "2026-04-05",
            "tools": [{"name": GMAIL_TOOL}, {"name": CRM_TOOL}],
            "tool_endpoints": [
                {"tool_name": GMAIL_TOOL, "url": GMAIL_URL, "method": "POST"},
                {"tool_name": CRM_TOOL, "url": CRM_URL, "method": "POST"},
            ],
            "services": [{"name": "gmail", "port": GMAIL_PORT}, {"name": "crm", "port": CRM_PORT}],
        },
        "grading": {
            "scoring_components": [
                {"name": "Read inbox", "weight": 1.0, "check": {"type": "tool_called", "tool_name": GMAIL_TOOL}}
            ],
            "safety_checks": [{"type": "tool_not_called", "tool_name": CRM_TOOL}],
            "expected_actions": [{"service": "gmail", "action_key": GMAIL_TOOL, "required": True}],
            "judge_rubric": JUDGE_RUBRICS,
            "reference_solution": REFERENCE_SOLUTION,
        },
        "persona": {
            "name": PERSONA_NAME,
            "email": PERSONA_EMAIL,
            "organization": "Carlos Designs",
            "role": "Freelance Designer",
            "communication_style": "direct, detail-oriented",
        },
        "files": {
            "agent/fixtures/gmail/inbox.json": GMAIL_FIXTURE,
            "agent/fixtures/crm/customers.json": CRM_FIXTURE,
            "agent/logs/work_journal.md": AGENT_FIXTURE_TEXT,
        },
    }


def write_world(root: Path, spec: dict[str, Any]) -> Path:
    world_dir = root / WORLD_ID
    world_dir.mkdir(parents=True)
    (world_dir / "world.yaml").write_text(yaml.safe_dump(spec["world"]))
    (world_dir / "grading.yaml").write_text(yaml.safe_dump(spec["grading"]))
    (world_dir / "agent").mkdir()
    (world_dir / "agent" / "persona.json").write_text(json.dumps(spec["persona"]))
    for relative_path, content in spec["files"].items():
        destination = world_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        text = content if isinstance(content, str) else json.dumps(content)
        destination.write_text(text)
    return world_dir


class ReviewWorldsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self._temp_dir.name)

    def tearDown(self) -> None:
        self._temp_dir.cleanup()

    def review(self, spec: dict[str, Any]) -> list[reviewer.Finding]:
        world = reviewer.load_world(write_world(self.root, spec), WORLD_ID, BUCKET)
        return reviewer.review_world(world)

    def assert_flags(self, spec: dict[str, Any], kind: FindingKind) -> list[reviewer.Finding]:
        findings = self.review(spec)
        matching = [finding for finding in findings if finding.kind is kind]
        self.assertTrue(matching, f"expected a {kind.value} finding, got {findings}")
        return matching

    def test_clean_world_has_no_findings(self) -> None:
        self.assertEqual(self.review(clean_spec()), [])

    def test_empty_grading_field(self) -> None:
        spec = clean_spec()
        spec["grading"]["judge_rubric"] = "   "
        findings = self.assert_flags(spec, FindingKind.EMPTY_GRADING_FIELD)
        self.assertEqual(findings[0].severity, Severity.ERROR)

    def test_tool_called_not_in_world_is_an_error(self) -> None:
        spec = clean_spec()
        spec["grading"]["scoring_components"][0]["check"]["tool_name"] = "crm_ghost"
        findings = self.assert_flags(spec, FindingKind.TOOL_NOT_IN_WORLD)
        self.assertEqual(findings[0].severity, Severity.ERROR)
        self.assertIn("crm_ghost", findings[0].message)

    def test_tool_not_called_not_in_world_is_a_warning(self) -> None:
        spec = clean_spec()
        spec["grading"]["safety_checks"] = [{"type": "tool_not_called", "tool_name": "crm_ghost"}]
        findings = self.review(spec)
        self.assertEqual([finding.kind for finding in findings], [FindingKind.UNAVAILABLE_TOOL_RULE])
        self.assertEqual(findings[0].severity, Severity.WARN)

    def test_expected_actions_with_unknown_tool_are_not_checked(self) -> None:
        spec = clean_spec()
        spec["grading"]["expected_actions"].append({"service": "crm", "action_key": "crm_ghost", "required": False})
        self.assertEqual(self.review(spec), [])

    def test_endpoint_without_tool_entry(self) -> None:
        spec = clean_spec()
        spec["world"]["tool_endpoints"] = spec["world"]["tool_endpoints"][:1]
        self.assert_flags(spec, FindingKind.ENDPOINT_PROBLEM)

    def test_endpoint_port_not_a_service_port(self) -> None:
        spec = clean_spec()
        spec["world"]["tool_endpoints"][0]["url"] = "http://localhost:9999/gmail/messages"
        self.assert_flags(spec, FindingKind.ENDPOINT_PROBLEM)

    def test_two_services_on_one_port(self) -> None:
        spec = clean_spec()
        spec["world"]["services"][1]["port"] = GMAIL_PORT
        self.assert_flags(spec, FindingKind.ENDPOINT_PROBLEM)

    def test_service_without_fixture(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/fixtures/crm/customers.json"] = []
        findings = self.assert_flags(spec, FindingKind.SERVICE_WITHOUT_FIXTURE)
        self.assertEqual(findings[0].severity, Severity.WARN)
        self.assertIn("crm", findings[0].message)

    def test_cjk_left(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/logs/work_journal.md"] = "会议 notes for the team"
        findings = self.assert_flags(spec, FindingKind.CJK_LEFT)
        self.assertEqual(findings[0].file, "agent/logs/work_journal.md")

    def test_real_domain_left(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/logs/work_journal.md"] = "Forward it to jane@acme.com today."
        findings = self.assert_flags(spec, FindingKind.REAL_DOMAIN_LEFT)
        self.assertIn("jane@acme.com", findings[0].message)

    def test_answer_leak(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/logs/work_journal.md"] = (
            "Notes: first triage the urgent vendor invoice then reply to the client about the revised delivery window"
        )
        findings = self.assert_flags(spec, FindingKind.ANSWER_LEAK)
        self.assertEqual(findings[0].severity, Severity.WARN)
        self.assertLessEqual(len(findings[0].snippet or ""), reviewer.SNIPPET_CHARS)

    def test_meta_leak_in_list_fixture(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/fixtures/gmail/inbox.json"] = [
            {"id": "m1", "subject": "Weekly report", "body": "Note: this is the hidden conflict to find."}
        ]
        findings = self.assert_flags(spec, FindingKind.META_LEAK)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, Severity.WARN)
        self.assertEqual(findings[0].file, "agent/fixtures/gmail/inbox.json")
        self.assertEqual(findings[0].item_id, "m1")
        self.assertEqual(findings[0].snippet, "Weekly report")
        self.assertEqual(findings[0].message, "hidden conflict")

    def test_meta_leak_in_single_list_dict_fixture(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/fixtures/crm/customers.json"] = {
            "pages": [{"page_id": "p9", "page_title": "Ground Truth notes", "body": "Plain text."}]
        }
        findings = self.assert_flags(spec, FindingKind.META_LEAK)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].item_id, "p9")
        self.assertEqual(findings[0].snippet, "Ground Truth notes")
        self.assertEqual(findings[0].message, "ground truth")

    def test_meta_leak_title_is_truncated(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/fixtures/gmail/inbox.json"] = [
            {"id": "m1", "subject": "x" * (reviewer.MAX_TITLE_CHARS + 20), "body": "Expected answer: archive it."}
        ]
        findings = self.assert_flags(spec, FindingKind.META_LEAK)
        self.assertEqual(len(findings[0].snippet or ""), reviewer.MAX_TITLE_CHARS)

    def test_meta_leak_findings_print_one_line_each(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/fixtures/gmail/inbox.json"] = [
            {"id": "m1", "subject": "Weekly report", "body": "Judge rubric: reply first."}
        ]
        report = reviewer.WorldReport(WORLD_ID, BUCKET, 1.0, self.review(spec))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            reviewer.print_meta_leaks([report])
        self.assertEqual(
            output.getvalue().splitlines(),
            [
                "meta_leak: world | file | item id | title | pattern",
                f"{WORLD_ID} | agent/fixtures/gmail/inbox.json | m1 | Weekly report | judge rubric",
            ],
        )

    def test_item_created_after_execution_date_is_flagged(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/fixtures/notes/notes.json"] = [
            {"note_id": "NOTE-7", "title": "Later memo", "created_at": "2026-04-06T08:00:00+03:00"}
        ]
        findings = self.assert_flags(spec, FindingKind.FUTURE_DATED_ITEM)
        self.assertEqual(findings[0].severity, Severity.ERROR)
        self.assertEqual(findings[0].file, "agent/fixtures/notes/notes.json")
        self.assertEqual(findings[0].item_id, "NOTE-7")
        self.assertEqual(findings[0].message, "created 2026-04-06T08:00:00, after the execution date")

    def test_item_created_late_on_execution_date_is_not_flagged(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/fixtures/notes/notes.json"] = [{"note_id": "NOTE-8", "created_at": "2026-04-05T23:59:59"}]
        self.assertEqual(self.review(spec), [])

    def test_calendar_event_in_the_future_is_not_flagged(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/fixtures/calendar/events.json"] = [{"event_id": "E1", "start_time": "2026-09-01T10:00:00"}]
        self.assertEqual(self.review(spec), [])

    def test_future_check_is_skipped_without_execution_date(self) -> None:
        spec = clean_spec()
        del spec["world"]["execution_date"]
        spec["files"]["agent/fixtures/notes/notes.json"] = [{"note_id": "NOTE-9", "created_at": "2030-01-01"}]
        self.assertEqual(reviewer.check_future_dated_items(self.load(spec)), [])

    def load(self, spec: dict[str, Any]) -> reviewer.World:
        return reviewer.load_world(write_world(self.root, spec), WORLD_ID, BUCKET)

    def test_dangling_reference(self) -> None:
        spec = clean_spec()
        spec["world"]["prompt"]["text"] = "Check ticket ZX-9001 before replying."
        findings = self.assert_flags(spec, FindingKind.DANGLING_REFERENCE)
        self.assertIn("ZX-9001", findings[0].message)

    def test_persona_problem(self) -> None:
        spec = clean_spec()
        spec["persona"]["organization"] = "gmail"
        findings = self.assert_flags(spec, FindingKind.PERSONA_PROBLEM)
        self.assertIn("mail provider", findings[0].message)

    def test_persona_name_equal_to_email_local_part(self) -> None:
        spec = clean_spec()
        spec["persona"]["name"] = "carlos.rivera"
        findings = self.assert_flags(spec, FindingKind.PERSONA_PROBLEM)
        self.assertIn("local part", findings[0].message)

    def test_persona_organization_is_an_email_address(self) -> None:
        spec = clean_spec()
        spec["persona"]["organization"] = "studio@carlosdesigns.example"
        findings = self.assert_flags(spec, FindingKind.PERSONA_PROBLEM)
        self.assertIn("contains an email address", findings[0].message)

    def test_persona_organization_equal_to_email(self) -> None:
        spec = clean_spec()
        spec["persona"]["organization"] = PERSONA_EMAIL.upper()
        findings = self.assert_flags(spec, FindingKind.PERSONA_PROBLEM)
        self.assertEqual(findings[0].message, "organization equals the email address")

    def test_persona_organization_too_long(self) -> None:
        spec = clean_spec()
        spec["persona"]["organization"] = "A" * (reviewer.MAX_ORGANIZATION_CHARS + 1)
        findings = self.assert_flags(spec, FindingKind.PERSONA_PROBLEM)
        self.assertIn("longer than", findings[0].message)

    def test_persona_placeholder_organization(self) -> None:
        spec = clean_spec()
        spec["persona"]["organization"] = "Self-Employed"
        findings = self.assert_flags(spec, FindingKind.PERSONA_PROBLEM)
        self.assertIn("placeholder", findings[0].message)

    def test_persona_role_equal_to_email(self) -> None:
        spec = clean_spec()
        spec["persona"]["role"] = PERSONA_EMAIL
        findings = self.assert_flags(spec, FindingKind.PERSONA_PROBLEM)
        self.assertEqual(findings[0].message, "role equals the email address")

    def test_prompt_problem(self) -> None:
        spec = clean_spec()
        spec["world"]["prompt"]["language"] = "fr"
        findings = self.assert_flags(spec, FindingKind.PROMPT_PROBLEM)
        self.assertEqual(findings[0].severity, Severity.ERROR)

    def test_size_warning(self) -> None:
        spec = clean_spec()
        spec["files"]["agent/logs/big.md"] = "word " * (reviewer.MAX_WORLD_BYTES // len("word ") + 1)
        findings = self.assert_flags(spec, FindingKind.SIZE_WARNING)
        self.assertEqual(findings[0].severity, Severity.WARN)

    def test_missing_world_directory_is_a_review_failure(self) -> None:
        with self.assertRaises(reviewer.ReviewFailure):
            reviewer.load_world(self.root / "missing", WORLD_ID, BUCKET)


if __name__ == "__main__":
    unittest.main()
