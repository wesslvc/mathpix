#!/usr/bin/env python3
"""
세계 백지도를 **메르카토르 도법**으로 만든다(public/maps/world.json).

원자료: Natural Earth 1:50m Admin 0 Countries(퍼블릭 도메인)
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
쓰는 법: python3 scripts/maps/build-world-mercator.py <ne_50m_admin_0_countries.geojson> public/maps/world.json

좌표는 src/lib/editor/mapFigure.ts 의 MERC_* 와 **같은 식**이어야 한다:
  x = (경도 + 180) / 360 · W,  y = (M(85°) − M(위도)) · W / 2π,  M(φ) = ln tan(π/4 + φ/2)
남극(AQ)은 뺀다(위도 −60° 아래는 그리지 않는다).
"""
import json, math, sys

W = 2754.0
LAT_TOP, LAT_BOT = 85.0, -60.0
def M(lat): return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
YTOP = M(LAT_TOP)
H = (YTOP - M(LAT_BOT)) * W / (2 * math.pi)

def xy(lon, lat):
    lat = max(LAT_BOT - 5, min(LAT_TOP, lat))
    return (lon + 180) / 360 * W, (YTOP - M(lat)) * W / (2 * math.pi)

def ring_d(ring):
    pts = []
    for lon, lat in ring:
        x, y = xy(lon, lat)
        if pts and abs(pts[-1][0] - x) < 0.6 and abs(pts[-1][1] - y) < 0.6:
            continue
        pts.append((x, y))
    if len(pts) < 3:
        return ""
    return "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z"

src = json.load(open(sys.argv[1]))
shapes = {}
for f in src["features"]:
    p = f["properties"]
    code = p.get("ISO_A2_EH") or p.get("ISO_A2") or ""
    if not code or code == "-99":
        code = p.get("ADM0_A3", "")
    if code == "AQ":
        continue
    g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    for poly in polys:
        d = "".join(ring_d(r) for r in poly)
        if d:
            shapes.setdefault(code, []).append(d)

json.dump({"viewBox": [0, 0, W, round(H, 3)], "projection": "mercator", "source": "Natural Earth 1:50m (public domain)", "shapes": shapes},
          open(sys.argv[2], "w"), ensure_ascii=False, separators=(",", ":"))
print(len(shapes), "nations, H =", round(H, 3))
