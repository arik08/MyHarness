## Evidence e3c455c0701ffb67
- Confidence: 0.85
- Signature: `cmd-yt-dlp-dump-json-skip-download-https-www-youtube-com-watch-v-uqdwml8vzuy-myh`
- Lesson: A repeated failure was observed and later verified as resolved: cmd input=yt-dlp --dump-json --skip-download "https://www.youtube.com/watch?v=uqdwML8VzUY" > .myharness_youtube.json; python -c "import json; d=json.load(open('.myharness: WARNING: [youtube] No supported JavaScript runti
- Do next time: Start by applying the verified corrective path: Ran command python - <<"PY" import json, urllib.request, re, html with open('.myharness_youtube.json', encoding='utf-16') as f: d=json.load(f) subs=d.get('subtitles') o [LANG ko-orig tracks [('json3', 'Korean (Original)'), ('srv1', 'Korean 
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.
