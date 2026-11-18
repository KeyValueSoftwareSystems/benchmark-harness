"""Mark the safety rules that need the user's approval in already imported worlds.

Usage:
    python -I scripts/pa/mark_approval_rules.py --overlay FILE [--worlds-dir DIR]

Reads each world's `requireApproval` tool list from the overlay and sets `mode: needs_approval` on the matching
safety rules of that world's grading.yaml. Running it again changes nothing.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_claw_anything import (  # noqa: E402
    DEFAULT_WORLDS_DIR,
    GRADING_YAML,
    ImportFailure,
    load_overlay,
    require_approval,
)


def mark_worlds(overlay_path: Path, worlds_dir: Path) -> int:
    overlay = load_overlay(overlay_path)
    marked = 0
    for world_id, world_overlay in sorted(overlay.worlds.items()):
        if not world_overlay.approval_tools:
            continue
        grading_path = worlds_dir / world_id / GRADING_YAML
        if not grading_path.is_file():
            raise ImportFailure(f"world {world_id}: {grading_path} does not exist")
        require_approval(grading_path, world_overlay.approval_tools, world_id)
        marked += 1
    return marked


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--overlay", type=Path, required=True)
    parser.add_argument("--worlds-dir", type=Path, default=DEFAULT_WORLDS_DIR)
    args = parser.parse_args(argv)
    try:
        marked = mark_worlds(args.overlay, args.worlds_dir)
    except ImportFailure as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"Marked approval rules in {marked} world(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
