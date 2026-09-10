#!/usr/bin/env python3
"""물까치 마크의 날개 파랑을 실제 물까치(Cyanopica cyanus) 색으로 낮춘다.

**왜 필요한가.** 마크 원본의 날개가 전기 파랑에 가까웠다(대표색 #1878ec~#2b97f3,
채도 0.69~0.77). 실제 물까치 날개는 **연하고 탁한 하늘색**이고, 이 저장소가
사용자가 준 물까치 사진에서 뽑아 둔 값도 그렇다 — 하늘색 날개 #7ba9db ·
짙은 날개 #5b96d4(css/main.css 의 팔레트 주석). 마크만 그 값에서 벗어나 있었다.

**세 저장소에 흩어진 마크를 한 번에 맞추려고 스크립트로 남긴다.** 예전에는 손으로
한 번씩 보정해서 지오글 것만 0.76배가 걸리고 나머지는 원본 그대로였다 — 그래서
같은 새인데 사이트마다 파랑이 달랐다. 한 번 돌리고 결과를 커밋한다.

**보정 방법**

- HSV 로 바꿔 **파랑 계열 픽셀의 채도만** 배율로 낮춘다. 색상(hue)은 안 건드린다 —
  지금 값(208~215°)이 이미 사진의 210° 와 맞다.
- 배율은 파일마다 **중앙값을 보고 푼다**(TARGET_S / 지금 중앙 채도). 그래야 이미
  한 번 보정된 파일과 원본 그대로인 파일이 **같은 자리에 도착한다** — 고정 배율을
  쓰면 출발점이 다른 만큼 결과도 갈린다.
- 색상 경계는 **부드럽게 가른다**(HUE_FEATHER). 딱 잘라내면 날개와 크림색 가슴이
  만나는 자리에 띠가 생긴다.
- **가장 어두운 파랑만 아주 조금 띄운다**(채도를 내리면 탁해 보이는 것을 막는다).
- 알파는 한 픽셀도 안 건드린다.

**부리에 문 지구본은 빼고 보정한다.** 바다의 파랑이 날개와 색상대가 겹쳐서 그대로
두면 지구본까지 바랜다. 초록(대륙) 픽셀이 모인 자리를 지구본으로 보고 그 둘레를
제외한다 — 지구본이 작을 수 있어 반지름의 1.6배로 넉넉히 잡는다.

    python3 scripts/brand/recolor-magpie.py <파일…> [--globe] [--dry]
"""
import sys, math
from PIL import Image
import numpy as np

TARGET_S = 0.46      # 사진 팔레트 #7ba9db(0.438)~#5b96d4(0.571) 사이, 연한 쪽에 붙인다
HUE_LO, HUE_HI = 0.50, 0.72
HUE_FEATHER = 0.04
LIFT = 0.06          # 어두운 파랑만 살짝 띄운다
# **어두운 파랑은 건드리지 않는다.** 브랜드 바탕색(#14171c)이 살짝 파랑이라
# 밝기를 안 보면 og.jpg 의 배경까지 탈색된다 — 그 파일은 "파랑" 픽셀의 97.7%가
# 밝기 0.11 인 배경이고 날개는 1.5% 뿐이라, 배율을 푸는 중앙값까지 배경이
# 정한다. 마크 쪽은 날개의 92%가 0.35 위라 이 문턱에 걸리지 않는다.
MIN_V, V_FEATHER = 0.30, 0.10


def rgb_to_hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    m = d > 1e-6
    ri = m & (mx == r); gi = m & (mx == g) & ~ri; bi = m & (mx == b) & ~ri & ~gi
    h[ri] = ((g - b)[ri] / d[ri]) % 6
    h[gi] = ((b - r)[gi] / d[gi]) + 2
    h[bi] = ((r - g)[bi] / d[bi]) + 4
    h /= 6
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    return h, s, mx


