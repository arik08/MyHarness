#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""덱을 백업 PDF로 뽑는다 — 장당 1페이지.

행사장 브라우저가 말을 안 듣거나 네트워크가 죽어 폰트가 안 올 때를 위한 보험이다.
발표 자료는 되돌릴 기회가 없으므로 종이(또는 PDF) 백업을 만들어 둔다.

방식
----
헤드리스 Chrome/Edge 의 --print-to-pdf 를 쓴다. 별도 파이썬 패키지가 필요 없고
윈도우에는 Edge 가 항상 있다.

단계 노출은 PDF 에서 의미가 없으므로 **모든 단계를 노출한 상태**로 인쇄해야 한다.
그래서 원본을 직접 인쇄하지 않고, 인쇄용 CSS 를 덧붙인 임시 사본을 만든다.

사용법
------
    python export_pdf.py deck.html
    python export_pdf.py deck.html --out backup.pdf
"""
import sys

# 윈도우 콘솔은 기본 코드페이지가 cp949 라서 한글이나 em-dash 를 출력하면
# UnicodeEncodeError 로 죽는다. 스킬을 쓰는 사람이 PYTHONIOENCODING 을
# 붙여줄 것을 기대할 수 없으므로 여기서 직접 고친다.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import argparse
import os
import shutil
import subprocess
import tempfile

# 인쇄용 오버라이드.
#  - 모든 단계를 노출한다 (PDF 에는 클릭이 없다)
#  - 모든 슬라이드를 보이게 하고 정적 흐름으로 되돌린다
#  - 무대 scale 을 걷어낸다 — @page 크기에 맞춰 브라우저가 맞춘다
PRINT_CSS = """
<style id="slidestyle-print">
@page { size: 1920px 1080px; margin: 0 }
@media print {
  html, body { overflow: visible !important; height: auto !important;
               background: #fff !important }
  #viewport { position: static !important; display: block !important }
  #stage { transform: none !important; box-shadow: none !important;
           width: 1920px !important; height: auto !important; overflow: visible !important }
  .slide { position: relative !important; inset: auto !important;
           opacity: 1 !important; visibility: visible !important;
           width: 1920px !important; height: 1080px !important;
           page-break-after: always; break-after: page }
  /* 마지막 장에도 page-break 를 걸면 빈 페이지가 하나 더 붙는다 */
  .slide:last-of-type { page-break-after: auto; break-after: auto }
  [data-step] { opacity: 1 !important; transform: none !important }
  #bg { position: absolute !important }
  #help { display: none !important }
  #progress, #counter, #chapter-tag { position: absolute !important }
}
</style>
"""

CANDIDATES = [
    os.environ.get('CHROME'),
    shutil.which('chrome'), shutil.which('google-chrome'),
    shutil.which('chromium'), shutil.which('msedge'),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def find_browser():
    for c in CANDIDATES:
        if c and os.path.exists(c):
            return c
    return None


def main():
    ap = argparse.ArgumentParser(description="덱을 백업 PDF로 내보낸다")
    ap.add_argument('deck', help='덱 HTML 경로')
    ap.add_argument('--out', default=None, help='출력 PDF (기본: 덱과 같은 이름)')
    ap.add_argument('--browser', default=None, help='브라우저 실행 파일 경로')
    args = ap.parse_args()

    deck = os.path.abspath(args.deck)
    if not os.path.exists(deck):
        sys.exit("파일이 없다: %s" % deck)

    out = os.path.abspath(args.out or os.path.splitext(deck)[0] + '.pdf')
    browser = args.browser or find_browser()
    if not browser:
        sys.exit("Chrome 또는 Edge 를 찾지 못했다. --browser 로 경로를 준다.")

    html = open(deck, encoding='utf-8').read()
    if '</head>' in html:
        patched = html.replace('</head>', PRINT_CSS + '</head>', 1)
    else:
        patched = PRINT_CSS + html

    # 상대 경로 자산(이미지 등)이 깨지지 않도록 원본과 같은 폴더에 임시 파일을 만든다
    folder = os.path.dirname(deck)
    fd, tmp = tempfile.mkstemp(suffix='.print.html', dir=folder)
    os.close(fd)
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(patched)

        cmd = [
            browser, '--headless=new', '--disable-gpu',
            '--no-pdf-header-footer',
            '--print-to-pdf=%s' % out,
            '--virtual-time-budget=8000',      # 폰트·애니메이션 정착을 기다린다
            'file:///' + tmp.replace('\\', '/'),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        if not os.path.exists(out):
            sys.stderr.write(proc.stdout + proc.stderr)
            sys.exit("PDF 생성 실패")
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    size = os.path.getsize(out)
    print("PDF 생성: %s (%.1f MB)" % (out, size / 1048576))
    print("단계 노출은 모두 펼친 상태로 인쇄됐다 — PDF 에는 클릭이 없다.")


if __name__ == '__main__':
    main()
