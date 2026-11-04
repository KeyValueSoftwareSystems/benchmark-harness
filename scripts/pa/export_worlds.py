#!/usr/bin/env python3
"""Export CLaw-Anything benchmark/skill scenarios into benchmark-harness resources/pa/worlds/.

Each CLaw-Anything scenario (benchmark/skill/{task_id}/) becomes a self-contained
world under resources/pa/worlds/{world_id}/ with:

    world.yaml      – API-side: prompt, tools, services, environment (setup only)
    grading.yaml    – API-side: scoring, safety, rubric, reference solution (grading only)
    agent/          – copied into the PI agent container (nothing that grades)
        persona.json    – identity, role, communication style
        fixtures/       – mock service data
        logs/           – work journal + timelines

The API reads both YAML files; only agent/ is mounted into the container.
Grading data never leaves the API, following the cyber pattern where the flag
stays in challenge.json and only files/ go into the agent.

Usage:
    python scripts/pa/export_worlds.py <claw-anything-root> [--only <task_id>] [--force]

    --only <task_id>    Export only the given scenario (default: all 100)
    --force             Overwrite existing worlds
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

import yaml


# ---------------------------------------------------------------------------
# Persona extraction helpers
# ---------------------------------------------------------------------------

def extract_persona_email(fixtures_dir: Path) -> str:
    """Find the persona's email — the most common 'to' address in the inbox."""
    inbox_path = fixtures_dir / "gmail" / "inbox.json"
    if not inbox_path.exists():
        return ""
    with open(inbox_path) as f:
        messages = json.load(f)
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
    contacts_path = fixtures_dir / "contacts" / "contacts.json"
    if contacts_path.exists():
        with open(contacts_path) as f:
            contacts = json.load(f)
        for contact in contacts:
            if contact.get("email", "").lower() == email.lower():
                return contact.get("name", "")
    local = email.split("@")[0] if "@" in email else email
    parts = re.split(r"[._-]", local)
    return " ".join(p.capitalize() for p in parts if p)


def extract_persona_org(email: str, fixtures_dir: Path, persona_name: str) -> str:
    """Derive organization from email signatures or domain fallback."""
    inbox_path = fixtures_dir / "gmail" / "inbox.json"
    if inbox_path.exists():
        with open(inbox_path) as f:
            messages = json.load(f)
        name_lower = persona_name.lower()
        for msg in messages:
            if email.lower() not in msg.get("from", "").lower():
                continue
            lines = [l.strip() for l in msg.get("body", "").strip().split("\n") if l.strip()]
            for i, line in enumerate(lines):
                if name_lower in line.lower() and i + 2 < len(lines):
                    org_candidate = lines[i + 2]
                    if not org_candidate.startswith(("http", "www", "+")) and len(org_candidate) > 3:
                        return org_candidate
    if "@" not in email:
        return ""
    domain = email.split("@")[1]
    return domain.split(".")[0].replace("-", " ").title()


def extract_persona_role(fixtures_dir: Path, persona_email: str, persona_name: str) -> str:
    """Try to find the persona's role from contacts or email signatures."""
    contacts_path = fixtures_dir / "contacts" / "contacts.json"
    if contacts_path.exists():
        with open(contacts_path) as f:
            contacts = json.load(f)
        for contact in contacts:
            if contact.get("email", "").lower() == persona_email.lower():
                title = contact.get("title", "")
                if title:
                    return title
    inbox_path = fixtures_dir / "gmail" / "inbox.json"
    if inbox_path.exists():
        with open(inbox_path) as f:
            messages = json.load(f)
        name_lower = persona_name.lower()
        for msg in messages:
            if persona_email.lower() not in msg.get("from", "").lower():
                continue
            lines = [l.strip() for l in msg.get("body", "").strip().split("\n") if l.strip()]
            for i, line in enumerate(lines):
                if name_lower in line.lower() and i + 1 < len(lines):
                    candidate = lines[i + 1]
                    if len(candidate.split()) >= 2 and not candidate.startswith(("http", "www", "+")):
                        return candidate
    return ""


