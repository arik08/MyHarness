# Historical learning evidence

Preserved for provenance only. Historical confidence and claimed fixes are unverified here. Loading a skill, inspecting an unrelated file, or fetching a different claim is not proof of recovery. Do not replay old commands or paths.

## Original skill: learned-command-failures

## Consolidated Evidence

Merged from:
- `learned-category-bash`
- `learned-cmd-npm-run-test-react-src-components-tests-composer`
- `learned-cmd-python-skills-insane-search-scripts-youtube-tran`
- `learned-cmd-python-skills-skill-creator-scripts-init-skill-p`
- `learned-cmd-yt-dlp-dump-json-skip-download-https-www-youtube`

Reusable patterns:
- Targeted React tests fail usefully only after reading the failing assertion and nearby component/test contract.
- YouTube transcript work should use the reusable `youtube_transcript.py` helper; PowerShell redirection caused encoding/output-path problems.
- Skill creation is not complete after an init command; validate the resulting skill.
- Repeated shell failures usually mean the workflow, source, launcher, or validation route is wrong.

## Evidence 372e7e0e02d7261f
- Confidence: 0.85
- Signature: `cmd-yt-dlp-dump-json-skip-download-https-www-youtube-com-watch-v-uqdwml8vzuy-myh`
- Lesson: A repeated failure was observed and later verified as resolved: cmd input=yt-dlp --dump-json --skip-download "https://www.youtube.com/watch?v=uqdwML8VzUY" > .myharness_youtube.json; python -c "import json; d=json.load(open('.myharness: WARNING: [youtube] No supported JavaScript runti
- Do next time: Start by applying the verified corrective path: Ran command python .skills/General/insane-search/scripts/youtube_transcript.py "https://www.youtube.com/watch?v=FJ2qxWz4Lv0" --json --max-chars 200000 [{]
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.


## Original skill: learned-cmd-python-myharness-ui-checks-verify-ai-worm-py-tra

# Portable visual validation

- Observed failure class: a visual-check command referenced a developer-specific absolute path or a temporary script absent from another checkout.
- Diagnose the original error before retrying; a later successful command alone does not establish a fix.
- Resolve the MyHarness installation root from the active skill location. Confirm `.skills/General/visual-review/scripts/check_render.py` exists there, inspect its current CLI, and pass the actual artifact path.
- Do not reuse historical output filenames, sanitized user paths, partial flags, or `.myharness/ui-checks` scripts as dependencies.
- If the helper is unavailable, report the missing dependency and use an available validator; do not invent a successful check.
