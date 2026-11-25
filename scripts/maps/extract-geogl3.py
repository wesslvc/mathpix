"""geogl3(wesslvc/seji) 의 백지도 SVG 에서 나라·시도 경로를 뽑아 public/maps/*.json 으로 만든다(한 번 돌리고 결과를 커밋).
사용: python3 scripts/maps/extract-geogl3.py <seji>/geogl3/for2027csat/index.html"""
import re, sys, json
from collections import defaultdict

src = open(sys.argv[1], encoding="utf-8").read()

def svg_block(marker):
    i = src.find(marker); a = src.rfind("<svg", 0, i); b = src.find("</svg>", i) + 6
    return src[a:b]

num = re.compile(r"-?\d+\.\d+")
def slim(d):
    d = num.sub(lambda m: f"{float(m.group()):.1f}".rstrip("0").rstrip("."), d)
    return re.sub(r"\s+", " ", d).strip()

# 세계: landxx 경로, 클래스의 마지막 2글자 = ISO 3166-1 alpha-2
w = svg_block('id="world-svg"')
countries = defaultdict(list)
for m in re.finditer(r"<path\b([^>]*)>", w):
    attrs = m.group(1)
    c = re.search(r'class="([^"]+)"', attrs); d = re.search(r'\sd="([^"]+)"', attrs)
    if not c or not d or "landxx" not in c.group(1): continue
    codes = [t for t in c.group(1).split() if re.fullmatch(r"[a-z]{2}", t) and t not in ("eu",)]
    if not codes: continue
    countries[codes[-1].upper()].append(slim(d.group(1)))
# 무리 안의 경로(<g class="landxx .. xx"> 아래 class 없는 path)
for g in re.finditer(r'<g\b[^>]*class="([^"]*landxx[^"]*)"[^>]*>(.*?)</g>', w, re.S):
    codes = [t for t in g.group(1).split() if re.fullmatch(r"[a-z]{2}", t) and t != "eu"]
    if not codes: continue
    for d in re.findall(r'<path\b[^>]*\sd="([^"]+)"', g.group(2)):
        sd = slim(d)
        if sd not in countries[codes[-1].upper()]:
            countries[codes[-1].upper()].append(sd)
json.dump({"viewBox": [0, 0, 2754, 1398], "projection": "equirectangular", "shapes": countries},
          open("public/maps/world.json", "w"), ensure_ascii=False, separators=(",", ":"))

# 대한민국: 맨 위 <g id="시도"> 아래 모든 path(+ 맨 위의 path 하나 = 세종)
import xml.etree.ElementTree as ET
k = ET.fromstring(svg_block('id="korea-svg"'))
regions = {}
for el in k:
    tag = el.tag.split("}")[-1]; rid = el.get("id") or ""
    if rid.startswith("레이어"): continue
    ds = [p.get("d") for p in el.iter() if p.tag.split("}")[-1] == "path" and p.get("d")]
    if tag == "path" and el.get("d"): ds = [el.get("d")]
    if ds: regions[rid] = [slim(d) for d in ds]
json.dump({"viewBox": [0, 0, 509, 716.105], "shapes": regions},
          open("public/maps/korea.json", "w"), ensure_ascii=False, separators=(",", ":"))
print(len(countries), "countries;", len(regions), "regions")
