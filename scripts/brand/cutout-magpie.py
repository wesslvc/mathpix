#!/usr/bin/env python3
"""검은 바탕 위 마크를 투명 PNG 로 오려낸다.

**세 판이 각각 다른 자리에서 틀렸다. 전부 실제 픽셀을 재서 찾았다.**

① 배포된 판 — 가장자리에서 물을 채워 "바깥 검정"을 지우는데 기준값이 70 이라
   채우기가 경계 그라데이션을 지나 **검은 두건 속까지** 걸어 들어갔다. 두건이
   "바깥"이 되면 알파 되돌리기가 어두운 픽셀을 부풀려 **머리가 회백색으로
   파인다.** 실제로 그 상태로 나갔다.
② 기준값을 낮추고 "안쪽은 지킨다"를 넣은 판 — 이번엔 **날개 사이로 비치는
   갇힌 배경 구멍**까지 불투명해져 검은 잔점이 스물두 개 생겼다.
③ 채우기를 버리고 단순 문턱으로 바꾼 판 — 잔점은 사라졌지만 **경계가 톱니로
   깨졌다.** 알파를 밝기에 비례시킨 것이 원인이다. 반쯤 덮인 크림색 픽셀은
   L=150 인데 그 식은 "불투명한 회색"으로 읽는다. 알파는 밝기가 아니라 **덮인
   넓이**다.

지금 판: 알파를 **실루엣을 흐려서** 구한다(덮인 넓이의 근사). 그러면 밝은
크림색 가장자리든 어두운 두건 가장자리든 같은 규칙으로 맞는다 — 50% 덮인
크림은 관측 120 · 알파 0.5 → 색 240 으로, 50% 덮인 두건은 관측 6 · 알파 0.5 →
색 13 으로 제대로 되돌아온다. 색은 곱해져 있던 알파를 나눠서 되찾고, 안쪽
깊은 곳은 나누지 않고 관측값을 그대로 쓴다(나누면 어두운 두건이 부푼다).

**한계**: 두건이 배경과 똑같은 순수 검정(L<=T)인 그림은 밝기로 가를 수 없다.
그림을 갈아 끼울 때마다 아래 검사를 실제로 돌려 눈으로 볼 것.
"""
from PIL import Image, ImageFilter
import numpy as np

DEEP   = 3    # 이만큼 안쪽은 관측값 그대로(나누지 않는다) — 두건을 지키는 자리
SHRINK = 1    # 실루엣을 한 겹 깎는다 — 문턱이 그라데이션의 바깥 끝을 잡아
              # 경계가 한 겹 부풀고, 그대로 두면 흰 바탕에서 어두운 테두리가
              # 돈다(둘레 최소밝기 7 → 38 로 재서 고른 값이다)
BLUR   = 1.0  # 실루엣을 이만큼 흐려 덮인 넓이를 근사한다

def bg_threshold(L):
    """배경 덩어리가 끝나는 자리를 histogram 에서 찾는다(눈대중 금지)."""
    h = np.bincount(L.astype(np.int32).ravel(), minlength=256)
    peak = h[:40].max(); t = int(h[:40].argmax())
    while t + 1 < 40 and h[t + 1] > peak * 0.02:
        t += 1
    return t

def erode(mask, n):
    m = mask.copy()
    for _ in range(n):
        e = m.copy()
        e[1:, :] &= m[:-1, :]; e[:-1, :] &= m[1:, :]
        e[:, 1:] &= m[:, :-1]; e[:, :-1] &= m[:, 1:]
        m = e
    return m

def cut(src):
    a = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    L = a.max(-1)
    T = bg_threshold(L)
    sil = L > T                                  # 갇힌 배경 구멍도 함께 빠진다
    m = Image.fromarray((erode(sil, SHRINK) * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(BLUR))
    alpha = np.asarray(m).astype(np.float32) / 255.0
    deep = erode(sil, DEEP)
    alpha = np.where(deep, 1.0, alpha)
    rgb = np.where(deep[..., None], a,
                   np.clip(a / np.maximum(alpha, 1e-3)[..., None], 0, 255))
    rgb = np.where(alpha[..., None] > 0.004, rgb, 0)
    out = np.concatenate([rgb, alpha[..., None] * 255], -1)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA"), T

def square(img, size, ink_ratio):
    al = np.asarray(img)[..., 3]
    ys, xs = np.nonzero(al > 10)
    box = img.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    k = size * ink_ratio / max(box.size)
    nw, nh = max(1, round(box.size[0]*k)), max(1, round(box.size[1]*k))
    box = box.resize((nw, nh), Image.LANCZOS)
    c = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    c.paste(box, ((size-nw)//2, (size-nh)//2), box)
    return c

if __name__ == "__main__":
    import sys
    src = sys.argv[1] if len(sys.argv) > 1 else sys.exit("쓰기: cutout-magpie.py <검은 바탕 원본.png>")
    img, T = cut(src)
    print(f"배경 기준값 T={T} (histogram 에서 잰 값)")
    img.save("final-cut.png")
    for s in (512, 192, 64):
        square(img, s, 466/512).save(f"final-{s}.png")
    print("저장: final-cut.png, final-512/192/64.png")
