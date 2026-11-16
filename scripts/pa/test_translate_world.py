"""Tests for translate_world.py. Run with a Python that has pyyaml installed."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import translate_world as translator  # noqa: E402

PROMPT_ZH = "请帮我查看日程。"
PROMPT_EN = "Please help me check my schedule."
NAME_ZH = "张三"
NAME_EN = "Zhang San"
MEETING_ZH = "会议 {name}"
MEETING_EN = "Meeting {name}"
BODY_ZH = "明天见\n谢谢"
BODY_EN = "See you tomorrow\nThanks"
JOURNAL_ZH = "中文日志 ABC-123"
JOURNAL_EN = "Work journal entry ABC-123"
ENGLISH_TRANSLATIONS = {
    PROMPT_ZH: PROMPT_EN,
    NAME_ZH: NAME_EN,
    MEETING_ZH: MEETING_EN,
    BODY_ZH: BODY_EN,
    JOURNAL_ZH: JOURNAL_EN,
}
EXECUTION_DATE_LINE = "execution_date: '2026-04-04'"


def yaml_text(data: Mapping[str, Any]) -> str:
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=False)


def json_text(data: Any, trailing_newline: bool = True) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    return text + "\n" if trailing_newline else text


def write_world(root: Path, name: str, files: Mapping[str, str]) -> Path:
    world_dir = root / name
    for relative, text in files.items():
        path = world_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return world_dir


def run_cli(*args: str) -> tuple[int, str, str]:
    stdout, stderr = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = translator.main(list(args))
    return code, stdout.getvalue(), stderr.getvalue()


def write_english(out_dir: Path, translate: Callable[[str], str]) -> None:
    for chunk in json.loads((out_dir / translator.MANIFEST_FILE).read_text())["chunks"]:
        originals = json.loads((out_dir / chunk["file"]).read_text())
        translated = [{"id": item["id"], "text": translate(item["text"])} for item in originals]
        english_name = Path(chunk["file"]).stem + ".en.json"
        (out_dir / english_name).write_text(json.dumps(translated, ensure_ascii=False, indent=2))


def happy_path_files() -> dict[str, str]:
    return {
        "world.yaml": yaml_text(
            {"task_id": "T1", "prompt": {"text": PROMPT_ZH, "language": "zh"}, "execution_date": "2026-04-04"}
        ),
        "agent/persona.json": json_text({"name": NAME_ZH, "role": "Engineer"}),
        "agent/fixtures/gmail/inbox.json": json_text(
            [{"subject": MEETING_ZH, "body": BODY_ZH}, {"subject": "Hello"}], trailing_newline=False
        ),
        "agent/logs/work_journal.md": f"# Journal\n{JOURNAL_ZH}\nEnglish line\n",
    }


class ExtractionTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_extracts_json_yaml_and_text_units_in_file_order(self) -> None:
        world = write_world(self.root, "world_a", {
            "world.yaml": yaml_text({"prompt": {"text": PROMPT_ZH}, "name": "English"}),
            "grading.yaml": yaml_text({"judge_rubric": "评分标准 ABC-123", "notes": "English"}),
            "agent/persona.json": json_text({"name": NAME_ZH}),
            "agent/fixtures/gmail/inbox.json": json_text([{"subject": "会议", "body": "明天见"}, {"subject": "Hello"}]),
            "agent/logs/work_journal.md": "# Journal\n中文日志 {name}\nEnglish line\n",
            "agent/logs/notes.bin": "中文 should be skipped",
        })

        units, summaries = translator.extract_units([world])

        self.assertEqual(
            [unit.text for unit in units],
            ["会议", "明天见", "中文日志 {name}", NAME_ZH, "评分标准 ABC-123", PROMPT_ZH],
        )
        self.assertEqual([unit.unit_id for unit in units], list(range(len(units))))
        self.assertEqual(summaries[0].unit_count, len(units))

    def test_dedupes_units_across_worlds_and_counts_per_world(self) -> None:
        world_a = write_world(self.root, "world_a", {"world.yaml": yaml_text({"prompt": {"text": PROMPT_ZH}})})
        world_b = write_world(self.root, "world_b", {
            "world.yaml": yaml_text({"prompt": {"text": PROMPT_ZH}, "note": "新任务"}),
        })

        units, summaries = translator.extract_units([world_a, world_b])

        self.assertEqual([unit.text for unit in units], [PROMPT_ZH, "新任务"])
        self.assertEqual([unit.unit_id for unit in units], [0, 1])
        self.assertEqual((summaries[1].unit_count, summaries[1].chars), (2, len(PROMPT_ZH) + len("新任务")))

    def test_chunks_respect_limit_and_give_oversize_unit_its_own_chunk(self) -> None:
        units = [
            translator.TextUnit(0, "ab"),
            translator.TextUnit(1, "cd"),
            translator.TextUnit(2, "efghijkl"),
            translator.TextUnit(3, "m"),
        ]

        chunks = translator.chunk_units(units, 5)

        self.assertEqual([[unit.text for unit in chunk] for chunk in chunks], [["ab", "cd"], ["efghijkl"], ["m"]])

    def test_chinese_dict_key_fails_naming_the_file(self) -> None:
        world = write_world(self.root, "world_a", {"grading.yaml": yaml_text({"中文键": "value"})})

        with self.assertRaises(translator.TranslateFailure) as context:
            translator.extract_units([world])

        self.assertIn("grading.yaml", str(context.exception))
        self.assertIn("中文键", str(context.exception))

    def test_chinese_file_name_fails_naming_the_path(self) -> None:
        world = write_world(self.root, "world_a", {"agent/logs/中文.md": "English\n"})

        with self.assertRaises(translator.TranslateFailure) as context:
            translator.extract_units([world])

        self.assertIn("中文.md", str(context.exception))

    def test_cli_extract_writes_chunks_and_manifest(self) -> None:
        world = write_world(self.root, "world_a", happy_path_files())
        out_dir = self.root / "translation"

        code, stdout, _ = run_cli("extract", "--chunk-chars", "1000", "--out-dir", str(out_dir), str(world))

        manifest = json.loads((out_dir / translator.MANIFEST_FILE).read_text())
        self.assertEqual(code, 0)
        self.assertEqual(manifest["unitCount"], 5)
        self.assertEqual(manifest["chunks"][0]["file"], "chunk_001.json")
        self.assertIn("Units: 5", stdout)
        self.assertIn("world_a: 5 units", stdout)


class ApplyTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.world = write_world(self.root, "world_a", happy_path_files())
        self.out_dir = self.root / "translation"
        run_cli("extract", "--chunk-chars", "1000", "--out-dir", str(self.out_dir), str(self.world))

    def test_apply_replaces_units_and_keeps_structure_for_every_file_kind(self) -> None:
        write_english(self.out_dir, ENGLISH_TRANSLATIONS.__getitem__)

        report = translator.apply_translations(self.out_dir, [self.world])

        world_yaml = yaml.safe_load((self.world / "world.yaml").read_text())
        persona = json.loads((self.world / "agent/persona.json").read_text())
        inbox_text = (self.world / "agent/fixtures/gmail/inbox.json").read_text()
        inbox = json.loads(inbox_text)
        journal_lines = (self.world / "agent/logs/work_journal.md").read_text().split("\n")
        self.assertEqual(list(world_yaml), ["task_id", "prompt", "execution_date"])
        self.assertEqual(world_yaml["prompt"]["text"], PROMPT_EN)
        self.assertEqual(persona, {"name": NAME_EN, "role": "Engineer"})
        self.assertEqual(len(inbox), 2)
        self.assertEqual(inbox[0], {"subject": MEETING_EN, "body": BODY_EN})
        self.assertEqual(inbox[1], {"subject": "Hello"})
        self.assertFalse(inbox_text.endswith("\n"))
        self.assertEqual(journal_lines, ["# Journal", JOURNAL_EN, "English line", ""])
        self.assertEqual(report.translation_count, 5)
        self.assertEqual(report.replaced_units, 5)
        self.assertEqual(report.prompt_languages_set, 1)
        self.assertEqual(world_yaml["prompt"]["language"], "en")
        self.assertEqual(translator.extract_units([self.world])[0], [])

    def test_prompt_already_in_english_is_not_rewritten(self) -> None:
        write_english(self.out_dir, ENGLISH_TRANSLATIONS.__getitem__)
        english_world = write_world(
            self.root, "world_en", {"world.yaml": yaml_text({"prompt": {"text": PROMPT_EN, "language": "en"}})}
        )
        before = (english_world / "world.yaml").read_text()

        report = translator.apply_translations(self.out_dir, [self.world, english_world])

        self.assertEqual((english_world / "world.yaml").read_text(), before)
        self.assertEqual(report.prompt_languages_set, 1)

    def test_world_yaml_without_prompt_mapping_gets_no_language(self) -> None:
        write_english(self.out_dir, ENGLISH_TRANSLATIONS.__getitem__)
        bare_world = write_world(self.root, "world_bare", {"world.yaml": yaml_text({"task_id": "T2"})})
        before = (bare_world / "world.yaml").read_text()

        report = translator.apply_translations(self.out_dir, [self.world, bare_world])

        self.assertEqual((bare_world / "world.yaml").read_text(), before)
        self.assertEqual(report.prompt_languages_set, 1)

    def test_validation_failures_are_reported_together_and_nothing_is_written(self) -> None:
        world = write_world(self.root, "world_bad", {"agent/fixtures/x.json": json_text(["甲", "乙", "丙", "丁 ABC-123", "戊\n己"])})
        out_dir = self.root / "bad_translation"
        run_cli("extract", "--chunk-chars", "1000", "--out-dir", str(out_dir), str(world))
        original_text = (world / "agent/fixtures/x.json").read_text()
        translated = [
            {"id": 1, "text": "still 乙"},
            {"id": 2, "text": ""},
            {"id": 3, "text": "Ding without its token"},
            {"id": 4, "text": "Wu and Ji"},
        ]
        (out_dir / "chunk_001.en.json").write_text(json.dumps(translated, ensure_ascii=False))

        with self.assertRaises(translator.TranslateFailure) as context:
            translator.apply_translations(out_dir, [world])

        message = str(context.exception)
        self.assertIn("id 0: no translation", message)
        self.assertIn("id 1: translation still contains CJK characters", message)
        self.assertIn("id 2: translation is empty", message)
        self.assertIn("id 3: placeholder or ID token missing (ABC-123)", message)
        self.assertIn("id 4: newline count differs from original (0 vs 1)", message)
        self.assertEqual((world / "agent/fixtures/x.json").read_text(), original_text)

    def test_second_apply_is_a_no_op(self) -> None:
        write_english(self.out_dir, ENGLISH_TRANSLATIONS.__getitem__)
        translator.apply_translations(self.out_dir, [self.world])
        after_first = {path: path.read_text() for path in self.world.rglob("*") if path.is_file()}

        report = translator.apply_translations(self.out_dir, [self.world])

        after_second = {path: path.read_text() for path in self.world.rglob("*") if path.is_file()}
        self.assertEqual(report.replaced_units, 0)
        self.assertEqual(report.prompt_languages_set, 0)
        self.assertEqual(report.changed_files, [])
        self.assertEqual(after_first, after_second)

    def test_execution_date_quoting_is_kept(self) -> None:
        write_english(self.out_dir, ENGLISH_TRANSLATIONS.__getitem__)

        translator.apply_translations(self.out_dir, [self.world])

        self.assertIn(EXECUTION_DATE_LINE, (self.world / "world.yaml").read_text())


if __name__ == "__main__":
    unittest.main()
