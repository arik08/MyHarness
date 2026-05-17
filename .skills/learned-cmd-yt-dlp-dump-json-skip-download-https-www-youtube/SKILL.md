---
name: learned-cmd-yt-dlp-dump-json-skip-download-https-www-youtube
description: >
  Use when a YouTube link needs transcript/subtitle extraction or a yt-dlp
  YouTube subtitle command failed.
---

# learned-cmd-yt-dlp-dump-json-skip-download-https-www-youtube

Automatically learned guidance, generalized from prior YouTube subtitle extraction failures.

## When To Use
- Use for any YouTube transcript, subtitle, auto-caption, summary, or video-content analysis request where captions are needed.

## Generalized Lesson
- The video ID in the evidence is not the lesson. The reusable task is: get YouTube metadata, choose the best caption track, parse `json3`/`vtt`/`srv*`, and analyze only from transcript text.
- Do not rebuild a long `yt-dlp` plus inline Python command for each URL.

## Recommended Next Step
- Run the reusable helper first:

```powershell
py -3 .skills/insane-search/scripts/youtube_transcript.py "URL" --json
```

- If the helper returns `NO_CAPTIONS` or `EMPTY_CAPTIONS`, do not infer the video body from title/description alone.

## Avoid
- Do not store raw transcripts in the skill evidence.
- Do not use PowerShell redirection or long `python -c` snippets for the normal path.
