"""Set the scenario clock (`execution_time`, `utc_offset`) in already imported worlds.

Usage:
    python -I scripts/pa/set_world_clock.py [--worlds-dir DIR]

The time is 09:00; the offset is the most common one among the items created on the execution day (+00:00 when there
are none). Running it again changes nothing.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_claw_anything import (  # noqa: E402
    AGENT_DIR,
    DEFAULT_WORLDS_DIR,
    WORLD_YAML,
    _write_yaml,
    world_clock,
)


def set_clocks(worlds_dir: Path) -> int:
    updated = 0
    for world_path in sorted(worlds_dir.glob(f"*/{WORLD_YAML}")):
        world = yaml.safe_load(world_path.read_text())
        clock = world_clock(world_path.parent / AGENT_DIR, str(world["execution_date"]))
        if all(world.get(key) == value for key, value in clock.items()):
            continue
        _write_yaml(world_path, {**world, **clock})
        updated += 1
    return updated


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--worlds-dir", type=Path, default=DEFAULT_WORLDS_DIR)
    args = parser.parse_args(argv)
    print(f"Updated the clock in {set_clocks(args.worlds_dir)} world(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
