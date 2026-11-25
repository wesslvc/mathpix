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

# 세계: 원본 svg 가 </svg> 없이 끝나서(주석 뒤 바로 HTML) 마지막 </g> 까지만 잘라 닫아 XML 로 읽는다.
# path 의 나라 코드는 자기 class 나 가장 가까운 조상 <g>(class 의 2글자 토큰, 없으면 id)에서 고른다.
import xml.etree.ElementTree as ET
w = svg_block('id="world-svg"')
w = w[: w.find("Territories without ISO")]
w = w[: w.rfind("</g>") + 4] + "</svg>"
w = re.sub(r"&(?!amp;|lt;|gt;|quot;|apos;|#)\w+;", " ", w)
root = ET.fromstring(w)
def code_of(el):
    c = el.get("class") or ""
    toks = c.split()
    if "oceanxx" in toks or "circlexx" in toks: return False
    codes = [t for t in toks if re.fullmatch(r"[a-z]{2}", t) and t != "eu"]
    if codes: return codes[0].upper()
    i = el.get("id") or ""
    if re.fullmatch(r"[a-z]{2}", i): return i.upper()
    return None
countries = defaultdict(list)
def walk(el, inherited):
    tag = el.tag.split("}")[-1]
    own = code_of(el)
    if own is False: return
    code = own or inherited
    if tag == "path" and el.get("d") and code:
        countries[code].append(slim(el.get("d")))
    for ch in el: walk(ch, code)
walk(root, None)
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
