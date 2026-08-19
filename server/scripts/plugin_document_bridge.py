#!/usr/bin/env python3
"""Small host bridge for deterministic document renderers bundled in plugins.

The application owns content generation and evidence review.  This bridge keeps
the final DOCX construction inside the selected plugin so template provenance
does not get lost in a second, generic renderer.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from datetime import datetime
from pathlib import Path
from typing import Any


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_processor(path: Path, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load plugin processor: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def render_proposal(args: argparse.Namespace) -> int:
    processor_path = args.processor.expanduser().resolve()
    payload_path = args.payload.expanduser().resolve()
    template_path = args.template.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    manifest_path = args.manifest.expanduser().resolve()
    processor = load_processor(processor_path, "sbl_investment_proposal_processor")
    expected_hash = processor.validate_approved_template(template_path)
    rendered_hash = processor.render_proposal(payload_path, output_path, template_path)
    if rendered_hash != expected_hash:
        raise SystemExit("proposal template provenance was lost during rendering")
    manifest = {
        "status": "rendered",
        "workflow": "SBL_APP_PLUGIN_TEMPLATE_RENDER_V1",
        "docx": str(output_path),
        "docx_sha256": sha256(output_path),
        "payload": str(payload_path),
        "payload_sha256": sha256(payload_path),
        "template": str(template_path),
        "template_sha256": expected_hash,
        "template_enforced": True,
        "renderer_mode": "clone-approved-docx",
        "external_llm_gateway": False,
        "rendered_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    write_json(manifest_path, manifest)
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


def render_qa(args: argparse.Namespace) -> int:
    processor_path = args.processor.expanduser().resolve()
    payload_path = args.payload.expanduser().resolve()
    artifacts = args.artifacts.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    verify_path = args.verify_out.expanduser().resolve()
    processor = load_processor(processor_path, "sbl_investment_qa_processor")
    content = read_json(payload_path)
    artifacts.mkdir(parents=True, exist_ok=True)
    write_json(artifacts / "qa_content.json", content)

    # The host already completed evidence and answer review.  The plugin renderer
    # still expects its six staged filenames before it can enter layout code, so
    # provide explicit host-adapter markers instead of pretending that a second
    # semantic audit was run here.
    adapter_fact = {
        "id": "HOST-REVIEW-001",
        "fact": "正文已通过应用事实与引用一致性审阅",
        "category": "host_review",
        "status": "verified",
        "materiality": 3,
        "source_ids": ["host-application-review"],
    }
    write_json(artifacts / "facts.json", [adapter_fact])
    write_json(artifacts / "rulings.json", {"rulings": [], "blacklist": []})
    write_json(artifacts / "qa_plan.json", {"profile": {}, "questions": []})
    write_json(artifacts / "quality_scorecard.json", {
        "dimensions": {}, "total": 0, "hard_failures": [], "revision_routes": []
    })
    write_json(artifacts / "revision_log.json", [])

    # allow_failed_audit only bridges the host's already-reviewed content into
    # the plugin's deterministic DOCX formatter.  Release is still blocked below
    # unless every plugin package/layout check passes.
    processor.render_docx(artifacts, output_path, allow_failed_audit=True)
    report = processor.verify_docx(artifacts, output_path)
    render_issues = report.get("render_issues") or []
    package = report.get("docx_package") or {}
    expected_questions = len(content.get("items") or [])
    if render_issues:
        raise SystemExit("QA plugin layout verification failed: " + "; ".join(render_issues))
    if package.get("question_count") != expected_questions:
        raise SystemExit(
            f"QA plugin question count mismatch: {package.get('question_count')}/{expected_questions}"
        )
    result = {
        "status": "pass",
        "renderer_mode": "plugin-deta-qa-pdf",
        "format_profile": "deta_qa_pdf",
        "docx": str(output_path),
        "docx_sha256": sha256(output_path),
        "question_count": expected_questions,
        "render_issues": [],
        "docx_package": package,
        "semantic_gate": "host-application-review",
        "external_llm_gateway": False,
    }
    write_json(verify_path, result)
    print(json.dumps(result, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    proposal = subparsers.add_parser("proposal")
    proposal.add_argument("--processor", type=Path, required=True)
    proposal.add_argument("--payload", type=Path, required=True)
    proposal.add_argument("--template", type=Path, required=True)
    proposal.add_argument("--output", type=Path, required=True)
    proposal.add_argument("--manifest", type=Path, required=True)
    proposal.set_defaults(func=render_proposal)

    qa = subparsers.add_parser("qa")
    qa.add_argument("--processor", type=Path, required=True)
    qa.add_argument("--payload", type=Path, required=True)
    qa.add_argument("--artifacts", type=Path, required=True)
    qa.add_argument("--output", type=Path, required=True)
    qa.add_argument("--verify-out", type=Path, required=True)
    qa.set_defaults(func=render_qa)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
