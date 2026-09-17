#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""그라데이션 배경 위 텍스트 대비를 픽셀에서 측정한다.

왜 필요한가
-----------
getComputedStyle().backgroundColor 로는 그라데이션 배경 대비를 검사할 수 없다.
그라데이션은 background-image 이고 슬라이드는 대개 transparent 라, 계산된 색으로
재면 전부 통과로 나온다. 실제로는 발광 오브가 지나가는 자리에서 보조 텍스트가
3:1 아래로 떨어져 있어도 모른다.

왜 블록 평균인가
----------------
픽셀 최댓값을 그대로 찾으면 1~2px 입자(별·신호점)나 굵은 제목 획을 배경으로
오독한다. 그러면 "배경이 너무 밝다"는 잘못된 진단이 나오고, 배경을 어둡게 해도
수치가 안 움직인다. 블록 평균을 내면 그런 얇은 요소가 희석된다.

사용법
------
1) 브라우저에서 텍스트를 감추고 배경만 렌더한 스크린샷을 찍는다:

     document.querySelectorAll('.slide').forEach(s => s.style.visibility='hidden');
     ['progress','counter','chapter-tag'].forEach(id => {
       const el = document.getElementById(id); if (el) el.style.visibility='hidden';
     });

2) 그 PNG와 팔레트의 글자색들을 넘긴다:

     python contrast.py bgonly.png "#EBF2F8" "#B8C7D4" "#8CD2F5"

의존성: pillow  (pip install pillow)
"""
import sys

# 윈도우 콘솔은 기본 코드페이지가 cp949 라서 한글이나 em-dash 를 출력하면
# UnicodeEncodeError 로 죽는다. 스킬을 쓰는 사람이 PYTHONIOENCODING 을
# 붙여줄 것을 기대할 수 없으므로 여기서 직접 고친다.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


try:
    from PIL import Image, ImageFilter
except ImportError:
    sys.exit("pillow 가 필요하다:  pip install pillow")

# 배경의 얇은 요소(입자·글자 획)를 희석하는 반경. 19x19 창 평균이 된다.
BLUR_RADIUS = 9
# 표본 간격. 촘촘할수록 정확하지만 느리다.
SAMPLE_STEP = 4
# WCAG AA 본문 기준
AA_NORMAL = 4.5
AA_LARGE = 3.0


def _lin(v):
    v /= 255.0
    return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    return 0.2126 * _lin(rgb[0]) + 0.7152 * _lin(rgb[1]) + 0.0722 * _lin(rgb[2])


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def parse_hex(s):
    s = s.strip().lstrip('#')
    if len(s) == 3:
        s = ''.join(c * 2 for c in s)
    if len(s) != 6:
        raise ValueError("색은 #RRGGBB 형식으로 준다: %r" % s)
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def surface_extremes(path):
    """배경 이미지에서 '면'의 최명부·최암부를 찾는다."""
    im = Image.open(path).convert('RGB').filter(ImageFilter.BoxBlur(BLUR_RADIUS))
    px = im.load()
    w, h = im.size
    # 블러 경계는 이미지 밖 픽셀이 섞여 신뢰할 수 없으므로 잘라낸다
    margin = BLUR_RADIUS + 3
    brightest = darkest = None
    for y in range(margin, h - margin, SAMPLE_STEP):
        for x in range(margin, w - margin, SAMPLE_STEP):
            c = px[x, y]
            lum = luminance(c)
            if brightest is None or lum > brightest[0]:
                brightest = (lum, c, x, y)
            if darkest is None or lum < darkest[0]:
                darkest = (lum, c, x, y)
    if brightest is None:
        raise ValueError("이미지가 너무 작다 (%dx%d)" % (w, h))
    return brightest, darkest


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2

    path = argv[1]
    colors = []
    for raw in argv[2:]:
        try:
            colors.append((raw, parse_hex(raw)))
        except ValueError as e:
            print("건너뜀: %s" % e)

    if not colors:
        print("검사할 글자색이 없다")
        return 2

    bright, dark = surface_extremes(path)

    print("배경 면 최명부  rgb%s  L=%.4f  @(%d,%d)" % (bright[1], bright[0], bright[2], bright[3]))
    print("배경 면 최암부  rgb%s  L=%.4f" % (dark[1], dark[0]))
    print("그라데이션 깊이 %.1f배" % ((bright[0] + 0.05) / (dark[0] + 0.05)))
    print()
    print("%-12s %-14s %-14s %s" % ("글자색", "최명부 대비", "최암부 대비", "판정"))
    print("-" * 58)

    failed = []
    for raw, rgb in colors:
        worst = contrast(rgb, bright[1])
        best = contrast(rgb, dark[1])
        if worst >= AA_NORMAL:
            verdict = "AA"
        elif worst >= AA_LARGE:
            verdict = "큰 글씨만 (%.2f)" % worst
            failed.append((raw, worst))
        else:
            verdict = "미달"
            failed.append((raw, worst))
        print("%-12s %8.2f:1     %8.2f:1     %s" % (raw, worst, best, verdict))

    print()
    if failed:
        print("최명부에서 %d개 미달:" % len(failed))
        for raw, cr in failed:
            print("  %s  %.2f:1" % (raw, cr))
        print()
        print("배경을 어둡게 하는 것보다 글자색을 밝게 올리는 쪽이 정확하다 —")
        print("최명부는 대개 발광 레이어의 광원부라 알파를 줄여도 잘 내려가지 않는다.")
        return 1

    print("전 색상 AA(%.1f:1) 통과" % AA_NORMAL)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
