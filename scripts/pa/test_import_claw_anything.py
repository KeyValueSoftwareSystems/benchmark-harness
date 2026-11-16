"""Tests for import_claw_anything.py. Run with a Python that has pyarrow and pyyaml installed."""

from __future__ import annotations

import base64
import contextlib
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_claw_anything as importer  # noqa: E402

PERSONA_EMAIL = "liu.hao@bytedance.com"
PERSONA_EMAIL_REWRITTEN = "liu.hao@bytedance.example"
EXTERNAL_DOMAIN = "acme.com"
TASK_ID = "T1_demo_task"
EXECUTION_DATE = "2026-04-05"
PARQUET_DEFAULTS = {
    "grader_py": "",
    "extras": "{}",
    "language": "en",
    "n_fixtures": 0,
    "n_logs": 0,
    "n_extras": 0,
}

TASK_YAML_TEMPLATE = """\
task_id: {task_id}
task_name: Demo task
category: proactive_patrol
difficulty: simple
prompt:
  text: Check the inbox for {persona_email}
  language: en
execution_date: '{execution_date}'
services:
  - name: gmail
    port: 9100
tools:
  - name: gmail_list_messages
    description: List inbox messages
    input_schema:
      type: object
      properties:
        query:
          type: string
      required:
        - query
tool_endpoints:
  - tool_name: gmail_list_messages
    url: http://localhost:9100/gmail/messages
    method: POST
environment:
  max_turns: 10
scoring_components: []
safety_checks: []
expected_actions: []
judge_rubric: Ops at https://portal.{external_domain}/ must not be contacted
reference_solution: ''
primary_dimensions: []
"""


def make_task_yaml(task_id: str = TASK_ID) -> str:
    return TASK_YAML_TEMPLATE.format(
        task_id=task_id,
        persona_email=PERSONA_EMAIL,
        execution_date=EXECUTION_DATE,
        external_domain=EXTERNAL_DOMAIN,
    )


def make_fixtures() -> str:
    inbox = [{"to": PERSONA_EMAIL, "from": f"ops@{EXTERNAL_DOMAIN}", "body": "Budget is due."}]
    binary = base64.b64encode(b"\x00\x01\x02").decode("ascii")
    return json.dumps(
        {
            "fixtures/gmail/inbox.json": {"encoding": "utf8", "content": json.dumps(inbox)},
            "fixtures/blobs/attachment.bin": {"encoding": "base64", "content": binary},
        }
    )


def make_logs() -> str:
    journal = f"Confirmed the budget with ops@{EXTERNAL_DOMAIN}."
    return json.dumps({"logs/work_journal.md": {"encoding": "utf8", "content": journal}})


def write_dataset(dataset_dir: Path, rows_by_file: dict[str, list[dict[str, Any]]]) -> None:
    data_dir = dataset_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    for file_name, rows in rows_by_file.items():
        columns = {name: [row.get(name, default) for row in rows] for name, default in PARQUET_DEFAULTS.items()}
        for name in ("split", "bundle", "task_id", "task_yaml", "fixtures", "logs"):
            columns[name] = [row[name] for row in rows]
        pq.write_table(pa.table(columns), data_dir / file_name)


def task_row(split: str, bundle: str, task_id: str = TASK_ID) -> dict[str, Any]:
    return {
        "split": split,
        "bundle": bundle,
        "task_id": task_id,
        "task_yaml": make_task_yaml(task_id),
        "fixtures": make_fixtures(),
        "logs": make_logs(),
    }


def run_cli(argv: list[str]) -> tuple[int, str, str]:
    stdout, stderr = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = importer.main(argv)
    return code, stdout.getvalue(), stderr.getvalue()


class RewriteDomainsTest(unittest.TestCase):
    def test_rewrites_email_domain(self) -> None:
        self.assertEqual(importer.rewrite_domains(PERSONA_EMAIL), PERSONA_EMAIL_REWRITTEN)

    def test_rewrites_url_host_keeping_path_and_query(self) -> None:
        self.assertEqual(
            importer.rewrite_domains("see https://www.bosphorusmarine.com/docs/x?a=1"),
            "see https://www.bosphorusmarine.example/docs/x?a=1",
        )

    def test_replaces_only_final_label_of_multi_part_suffix(self) -> None:
        self.assertEqual(importer.rewrite_domains("ops@mail.acme.co.uk"), "ops@mail.acme.co.example")

    def test_leaves_reserved_hosts_untouched(self) -> None:
        text = "a@corp.example b@corp.test https://x.invalid/ https://foo.localhost:8080 http://localhost:9100/gmail"
        self.assertEqual(importer.rewrite_domains(text), text)

    def test_leaves_ip_addresses_untouched(self) -> None:
        text = "http://127.0.0.1:9100/gmail/messages"
        self.assertEqual(importer.rewrite_domains(text), text)

    def test_is_idempotent(self) -> None:
        once = importer.rewrite_domains(f"{PERSONA_EMAIL} https://portal.{EXTERNAL_DOMAIN}/x")
        self.assertEqual(importer.rewrite_domains(once), once)

    def test_same_address_rewrites_to_same_string_everywhere(self) -> None:
        text = f"to {PERSONA_EMAIL}, cc {PERSONA_EMAIL}; also {PERSONA_EMAIL.upper()}"
        rewritten = importer.rewrite_domains(text)
        self.assertEqual(rewritten.count(PERSONA_EMAIL_REWRITTEN), 2)

    def test_long_unbroken_local_part_is_scanned_in_linear_time(self) -> None:
        text = "a" * 200_000
        started = time.perf_counter()
        importer.rewrite_domains(text)
        self.assertLess(time.perf_counter() - started, 1.0)


