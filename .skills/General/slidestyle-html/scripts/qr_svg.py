#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QR을 인라인 SVG path로 만든다.

덱은 단일 파일이어야 하므로 외부 QR 이미지를 링크할 수 없다. 이 스크립트는
같은 행의 모듈을 하나의 수평 선분으로 합쳐 path 를 짧게 만든다 (URL 하나당
대략 4~5KB).

사용법
------
    python qr_svg.py "https://example.com/deck"
    python qr_svg.py "https://example.com" --dark "#20242C"

출력을 덱에 그대로 붙인다. **흰 사각형과 여백(quiet zone)을 유지한다** —
어두운 배경에 QR을 직접 얹으면 스캔되지 않는다.

의존성: qrcode  (pip install qrcode)
"""
import sys

# 윈도우 콘솔은 기본 코드페이지가 cp949 라서 한글이나 em-dash 를 출력하면
# UnicodeEncodeError 로 죽는다. 스킬을 쓰는 사람이 PYTHONIOENCODING 을
# 붙여줄 것을 기대할 수 없으므로 여기서 직접 고친다.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import argparse

try:
    import qrcode
except ImportError:
    sys.exit("qrcode 가 필요하다:  pip install qrcode")


def qr_path(url, border=2, ec='M'):
    """QR 모듈 행렬을 SVG path 문자열로 만든다. (모듈 수, path) 반환."""
    levels = {
        'L': qrcode.constants.ERROR_CORRECT_L,
        'M': qrcode.constants.ERROR_CORRECT_M,
        'Q': qrcode.constants.ERROR_CORRECT_Q,
        'H': qrcode.constants.ERROR_CORRECT_H,
    }
    q = qrcode.QRCode(version=None, error_correction=levels[ec],
                      box_size=1, border=border)
    q.add_data(url)
    q.make(fit=True)
    matrix = q.get_matrix()
    n = len(matrix)

    parts = []
    for y, row in enumerate(matrix):
        x = 0
        while x < n:
            if row[x]:
                run = x
                while run + 1 < n and row[run + 1]:
                    run += 1
                width = run - x + 1
                # 같은 행의 연속 모듈을 한 선분으로 — path 길이를 크게 줄인다
                parts.append("M%d %dh%dv1h-%dz" % (x, y, width, width))
                x = run + 1
            else:
                x += 1
    return n, ''.join(parts)


def main():
    ap = argparse.ArgumentParser(description="QR을 인라인 SVG로 만든다")
    ap.add_argument('url')
    ap.add_argument('--dark', default='#20242C', help='모듈 색 (기본 #20242C)')
    ap.add_argument('--light', default='#FFFFFF', help='바탕 색 (기본 흰색 — 바꾸지 않는 편이 좋다)')
    ap.add_argument('--border', type=int, default=2, help='여백 모듈 수 (기본 2)')
    ap.add_argument('--ec', default='M', choices=list('LMQH'), help='오류정정 수준')
    ap.add_argument('--label', default=None, help='SVG aria-label')
    args = ap.parse_args()

    n, path = qr_path(args.url, border=args.border, ec=args.ec)
    label = args.label or ('QR 코드: %s' % args.url)

    svg = (
        '<svg class="qr" viewBox="0 0 {n} {n}" shape-rendering="crispEdges"\n'
        '     role="img" aria-label="{label}">\n'
        '  <rect width="{n}" height="{n}" fill="{light}"/>\n'
        '  <path d="{path}" fill="{dark}"/>\n'
        '</svg>'
    ).format(n=n, label=label, light=args.light, dark=args.dark, path=path)

    print(svg)
    print(file=sys.stderr)
    print("모듈 %dx%d · path %d바이트 · 대상 %s" % (n, n, len(path), args.url), file=sys.stderr)
    print("흰 바탕과 여백을 유지한다. 어두운 배경에 직접 얹으면 스캔되지 않는다.", file=sys.stderr)


if __name__ == '__main__':
    main()