def hsv_to_rgb(h, s, v):
    i = np.floor(h * 6) % 6
    f = h * 6 - np.floor(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    out = np.zeros(h.shape + (3,), np.float32)
    for k, (R, G, B) in enumerate([(v, t, p), (q, v, p), (p, v, t),
                                   (p, q, v), (t, p, v), (v, p, q)]):
        m = i == k
        out[m] = np.stack([R, G, B], -1)[m]
    return out


def globe_mask(h, s, v, vis):
    """초록(대륙)이 모인 자리를 지구본으로 보고 그 둘레를 돌려준다."""
    green = vis & (h > 0.22) & (h < 0.45) & (s > 0.25) & (v > 0.15)
    if green.sum() < 30:
        return None
    ys, xs = np.nonzero(green)
    cy, cx = ys.mean(), xs.mean()
    r = math.sqrt(((ys - cy) ** 2 + (xs - cx) ** 2).mean()) * 1.6 + 4
    yy, xx = np.ogrid[:h.shape[0], :h.shape[1]]
    return ((yy - cy) ** 2 + (xx - cx) ** 2) <= r * r, (cx, cy, r, int(green.sum()))


def recolor(path, protect_globe=False, dry=False):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float32) / 255.0
    rgb, alpha = a[..., :3].copy(), a[..., 3]
    vis = alpha > 0.15
    h, s, v = rgb_to_hsv(rgb)

    # 색상 경계를 부드럽게 — 딱 자르면 날개와 가슴 사이에 띠가 생긴다
    w = np.clip((h - (HUE_LO - HUE_FEATHER)) / HUE_FEATHER, 0, 1) \
        * np.clip(((HUE_HI + HUE_FEATHER) - h) / HUE_FEATHER, 0, 1)
    w = np.where(vis, w, 0) * np.clip(s / 0.12, 0, 1) \
        * np.clip((v - MIN_V) / V_FEATHER, 0, 1)

    note = ""
    if protect_globe:
        got = globe_mask(h, s, v, vis)
        if got:
            gm, (cx, cy, r, n) = got
            w = np.where(gm, 0, w)
            note = f" 지구본 제외(중심 {cx:.0f},{cy:.0f} 반지름 {r:.0f}, 초록 {n}px)"
        else:
            note = " 지구본 못 찾음 — 제외 안 함"

    strong = w > 0.5
    if not strong.any():
        print(f"  {path}: 파랑 없음 — 건너뜀"); return
    med = float(np.median(s[strong]))
    k = min(1.0, TARGET_S / med)

    s2 = s * (1 - w * (1 - k))
    # 채도를 내리면 탁해 보인다 — 어두운 파랑만 조금 띄운다
    v2 = np.clip(v * (1 + LIFT * w * (1 - v)), 0, 1)
    out = hsv_to_rgb(h, np.clip(s2, 0, 1), v2)
    out = np.where(w[..., None] > 0, out, rgb)

    med2 = float(np.median(s2[strong]))
    px = rgb[strong]; px2 = out[strong]
    rep = "#%02x%02x%02x" % tuple((np.median(px, 0) * 255).astype(int))
    rep2 = "#%02x%02x%02x" % tuple((np.median(px2, 0) * 255).astype(int))
    print(f"  {path}\n    채도 {med:.3f} → {med2:.3f} (×{k:.3f})  {rep} → {rep2}"
          f"  파랑 {strong.sum()}px{note}")
    if dry:
        return
    src = Image.open(path)
    if src.mode == "RGB" or (src.format or "").upper() in ("JPEG", "JPG"):
        # og.jpg 처럼 알파가 없는 파일은 RGB 로 되돌려 저장한다(JPEG 는 RGBA 를 못 받는다).
        px = (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)
        # 품질 86 · 크로마 서브샘플링 없음(4:4:4). 배경은 거의 평면이고 새가
        # 작아서, 4:2:0 으로 줄이면 새 가장자리의 색이 뭉갠다. 92 는 파일이
        # 원본의 2.25배로 불어서(15.5→35KB) 낮췄다 — 86 이면 22KB 다.
        Image.fromarray(px, "RGB").save(path, quality=86, subsampling=0, optimize=True)
    else:
        res = np.concatenate([out, alpha[..., None]], -1)
        Image.fromarray((np.clip(res, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA").save(path)


def derive(master, outs):
    """보정한 512 마스터에서 작은 판을 다시 만든다.

    **작은 판을 따로 보정하면 안 된다.** 지구본은 192·64 로 줄면 초록(대륙)이
    안티에일리어싱에 묻혀 사라져서 못 찾고, 그러면 그 파일에서만 지구본이
    바랜다(실제로 그랬다: 512 는 초록 107px 로 찾고 192·64 는 못 찾음).
    마스터에서 줄이면 보호가 그대로 따라 내려온다 — 줄이고 보정할 때 생기는
    계단 현상을 피하려고 원래도 이렇게 만들었다.
    """
    src = Image.open(master).convert("RGBA")
    for o in outs:
        cur = Image.open(o)
        w, h = cur.size
        out = src.resize((w, h), Image.LANCZOS)
        if cur.mode == "P":
            # 팔레트로 돌려놔야 파일이 안 불어난다(원본 180색 · 2.1KB).
            n = len(cur.getpalette()) // 3
            out = out.quantize(colors=n, method=Image.FASTOCTREE)
        out.save(o)
        print(f"    {o}  ({w}x{h}, {cur.mode}) ← {master}")


if __name__ == "__main__":
    args = [x for x in sys.argv[1:] if not x.startswith("--")]
    g = "--globe" in sys.argv
    d = "--dry" in sys.argv
    if "--derive" in sys.argv:
        print(f"마스터에서 줄여 만들기: {args[0]}")
        derive(args[0], args[1:])
    else:
        print(f"목표 채도 {TARGET_S}{' · 지구본 보호' if g else ''}{' · 시험만' if d else ''}")
        for p in args:
            recolor(p, protect_globe=g, dry=d)