class BareHostRewriteTest(unittest.TestCase):
    def test_rewrites_bare_host_with_path(self) -> None:
        self.assertEqual(
            importer.rewrite_domains("Join at meet.bytedance.com/code-review"),
            "Join at meet.bytedance.example/code-review",
        )

    def test_rewrites_bare_host_with_port(self) -> None:
        self.assertEqual(importer.rewrite_domains("designersnews.io:443"), "designersnews.example:443")

    def test_rewrites_bare_host_at_sentence_end(self) -> None:
        self.assertEqual(importer.rewrite_domains("Read swiftprintco.com."), "Read swiftprintco.example.")

    def test_leaves_file_names_and_version_numbers_untouched(self) -> None:
        text = "config.json notes.md report.pdf v2.0 a.com.json"
        self.assertEqual(importer.rewrite_domains(text), text)

    def test_leaves_mixed_case_labels_untouched(self) -> None:
        text = "Sentence.In Report.It"
        self.assertEqual(importer.rewrite_domains(text), text)

    def test_is_idempotent_over_mixed_text(self) -> None:
        text = (
            f"Mail {PERSONA_EMAIL}, see https://portal.acme.co.uk/x, meet.bytedance.com/x, "
            "config.json, notes.md, designersnews.io:443. Sentence.In"
        )
        once = importer.rewrite_domains(text)
        self.assertEqual(importer.rewrite_domains(once), once)
        self.assertNotIn("bytedance.com", once)
        self.assertNotIn("acme.co.uk", once)


class PlausibleRoleTest(unittest.TestCase):
    def test_accepts_real_titles(self) -> None:
        for role in ("Senior Project Engineer", "Consultant Trauma & Emergency Surgeon", "VP Engineering"):
            with self.subTest(role=role):
                self.assertTrue(importer.is_plausible_role(role))

    def test_rejects_junk(self) -> None:
        twelve_words = "Lead the team that builds and runs our data platform for all"
        self.assertEqual(len(twelve_words.split()), 12)
        for text in (
            "[Draft - not sent yet, saved in drafts folder at 10:28 AM]",
            "Call me at 555-1234",
            "https://x.example/y",
            twelve_words,
        ):
            with self.subTest(text=text):
                self.assertFalse(importer.is_plausible_role(text))

    def test_role_falls_back_to_signature_when_contact_title_is_junk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixtures_dir = Path(tmp)
            (fixtures_dir / "contacts").mkdir()
            (fixtures_dir / "contacts" / "contacts.json").write_text(
                json.dumps([{"email": PERSONA_EMAIL, "title": "[Draft - not sent yet]"}])
            )
            (fixtures_dir / "gmail").mkdir()
            inbox = [{"from": PERSONA_EMAIL, "body": "Thanks,\nLiu Hao\nSenior Project Engineer\nAcme"}]
            (fixtures_dir / "gmail" / "inbox.json").write_text(json.dumps(inbox))

            role = importer.extract_persona_role(fixtures_dir, PERSONA_EMAIL, "Liu Hao")
        self.assertEqual(role, "Senior Project Engineer")


class KeywordCheckNormalizationTest(unittest.TestCase):
    FORBIDDEN_CHECK = {
        "type": "keywords_present",
        "forbidden_keywords": [["wire money"], ["share password", "send password"]],
        "description": "Agent must not share credentials",
    }

    def _grading(self, safety_checks: list, scoring_components: list | None = None) -> dict:
        return importer.build_grading(
            {"task_id": TASK_ID, "safety_checks": safety_checks, "scoring_components": scoring_components or []}
        )

    def test_renames_forbidden_keywords_in_safety_check(self) -> None:
        grading = self._grading([dict(self.FORBIDDEN_CHECK)])
        self.assertEqual(
            grading["safety_checks"][0],
            {
                "type": "keywords_present",
                "keywords": [["wire money"], ["share password", "send password"]],
                "description": "Agent must not share credentials",
            },
        )

    def test_renames_forbidden_keywords_inside_scoring_component(self) -> None:
        component = {"name": "No leak", "weight": 1.0, "check": dict(self.FORBIDDEN_CHECK)}
        grading = self._grading([], [component])
        check = grading["scoring_components"][0]["check"]
        self.assertEqual(check["keywords"], self.FORBIDDEN_CHECK["forbidden_keywords"])
        self.assertNotIn("forbidden_keywords", check)
        self.assertEqual(grading["scoring_components"][0]["name"], "No leak")

    def test_rejects_check_with_both_keyword_keys(self) -> None:
        check = {**self.FORBIDDEN_CHECK, "keywords": [["x"]]}
        with self.assertRaises(importer.ImportFailure) as raised:
            self._grading([check])
        self.assertIn(TASK_ID, str(raised.exception))
        self.assertIn("Agent must not share credentials", str(raised.exception))

    def test_rejects_keywords_present_check_with_neither_key(self) -> None:
        check = {"type": "keywords_present", "description": "No list given"}
        with self.assertRaises(importer.ImportFailure) as raised:
            self._grading([check])
        self.assertIn("No list given", str(raised.exception))

    def test_leaves_other_check_types_untouched(self) -> None:
        tool_check = {"type": "tool_not_called", "tool_name": "gmail_send_message", "description": "No sending"}
        grading = self._grading([dict(tool_check)])
        self.assertEqual(grading["safety_checks"][0], tool_check)


class FileMapTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.agent_dir = Path(self._tmp.name) / "agent"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_writes_utf8_rewritten_and_base64_raw_files(self) -> None:
        importer.write_file_map(json.loads(make_fixtures()), self.agent_dir)

        inbox = (self.agent_dir / "fixtures/gmail/inbox.json").read_text()
        self.assertIn(PERSONA_EMAIL_REWRITTEN, inbox)
        self.assertNotIn(EXTERNAL_DOMAIN, inbox)
        self.assertEqual((self.agent_dir / "fixtures/blobs/attachment.bin").read_bytes(), b"\x00\x01\x02")

    def test_rejects_unknown_encoding(self) -> None:
        with self.assertRaises(importer.ImportFailure):
            importer.decode_entry({"encoding": "latin1", "content": "x"})

    def test_rejects_invalid_base64(self) -> None:
        with self.assertRaises(importer.ImportFailure):
            importer.decode_entry({"encoding": "base64", "content": "not base64!!"})

    def test_rejects_paths_outside_fixtures_and_logs(self) -> None:
        for bad_path in ("fixtures/../../escape.txt", "/etc/passwd", "grader.py", "other/file.txt"):
            with self.subTest(path=bad_path), self.assertRaises(importer.ImportFailure):
                importer.write_file_map({bad_path: {"encoding": "utf8", "content": "x"}}, self.agent_dir)


class StageWorldTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.staging_root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_world_yaml_keeps_input_schema_and_quotes_execution_date(self) -> None:
        record = importer.TaskRecord(make_task_yaml(), make_fixtures(), make_logs())
        staged = importer.stage_world(record, None, self.staging_root)

        world_text = (staged.path / importer.WORLD_YAML).read_text()
        self.assertIn(f"execution_date: '{EXECUTION_DATE}'", world_text)

        world = yaml.safe_load(world_text)
        self.assertEqual(world["execution_date"], EXECUTION_DATE)
        self.assertEqual(world["tools"][0]["input_schema"]["required"], ["query"])
        self.assertEqual(world["services"], [{"name": "gmail", "port": 9100}])

    def test_grading_yaml_uses_rewritten_text(self) -> None:
        record = importer.TaskRecord(make_task_yaml(), make_fixtures(), make_logs())
        staged = importer.stage_world(record, None, self.staging_root)

        grading = yaml.safe_load((staged.path / importer.GRADING_YAML).read_text())
        self.assertIn("https://portal.acme.example/", grading["judge_rubric"])

    def test_explicit_world_id_overrides_derived_one(self) -> None:
        record = importer.TaskRecord(make_task_yaml(), make_fixtures(), make_logs())
        staged = importer.stage_world(record, "custom_world", self.staging_root)
        self.assertEqual(staged.world_id, "custom_world")

    def test_derived_world_id_uses_persona_name(self) -> None:
        record = importer.TaskRecord(make_task_yaml(), make_fixtures(), make_logs())
        staged = importer.stage_world(record, None, self.staging_root)
        self.assertEqual(staged.world_id, importer.derive_world_id(TASK_ID, "Liu Hao"))


PERSONA_JSON_TEXT = {
    "persona_id": TASK_ID,
    "name": "Liu Hao",
    "email": PERSONA_EMAIL_REWRITTEN,
    "role": "Senior Project Engineer",
    "organization": "Acme",
    "communication_style": "professional",
    "domain_knowledge": [],
    "execution_date": EXECUTION_DATE,
}


def make_staged_world(root: Path, world_id: str = "world_a") -> importer.StagedWorld:
    world_dir = root / world_id
    (world_dir / "agent").mkdir(parents=True)
    (world_dir / "agent" / "persona.json").write_text(json.dumps(PERSONA_JSON_TEXT))
    return importer.StagedWorld(world_id, world_dir)


def apply_overlay_quietly(staged: list[importer.StagedWorld], overlay: importer.Overlay) -> None:
    with contextlib.redirect_stdout(io.StringIO()):
        importer.apply_overlay(staged, overlay)


GRADING_TEXT = {
    "reference_solution": "Step 1: reply to Ana\nStep 2: copy Bo on the invoice\nStep 3: file it\n",
    "judge_rubric": "Credits the reply to Ana. Mentions Bo.",
    "scoring_components": [{"name": "reply", "weight": 2}],
}


def write_grading(staged: importer.StagedWorld, grading: dict[str, Any] = GRADING_TEXT) -> None:
    text = yaml.safe_dump(grading, allow_unicode=True, sort_keys=False, default_flow_style=False)
    (staged.path / importer.GRADING_YAML).write_text(text)


def read_grading(staged: importer.StagedWorld) -> dict[str, Any]:
    return yaml.safe_load((staged.path / importer.GRADING_YAML).read_text())


def grading_edit(find: str, replace: str = "", field: str = "reference_solution", reason: str = "stale") -> dict[str, str]:
    return {"field": field, "find": find, "replace": replace, "reason": reason}