def extract_communication_style(work_journal_path: Path) -> str:
    """Infer communication style from work journal entries."""
    if not work_journal_path.exists():
        return "professional"
    text = work_journal_path.read_text().lower()
    indicators = {
        "direct, detail-oriented": ["confirmed", "verified", "calculated", "assessed"],
        "analytical, methodical": ["analyzed", "categorized", "cross-referenced", "framework"],
        "collaborative, inclusive": ["coordinated", "discussed", "consulted", "team"],
        "decisive, action-oriented": ["approved", "decided", "committed", "launched"],
    }
    scores = {style: sum(text.count(kw) for kw in kws) for style, kws in indicators.items()}
    return max(scores, key=scores.get) if scores else "professional"


def extract_domain_knowledge(task_yaml: dict) -> list[str]:
    """Extract domain knowledge areas from task category and tools."""
    domains = set()
    category = task_yaml.get("category", "")
    if category:
        domains.add(category.replace("_", " "))
    tool_names = {t["name"] for t in task_yaml.get("tools", [])}
    if tool_names & {"finance_list_transactions", "finance_get_transaction", "finance_report_submit"}:
        domains.add("finance")
    if tool_names & {"inventory_list_products", "inventory_get_product", "inventory_create_order"}:
        domains.add("procurement")
    if tool_names & {"crm_list_customers", "crm_get_customer"}:
        domains.add("client management")
    if tool_names & {"helpdesk_list_tickets", "helpdesk_get_ticket"}:
        domains.add("support operations")
    if tool_names & {"scheduler_list_jobs", "scheduler_get_job"}:
        domains.add("scheduling")
    return sorted(domains)


# ---------------------------------------------------------------------------
# Build output artifacts
# ---------------------------------------------------------------------------

def build_persona(task_yaml: dict, fixtures_dir: Path, logs_dir: Path) -> dict:
    """Build persona.json — agent-side identity data."""
    email = extract_persona_email(fixtures_dir)
    name = extract_persona_name(email, fixtures_dir)
    return {
        "persona_id": task_yaml.get("task_id", "unknown"),
        "name": name,
        "email": email,
        "role": extract_persona_role(fixtures_dir, email, name),
        "organization": extract_persona_org(email, fixtures_dir, name),
        "communication_style": extract_communication_style(logs_dir / "work_journal.md"),
        "domain_knowledge": extract_domain_knowledge(task_yaml),
        "execution_date": task_yaml.get("execution_date", ""),
    }


def build_world(task_yaml: dict) -> dict:
    """Build world.yaml — API-side setup data (prompt, tools, services, environment).

    Contains everything needed to configure the run. No grading fields.
    """
    return {
        "task_id": task_yaml.get("task_id"),
        "task_name": task_yaml.get("task_name"),
        "category": task_yaml.get("category"),
        "difficulty": task_yaml.get("difficulty"),
        "prompt": task_yaml.get("prompt"),
        "execution_date": task_yaml.get("execution_date"),
        "tools": [
            {"name": t["name"], "description": t["description"]}
            for t in task_yaml.get("tools", [])
        ],
        "tool_endpoints": task_yaml.get("tool_endpoints", []),
        "services": [
            {"name": s["name"], "port": s["port"]}
            for s in task_yaml.get("services", [])
        ],
        "environment": task_yaml.get("environment", {}),
    }


def build_grading(task_yaml: dict) -> dict:
    """Build grading.yaml — API-side scoring data (rubric, expected actions, safety).

    Only the API reads this file; it is never copied into any agent container.
    """
    return {
        "task_id": task_yaml.get("task_id"),
        "scoring_components": task_yaml.get("scoring_components", []),
        "safety_checks": task_yaml.get("safety_checks", []),
        "expected_actions": task_yaml.get("expected_actions", []),
        "judge_rubric": task_yaml.get("judge_rubric", ""),
        "reference_solution": task_yaml.get("reference_solution", ""),
        "primary_dimensions": task_yaml.get("primary_dimensions", []),
    }


def derive_world_id(task_id: str, persona_name: str) -> str:
    """Create a human-readable world ID from persona name and task ID."""
    name_slug = re.sub(r"[^a-z0-9]+", "_", persona_name.lower()).strip("_")
    task_slug = re.sub(r"[^a-z0-9]+", "_", task_id.lower()).strip("_")
    if name_slug:
        max_task = 70 - len(name_slug)
        return f"{name_slug}_{task_slug[:max_task]}"
    return task_slug[:80]


# ---------------------------------------------------------------------------
# Export one scenario
# ---------------------------------------------------------------------------

