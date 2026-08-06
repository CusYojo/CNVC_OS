# Codex and Claude Code Runtime Compatibility

## Contents

1. Skill discovery
2. Skill-root resolution
3. Python runtime
4. DOCX rendering and visual QA
5. Font handling
6. Host-neutral tool behavior
7. Compatibility acceptance checks

## Skill discovery

Use the same Skill directory for both hosts.

- Codex personal location: `~/.codex/skills/generate-project-qa-report/`
- Claude Code personal location: `~/.claude/skills/generate-project-qa-report/`

Claude Code 2.1.203 or later follows a skill-directory symlink. Prefer a symlink from the Claude Code location to the canonical Codex directory so scripts, templates, references, and rules cannot drift. If the installed Claude Code version is older, copy the complete directory and establish a deliberate synchronization process.

Claude Code invokes the personal Skill as `/generate-project-qa-report`. Codex invokes it as `$generate-project-qa-report`.

## Skill-root resolution

Never execute bundled scripts relative to the user's project directory.

In Claude Code:

```bash
QA_SKILL_DIR="${CLAUDE_SKILL_DIR}"
```

In Codex, set `QA_SKILL_DIR` to the absolute directory containing the loaded `SKILL.md`; the default personal location is:

```bash
QA_SKILL_DIR="$HOME/.codex/skills/generate-project-qa-report"
```

Keep report inputs and outputs in the user's workspace. Keep Skill scripts, references, and assets inside `QA_SKILL_DIR`.

## Python runtime

Require Python 3.9 or later. The validator uses the standard library. DOCX generation requires `python-docx`.

Run the preflight:

```bash
python3 "$QA_SKILL_DIR/scripts/check_runtime.py"
```

If `python-docx` is missing, do not install packages globally. When package installation is permitted, create a task-local virtual environment in the workspace and install from the bundled requirements file:

```bash
python3 -m venv ./tmp/qa-skill-venv
./tmp/qa-skill-venv/bin/python -m pip install \
  -r "$QA_SKILL_DIR/requirements.txt"
```

Use that interpreter for validation and DOCX generation. On Windows, use the corresponding `Scripts/python.exe` path.

## DOCX rendering and visual QA

Prefer the host's dedicated document renderer when it exists. Otherwise use one of these paths:

1. Microsoft Word export to PDF, then render every PDF page to PNG;
2. LibreOffice headless export to PDF, then use `pdftoppm` or PyMuPDF to produce PNG pages;
3. another trustworthy native DOCX renderer that preserves Word layout.

Inspect every rendered page. Do not treat XML validation or text extraction as visual QA. Reject missing Chinese glyphs, clipped text, broken tables, orphaned headings, incorrect page furniture, and accidental extra pages.

If LibreOffice shows missing Chinese glyphs but Microsoft Word is installed, verify with Word rather than changing the required DOCX fonts. Treat preview PDFs as QA intermediates and never deliver them unless the user requests PDF.

## Font handling

Keep the DOCX style declarations fixed at STFangsong for regular Chinese, STHeiti for bold Chinese, and Times New Roman for Latin text and numbers. Do not silently replace the declared fonts because the local preview host lacks them.

Do not bundle or download unlicensed fonts. If required fonts are unavailable, state the limitation and verify on a host with legally installed fonts before claiming that visual QA passed.

## Host-neutral tool behavior

- Use host-provided web search only for lawful, necessary research; preserve the same anti-fabrication and provenance rules.
- Use read-only database or connector access and the minimum required fields.
- Use the host's normal file-editing tool; do not require Codex-only directives or Claude Code-only dynamic shell injection.
- Keep `agents/openai.yaml` as optional Codex UI metadata. Claude Code ignores it as an ordinary supporting file.
- Do not add Claude Code-only frontmatter fields when the same Skill must also remain portable to Codex and other Agent Skills hosts.

## Compatibility acceptance checks

Require all of the following:

1. `SKILL.md` frontmatter contains a valid lowercase hyphenated `name` and a useful `description`.
2. Every linked reference, asset, and script resolves from the Skill directory.
3. `check_runtime.py` completes and reports DOCX generation readiness.
4. `validate_qa_report.py --json` works from a workspace outside the Skill directory.
5. `render_qa_docx.py` works from a workspace outside the Skill directory.
6. Claude Code discovers the Skill at `/generate-project-qa-report`.
7. Codex discovers the Skill as `$generate-project-qa-report`.
8. The final DOCX passes structural and every-page visual QA.
