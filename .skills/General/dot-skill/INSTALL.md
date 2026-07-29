# dot-skill Installation

This folder is a complete local skill. Place it in a skill directory supported by your agent host, or keep it inside MyHarness program-local `.skills` so it travels with a zipped MyHarness bundle.

## MyHarness Program-Local Install

Recommended for portable MyHarness bundles:

```text
MyHarness/
  .skills/
    dot-skill/
      SKILL.md
      prompts/
      tools/
```

MyHarness loads this folder as a program-local skill with source `program`.

## Other Host Paths

Typical host-specific locations:

| Host | Target path |
|---|---|
| Claude Code | `~/.claude/skills/dot-skill` |
| Codex | `~/.codex/skills/dot-skill` |
| Hermes | host-specific local skills directory |
| OpenClaw | host-specific workspace skills directory |

## Dependencies

Core usage requires Python 3.9+.

Optional tools:

```bash
pip3 install python-docx openpyxl slack-sdk pydantic
```

For celebrity research helpers:

```bash
pip3 install openai-whisper
```

For subtitle download support, install `yt-dlp` and `ffmpeg` using your platform's package manager.

## Smoke Test

From this directory:

```bash
python3 tools/skill_writer.py --action list --character colleague --base-dir ./skills/colleague
python3 tools/research/quality_check.py --help
```

If both commands start without import errors, the skill toolchain is ready.