def export_scenario(scenario_dir: Path, output_base: Path, force: bool = False) -> str | None:
    """Export one CLaw-Anything scenario to a world directory."""
    task_yaml_path = scenario_dir / "task.yaml"
    if not task_yaml_path.exists():
        print(f"  SKIP {scenario_dir.name}: no task.yaml", file=sys.stderr)
        return None

    with open(task_yaml_path) as f:
        task_yaml = yaml.safe_load(f)

    task_id = task_yaml.get("task_id", scenario_dir.name)
    fixtures_dir = scenario_dir / "fixtures"
    logs_dir = scenario_dir / "logs"

    if not fixtures_dir.exists():
        print(f"  SKIP {task_id}: no fixtures/ directory", file=sys.stderr)
        return None

    persona = build_persona(task_yaml, fixtures_dir, logs_dir)
    world_id = derive_world_id(task_id, persona["name"])
    world_dir = output_base / world_id

    if world_dir.exists() and not force:
        print(f"  SKIP {world_id}: already exists (use --force to overwrite)")
        return None
    if world_dir.exists():
        shutil.rmtree(world_dir)
    world_dir.mkdir(parents=True)

    # agent/ subfolder — everything that gets copied into the PI container
    agent_dir = world_dir / "agent"
    agent_dir.mkdir()

    # 1. Write world.yaml — API-side setup (prompt, tools, services, environment)
    world_out = build_world(task_yaml)
    with open(world_dir / "world.yaml", "w") as f:
        yaml.dump(world_out, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    print(f"  Created world.yaml (API-side: setup only)")

    # 2. Write grading.yaml — API-side scoring (rubric, expected actions, safety)
    grading_out = build_grading(task_yaml)
    with open(world_dir / "grading.yaml", "w") as f:
        yaml.dump(grading_out, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    print(f"  Created grading.yaml (API-side: scoring only)")

    # 3. Write persona.json — agent-side identity (inside agent/)
    with open(agent_dir / "persona.json", "w") as f:
        json.dump(persona, f, indent=2)
    print(f"  Created agent/persona.json: {persona['name']} ({persona['role']})")

    # 4. Copy fixtures — agent-side mock service data (inside agent/)
    dest_fixtures = agent_dir / "fixtures"
    shutil.copytree(fixtures_dir, dest_fixtures)
    print(f"  Copied agent/fixtures/ ({sum(1 for _ in dest_fixtures.rglob('*') if _.is_file())} files)")

    # 5. Copy logs — agent-side persona context (inside agent/)
    if logs_dir.exists():
        dest_logs = agent_dir / "logs"
        shutil.copytree(logs_dir, dest_logs)
        print(f"  Copied agent/logs/ ({sum(1 for _ in dest_logs.rglob('*') if _.is_file())} files)")

    return world_id


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Export CLaw-Anything scenarios to benchmark-harness PA worlds")
    parser.add_argument("claw_root", type=Path, help="Path to CLaw-Anything repo root")
    parser.add_argument("--only", type=str, default=None, help="Export only the given task_id directory name")
    parser.add_argument("--force", action="store_true", help="Overwrite existing worlds")
    parser.add_argument("--output", type=Path, default=None, help="Output directory (default: resources/pa/worlds)")
    args = parser.parse_args()

    skill_dir = args.claw_root / "benchmark" / "skill"
    if not skill_dir.exists():
        print(f"ERROR: {skill_dir} does not exist", file=sys.stderr)
        sys.exit(1)

    script_dir = Path(__file__).resolve().parent.parent.parent
    output_base = args.output or (script_dir / "resources" / "pa" / "worlds")
    output_base.mkdir(parents=True, exist_ok=True)

    if args.only:
        scenarios = [skill_dir / args.only]
        if not scenarios[0].exists():
            print(f"ERROR: scenario {args.only} not found in {skill_dir}", file=sys.stderr)
            sys.exit(1)
    else:
        scenarios = sorted(p for p in skill_dir.iterdir() if p.is_dir())

    exported = []
    skipped = 0
    for scenario_dir in scenarios:
        print(f"\n[{scenario_dir.name}]")
        world_id = export_scenario(scenario_dir, output_base, force=args.force)
        if world_id:
            exported.append(world_id)
        else:
            skipped += 1

    print(f"\n{'=' * 60}")
    print(f"Exported {len(exported)} worlds to {output_base}")
    print(f"Skipped {skipped} scenarios")
    if exported:
        print(f"\nWorlds created:")
        for wid in exported:
            print(f"  - {wid}")


if __name__ == "__main__":
    main()