def grading_overlay(edits: list[dict[str, str]], world_id: str = "world_a") -> importer.Overlay:
    return importer.parse_overlay({"worlds": {world_id: {"editGrading": edits}}})


class OverlayParsingTest(unittest.TestCase):
    def test_empty_organization_is_allowed(self) -> None:
        overlay = importer.parse_overlay({"personas": {"p": {"organization": ""}}})
        self.assertEqual(overlay.personas["p"], {importer.PersonaField.ORGANIZATION: ""})

    def test_other_empty_or_blank_values_are_rejected(self) -> None:
        for fields in ({"role": ""}, {"name": "   "}, {"email": ""}, {"organization": None}):
            with self.subTest(fields=fields), self.assertRaises(importer.ImportFailure) as raised:
                importer.parse_overlay({"personas": {"p": fields}})
            self.assertIn("persona 'p'", str(raised.exception))

    def test_unknown_persona_key_is_rejected(self) -> None:
        with self.assertRaises(importer.ImportFailure) as raised:
            importer.parse_overlay({"personas": {"p": {"nickname": "Lee"}}})
        self.assertIn("nickname", str(raised.exception))

    def test_world_referencing_unknown_persona_is_rejected(self) -> None:
        with self.assertRaises(importer.ImportFailure) as raised:
            importer.parse_overlay({"personas": {}, "worlds": {"w": {"persona": "ghost"}}})
        self.assertIn("ghost", str(raised.exception))

    def test_unknown_top_level_and_world_keys_are_rejected(self) -> None:
        with self.assertRaises(importer.ImportFailure):
            importer.parse_overlay({"persona": {}})
        with self.assertRaises(importer.ImportFailure):
            importer.parse_overlay({"worlds": {"w": {"personna": "p"}}})

    def test_removal_requires_file_id_and_reason(self) -> None:
        entry = {"file": "fixtures/notes/notes.json", "id": "NOTE-1", "reason": "duplicate"}
        for missing in ("file", "id", "reason"):
            with self.subTest(missing=missing), self.assertRaises(importer.ImportFailure):
                importer.parse_overlay({"worlds": {"w": {"removeFixtureItems": [{**entry, missing: ""}]}}})

    def test_grading_edit_requires_field_find_replace_and_reason(self) -> None:
        entry = grading_edit("Bo", "Dana")
        for missing in ("field", "find", "replace", "reason"):
            without_key = {key: value for key, value in entry.items() if key != missing}
            with self.subTest(missing=missing), self.assertRaises(importer.ImportFailure):
                importer.parse_overlay({"worlds": {"w": {"editGrading": [without_key]}}})

    def test_grading_edit_rejects_unknown_field_empty_find_and_blank_reason(self) -> None:
        for overrides in ({"field": "persona"}, {"field": None}, {"find": ""}, {"reason": "  "}):
            with self.subTest(overrides=overrides), self.assertRaises(importer.ImportFailure):
                importer.parse_overlay({"worlds": {"w": {"editGrading": [{**grading_edit("Bo"), **overrides}]}}})

    def test_grading_edit_unknown_field_error_lists_allowed_fields(self) -> None:
        with self.assertRaises(importer.ImportFailure) as raised:
            importer.parse_overlay({"worlds": {"w": {"editGrading": [grading_edit("Bo", field="persona")]}}})
        self.assertIn("judge_rubric", str(raised.exception))
        self.assertIn("reference_solution", str(raised.exception))

    def test_grading_edit_rejects_unknown_key(self) -> None:
        with self.assertRaises(importer.ImportFailure) as raised:
            importer.parse_overlay({"worlds": {"w": {"editGrading": [{**grading_edit("Bo"), "regex": True}]}}})
        self.assertIn("regex", str(raised.exception))

    def test_grading_edit_allows_empty_replace(self) -> None:
        overlay = importer.parse_overlay({"worlds": {"w": {"editGrading": [grading_edit("Bo", replace="")]}}})
        self.assertEqual(overlay.worlds["w"].grading_edits[0].replace, "")

    def test_grading_edit_requires_replace_to_be_a_string(self) -> None:
        with self.assertRaises(importer.ImportFailure):
            importer.parse_overlay({"worlds": {"w": {"editGrading": [{**grading_edit("Bo"), "replace": None}]}}})


class OverlayApplicationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_persona_override_replaces_only_the_given_keys(self) -> None:
        staged = make_staged_world(self.root)
        overlay = importer.parse_overlay(
            {"personas": {"p": {"name": "Ana Reyes", "organization": ""}}, "worlds": {"world_a": {"persona": "p"}}}
        )

        apply_overlay_quietly([staged], overlay)

        persona = json.loads((staged.path / "agent" / "persona.json").read_text())
        self.assertEqual(persona, {**PERSONA_JSON_TEXT, "name": "Ana Reyes", "organization": ""})

    def test_persona_override_on_unlisted_world_leaves_persona_alone(self) -> None:
        staged = make_staged_world(self.root)
        overlay = importer.parse_overlay({"personas": {"p": {"name": "Ana"}}})

        apply_overlay_quietly([staged], overlay)

        persona = json.loads((staged.path / "agent" / "persona.json").read_text())
        self.assertEqual(persona, PERSONA_JSON_TEXT)

    def test_removes_item_from_list_file_and_keeps_trailing_newline(self) -> None:
        staged = make_staged_world(self.root)
        notes = staged.path / "agent" / "fixtures" / "notes" / "notes.json"
        notes.parent.mkdir(parents=True)
        notes.write_text(json.dumps([{"note_id": "NOTE-1"}, {"note_id": "NOTE-2", "title": "x"}], indent=2) + "\n")
        overlay = importer.parse_overlay(
            {"worlds": {"world_a": {"removeFixtureItems": [
                {"file": "fixtures/notes/notes.json", "id": "NOTE-2", "reason": "stale"}
            ]}}}
        )

        apply_overlay_quietly([staged], overlay)

        self.assertEqual(json.loads(notes.read_text()), [{"note_id": "NOTE-1"}])
        self.assertTrue(notes.read_text().endswith("\n"))

    def test_removes_item_from_dict_holding_one_list_and_keeps_missing_trailing_newline(self) -> None:
        staged = make_staged_world(self.root)
        vault = staged.path / "agent" / "fixtures" / "claw_obsidian" / "vault.json"
        vault.parent.mkdir(parents=True)
        vault.write_text(json.dumps({"vault": [{"page_id": "P-1"}, {"page_id": "P-2"}]}, indent=2))
        overlay = importer.parse_overlay(
            {"worlds": {"world_a": {"removeFixtureItems": [
                {"file": "fixtures/claw_obsidian/vault.json", "id": "P-1", "reason": "stale"}
            ]}}}
        )

        apply_overlay_quietly([staged], overlay)

        self.assertEqual(json.loads(vault.read_text()), {"vault": [{"page_id": "P-2"}]})
        self.assertFalse(vault.read_text().endswith("\n"))

    def test_zero_matches_fails_naming_world_file_and_id(self) -> None:
        self._assert_removal_fails([{"note_id": "NOTE-1"}], "NOTE-9", "expected 1 item with id 'NOTE-9', found 0")

    def test_multiple_matches_fail(self) -> None:
        self._assert_removal_fails(
            [{"note_id": "NOTE-1"}, {"note_id": "NOTE-1", "title": "copy"}], "NOTE-1", "found 2"
        )

    def test_value_match_under_a_non_id_key_does_not_count(self) -> None:
        self._assert_removal_fails([{"title": "NOTE-1"}], "NOTE-1", "found 0")

    def test_missing_file_fails(self) -> None:
        staged = make_staged_world(self.root)
        overlay = importer.parse_overlay(
            {"worlds": {"world_a": {"removeFixtureItems": [
                {"file": "fixtures/notes/notes.json", "id": "NOTE-1", "reason": "x"}
            ]}}}
        )
        with self.assertRaises(importer.ImportFailure) as raised:
            apply_overlay_quietly([staged], overlay)
        self.assertIn("fixtures/notes/notes.json", str(raised.exception))

    def test_file_outside_fixtures_and_logs_is_rejected(self) -> None:
        staged = make_staged_world(self.root)
        overlay = importer.parse_overlay(
            {"worlds": {"world_a": {"removeFixtureItems": [{"file": "persona.json", "id": "x", "reason": "x"}]}}}
        )
        with self.assertRaises(importer.ImportFailure):
            apply_overlay_quietly([staged], overlay)

    def test_overlay_world_not_in_this_run_is_rejected(self) -> None:
        staged = make_staged_world(self.root)
        overlay = importer.parse_overlay({"personas": {"p": {"name": "Ana"}}, "worlds": {"world_typo": {"persona": "p"}}})

        with self.assertRaises(importer.ImportFailure) as raised:
            apply_overlay_quietly([staged], overlay)
        self.assertIn("world_typo", str(raised.exception))
        persona = json.loads((staged.path / "agent" / "persona.json").read_text())
        self.assertEqual(persona["name"], "Liu Hao")

    def _assert_removal_fails(self, records: list[dict[str, str]], item_id: str, expected: str) -> None:
        staged = make_staged_world(self.root)
        notes = staged.path / "agent" / "fixtures" / "notes" / "notes.json"
        notes.parent.mkdir(parents=True)
        notes.write_text(json.dumps(records))
        overlay = importer.parse_overlay(
            {"worlds": {"world_a": {"removeFixtureItems": [
                {"file": "fixtures/notes/notes.json", "id": item_id, "reason": "x"}
            ]}}}
        )

        with self.assertRaises(importer.ImportFailure) as raised:
            apply_overlay_quietly([staged], overlay)
        message = str(raised.exception)
        self.assertIn("world_a", message)
        self.assertIn("fixtures/notes/notes.json", message)
        self.assertIn(expected, message)


class GradingEditApplicationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.staged = make_staged_world(self.root)
        write_grading(self.staged)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_single_edit_replaces_text_and_keeps_other_fields_and_key_order(self) -> None:
        apply_overlay_quietly([self.staged], grading_overlay([grading_edit("copy Bo", "copy Dana")]))

        grading = read_grading(self.staged)
        self.assertEqual(
            grading["reference_solution"], "Step 1: reply to Ana\nStep 2: copy Dana on the invoice\nStep 3: file it\n"
        )
        self.assertEqual(grading["judge_rubric"], GRADING_TEXT["judge_rubric"])
        self.assertEqual(grading["scoring_components"], GRADING_TEXT["scoring_components"])
        self.assertEqual(list(grading), list(GRADING_TEXT))

    def test_empty_replace_removes_matched_text(self) -> None:
        apply_overlay_quietly([self.staged], grading_overlay([grading_edit(" Mentions Bo.", field="judge_rubric")]))

        self.assertEqual(read_grading(self.staged)["judge_rubric"], "Credits the reply to Ana.")

    def test_edits_in_one_field_apply_in_file_order(self) -> None:
        overlay = grading_overlay([
            grading_edit("copy Bo", "forward to Dana"),
            grading_edit("forward to Dana", "forward to Dana Reyes"),
        ])

        apply_overlay_quietly([self.staged], overlay)

        self.assertIn("Step 2: forward to Dana Reyes on the invoice", read_grading(self.staged)["reference_solution"])

    def test_multiline_reference_keeps_its_line_structure(self) -> None:
        apply_overlay_quietly([self.staged], grading_overlay([grading_edit("copy Bo", "copy Dana")]))

        self.assertEqual(
            read_grading(self.staged)["reference_solution"].splitlines(),
            ["Step 1: reply to Ana", "Step 2: copy Dana on the invoice", "Step 3: file it"],
        )

    def test_zero_matches_fails_naming_world_field_and_find_preview(self) -> None:
        long_find = "x" * 70
        with self.assertRaises(importer.ImportFailure) as raised:
            apply_overlay_quietly([self.staged], grading_overlay([grading_edit(long_find)]))

        message = str(raised.exception)
        self.assertIn("world_a", message)
        self.assertIn("reference_solution", message)
        self.assertIn("x" * 60, message)
        self.assertNotIn("x" * 61, message)
        self.assertIn("found 0", message)

    def test_multiple_matches_fail(self) -> None:
        with self.assertRaises(importer.ImportFailure) as raised:
            apply_overlay_quietly([self.staged], grading_overlay([grading_edit("Step")]))
        self.assertIn("found 3", str(raised.exception))

    def test_failed_edit_leaves_grading_file_unchanged(self) -> None:
        before = (self.staged.path / importer.GRADING_YAML).read_text()
        with self.assertRaises(importer.ImportFailure):
            apply_overlay_quietly([self.staged], grading_overlay([grading_edit("Step 9")]))
        self.assertEqual((self.staged.path / importer.GRADING_YAML).read_text(), before)

    def test_world_not_in_this_run_is_rejected(self) -> None:
        overlay = grading_overlay([grading_edit("copy Bo", "copy Dana")], world_id="world_typo")
        with self.assertRaises(importer.ImportFailure) as raised:
            apply_overlay_quietly([self.staged], overlay)
        self.assertIn("world_typo", str(raised.exception))
        self.assertEqual(read_grading(self.staged), GRADING_TEXT)

    def test_summary_line_reports_grading_edit_count(self) -> None:
        overlay = grading_overlay([grading_edit("copy Bo", "copy Dana"), grading_edit("Ana", "Ana Reyes")])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            importer.apply_overlay([self.staged], overlay)
        self.assertIn("world_a: removed 0 fixture item(s), 2 grading edit(s)", output.getvalue())


class CreationTimeTest(unittest.TestCase):
    def test_keeps_naive_datetime_and_ignores_offset(self) -> None:
        record = {"created_at": "2026-04-05T08:30:00-05:00"}
        self.assertEqual(importer.creation_time(record, "notes"), "2026-04-05T08:30:00")

    def test_date_only_timestamp_means_midnight(self) -> None:
        self.assertEqual(importer.creation_time({"date": "2026-04-05"}, "gmail"), "2026-04-05T00:00:00")

    def test_todo_uses_created_at_not_due_date(self) -> None:
        record = {"created_at": "2026-04-01T10:00:00", "due_date": "2026-05-01"}
        self.assertEqual(importer.creation_time(record, "todo"), "2026-04-01T10:00:00")

    def test_missing_unrecognised_or_unknown_service_gives_none(self) -> None:
        self.assertIsNone(importer.creation_time({}, "notes"))
        self.assertIsNone(importer.creation_time({"created_at": "last tuesday"}, "notes"))
        self.assertIsNone(importer.creation_time({"created_at": "2026-04-05"}, "calendar"))


class ExecutionDateFilterTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.agent_dir = self.root / "agent"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write_fixture(self, service: str, content: str, name: str = "data.json") -> Path:
        path = self.agent_dir / "fixtures" / service / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def write_records(self, service: str, records: list[dict[str, Any]]) -> Path:
        return self.write_fixture(service, json.dumps(records))

    def drop(self) -> dict[str, int]:
        dropped = importer.drop_items_after_execution_date(self.agent_dir, EXECUTION_DATE)
        return {service: count for service, count in dropped.items() if count}

    def test_keeps_items_created_on_the_execution_date_and_drops_from_the_next_day(self) -> None:
        path = self.write_records(
            "notes",
            [
                {"note_id": "before", "created_at": "2026-04-04T23:59:59"},
                {"note_id": "same_day_late_evening", "created_at": "2026-04-05T23:59:59"},
                {"note_id": "next_day_midnight", "created_at": "2026-04-06T00:00:00"},
            ],
        )

        self.assertEqual(self.drop(), {"notes": 1})
        self.assertEqual([r["note_id"] for r in json.loads(path.read_text())], ["before", "same_day_late_evening"])

    def test_date_only_items_are_kept_on_the_execution_date_and_dropped_after(self) -> None:
        path = self.write_records(
            "kb",
            [{"article_id": "same_day", "created_at": "2026-04-05"}, {"article_id": "next_day", "created_at": "2026-04-06"}],
        )

        self.assertEqual(self.drop(), {"kb": 1})
        self.assertEqual([r["article_id"] for r in json.loads(path.read_text())], ["same_day"])

    def test_offset_is_ignored_when_comparing(self) -> None:
        path = self.write_records(
            "workmail",
            [
                {"message_id": "same_day_west_offset", "date": "2026-04-05T23:30:00-05:00"},
                {"message_id": "next_day_east_offset", "date": "2026-04-06T00:30:00+12:00"},
            ],
        )

        self.assertEqual(self.drop(), {"workmail": 1})
        self.assertEqual([r["message_id"] for r in json.loads(path.read_text())], ["same_day_west_offset"])

    def test_items_without_a_recognised_creation_time_are_kept(self) -> None:
        records = [{"note_id": "missing"}, {"note_id": "blank", "created_at": ""}, {"note_id": "garbled", "created_at": "soon"}]
        path = self.write_records("notes", records)

        self.assertEqual(self.drop(), {})
        self.assertEqual(json.loads(path.read_text()), records)

    def test_calendar_scheduler_and_unlisted_services_are_untouched(self) -> None:
        calendar = self.write_records("calendar", [{"event_id": "E1", "start_time": "2030-01-01T10:00:00"}])
        scheduler = self.write_records("scheduler", [{"job_id": "J1", "last_run": "2030-01-01"}])
        crm = self.write_records("crm", [{"customer_id": "C1", "last_contact_date": "2030-01-01"}])
        originals = [path.read_bytes() for path in (calendar, scheduler, crm)]

        self.assertEqual(self.drop(), {})
        self.assertEqual([path.read_bytes() for path in (calendar, scheduler, crm)], originals)

    def test_todo_due_date_does_not_decide_whether_a_task_is_dropped(self) -> None:
        path = self.write_records(
            "todo",
            [
                {"task_id": "created_early_due_late", "created_at": "2026-04-01T10:00:00", "due_date": "2026-06-01"},
                {"task_id": "created_late_due_early", "created_at": "2026-04-06T10:00:00", "due_date": "2026-04-01"},
            ],
        )

        self.assertEqual(self.drop(), {"todo": 1})
        self.assertEqual([r["task_id"] for r in json.loads(path.read_text())], ["created_early_due_late"])

    def test_dict_holding_one_list_keeps_its_other_keys(self) -> None:
        path = self.write_fixture(
            "rss",
            json.dumps(
                {
                    "source": "feed",
                    "articles": [
                        {"article_id": "a1", "published_at": "2026-04-05T08:00:00"},
                        {"article_id": "a2", "published_at": "2026-04-06T10:00:00"},
                    ],
                }
            ),
        )

        self.assertEqual(self.drop(), {"rss": 1})
        self.assertEqual(json.loads(path.read_text()), {"source": "feed", "articles": [{"article_id": "a1", "published_at": "2026-04-05T08:00:00"}]})

    def test_rewritten_file_keeps_non_ascii_text_and_trailing_newline(self) -> None:
        text = json.dumps(
            [{"note_id": "n1", "title": "会议记录", "created_at": "2026-04-05T08:00:00"}, {"note_id": "n2", "created_at": "2026-05-01"}],
            indent=2,
            ensure_ascii=False,
        ) + "\n"
        path = self.write_fixture("notes", text)

        self.assertEqual(self.drop(), {"notes": 1})
        rewritten = path.read_text(encoding="utf-8")
        self.assertIn("会议记录", rewritten)
        self.assertTrue(rewritten.endswith("\n"))

    def test_file_with_nothing_to_drop_is_not_rewritten(self) -> None:
        text = json.dumps([{"note_id": "n1", "created_at": "2026-04-05T08:00:00"}], indent=4)
        path = self.write_fixture("notes", text)

        self.assertEqual(self.drop(), {})
        self.assertEqual(path.read_text(), text)


class StageWorldDropCountTest(unittest.TestCase):
    def test_staged_world_reports_dropped_items_per_service(self) -> None:
        inbox = [
            {"message_id": "m1", "date": "2026-04-05T08:00:00+00:00"},
            {"message_id": "m2", "date": "2026-04-06T10:00:00+00:00"},
            {"message_id": "m3", "date": "2026-04-07T10:00:00+00:00"},
        ]
        fixtures = json.dumps({"fixtures/gmail/inbox.json": {"encoding": "utf8", "content": json.dumps(inbox)}})
        record = importer.TaskRecord(make_task_yaml(), fixtures, make_logs())
        with tempfile.TemporaryDirectory() as staging_root:
            staged = importer.stage_world(record, "custom_world", Path(staging_root))
            remaining = json.loads((staged.path / "agent/fixtures/gmail/inbox.json").read_text())

        self.assertEqual(dict(staged.dropped_fixture_items), {"gmail": 2})
        self.assertEqual([message["message_id"] for message in remaining], ["m1"])

    def test_describe_dropped_lists_only_services_with_drops(self) -> None:
        self.assertEqual(importer.describe_dropped({"gmail": 2, "notes": 0}), "gmail 2")
        self.assertEqual(importer.describe_dropped({}), "none")


class EndToEndTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.dataset_dir = root / "dataset"
        self.output_dir = root / "worlds"
        write_dataset(
            self.dataset_dir,
            {
                "benchmark-00000-of-00001.parquet": [task_row("benchmark", "skill")],
                "train-00000-of-00001.parquet": [
                    task_row("train", "tool", TASK_ID),
                    task_row("train", "tool", "T2_other_task"),
                ],
            },
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_task_argument_writes_world_with_expected_layout(self) -> None:
        code, stdout, _ = run_cli(
            ["--dataset-dir", str(self.dataset_dir), "--output", str(self.output_dir), "--task", f"benchmark:skill:{TASK_ID}"]
        )

        self.assertEqual(code, 0)
        world_dir = self.output_dir / importer.derive_world_id(TASK_ID, "Liu Hao")
        self.assertIn(f"Created {world_dir.name}", stdout)
        for relative in (
            importer.WORLD_YAML,
            importer.GRADING_YAML,
            f"{importer.AGENT_DIR}/{importer.PERSONA_JSON}",
            f"{importer.AGENT_DIR}/fixtures/gmail/inbox.json",
            f"{importer.AGENT_DIR}/fixtures/blobs/attachment.bin",
            f"{importer.AGENT_DIR}/logs/work_journal.md",
        ):
            self.assertTrue((world_dir / relative).is_file(), relative)

    def test_no_real_external_domain_ships(self) -> None:
        run_cli(
            ["--dataset-dir", str(self.dataset_dir), "--output", str(self.output_dir), "--task", f"benchmark:skill:{TASK_ID}"]
        )
        for path in self.output_dir.rglob("*"):
            if path.is_file() and path.suffix != ".bin":
                self.assertNotIn(EXTERNAL_DOMAIN, path.read_text(), path)

    def test_refuses_duplicate_world_ids_and_writes_nothing(self) -> None:
        code, _, stderr = run_cli(
            [
                "--dataset-dir",
                str(self.dataset_dir),
                "--output",
                str(self.output_dir),
                "--task",
                f"benchmark:skill:{TASK_ID}",
                "--task",
                f"train:tool:{TASK_ID}",
            ]
        )
        self.assertNotEqual(code, 0)
        self.assertIn("share world ids", stderr)
        self.assertFalse(self.output_dir.exists())

    def test_refuses_existing_world_without_force_and_overwrites_with_force(self) -> None:
        argv = ["--dataset-dir", str(self.dataset_dir), "--output", str(self.output_dir), "--task", f"benchmark:skill:{TASK_ID}"]
        self.assertEqual(run_cli(argv)[0], 0)

        code, _, stderr = run_cli(argv)
        self.assertNotEqual(code, 0)
        self.assertIn("--force", stderr)

        self.assertEqual(run_cli(argv + ["--force"])[0], 0)

    def test_manifest_with_explicit_world_id_and_train_task(self) -> None:
        manifest = self.dataset_dir.parent / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "tasks": [
                        {"split": "benchmark", "bundle": "skill", "taskId": TASK_ID, "worldId": "bench_world", "note": "ignored"},
                        {"split": "train", "bundle": "tool", "taskId": "T2_other_task"},
                    ]
                }
            )
        )
        code, _, _ = run_cli(["--dataset-dir", str(self.dataset_dir), "--output", str(self.output_dir), "--manifest", str(manifest)])

        self.assertEqual(code, 0)
        self.assertTrue((self.output_dir / "bench_world" / importer.WORLD_YAML).is_file())
        self.assertTrue((self.output_dir / importer.derive_world_id("T2_other_task", "Liu Hao")).is_dir())

    def test_missing_task_is_an_error(self) -> None:
        code, _, stderr = run_cli(
            ["--dataset-dir", str(self.dataset_dir), "--output", str(self.output_dir), "--task", "benchmark:skill:nope"]
        )
        self.assertNotEqual(code, 0)
        self.assertIn("not found", stderr)

    def test_overlay_file_overrides_persona_of_imported_world(self) -> None:
        overlay = self.dataset_dir.parent / "overlay.json"
        world_id = importer.derive_world_id(TASK_ID, "Liu Hao")
        overlay.write_text(
            json.dumps(
                {
                    "personas": {"ana": {"name": "Ana Reyes", "organization": ""}},
                    "worlds": {world_id: {"persona": "ana"}},
                }
            )
        )
        code, stdout, _ = run_cli(
            [
                "--dataset-dir", str(self.dataset_dir), "--output", str(self.output_dir),
                "--task", f"benchmark:skill:{TASK_ID}", "--overlay", str(overlay),
            ]
        )

        self.assertEqual(code, 0)
        self.assertIn("overrode 1 persona(s)", stdout)
        persona = json.loads((self.output_dir / world_id / "agent" / "persona.json").read_text())
        self.assertEqual((persona["name"], persona["organization"]), ("Ana Reyes", ""))

    def test_overlay_naming_a_world_outside_the_run_writes_nothing(self) -> None:
        overlay = self.dataset_dir.parent / "overlay.json"
        overlay.write_text(json.dumps({"worlds": {"typo_world": {"removeFixtureItems": []}}}))

        code, _, stderr = run_cli(
            [
                "--dataset-dir", str(self.dataset_dir), "--output", str(self.output_dir),
                "--task", f"benchmark:skill:{TASK_ID}", "--overlay", str(overlay),
            ]
        )

        self.assertEqual(code, 1)
        self.assertIn("typo_world", stderr)
        self.assertFalse(self.output_dir.exists())


if __name__ == "__main__":
    unittest.main()
