"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  buildMapSvg,
  defaultSpec,
  lonLatBox,
  lonLatToXY,
  SHADE_LABELS,
  SHADES,
  xyToLonLat,
  type MapData,
  type MapKind,
  type MapSpec,
  pathD,
  type MapPath,
} from "@/lib/editor/mapFigure";

/**
 * **백지도 도구** — geogl3 세계·대한민국 백지도에서 나라/시도를 칠하고 A·B·㉠ 같은 표지를 찍어 평가원풍 흑백 SVG 를 만든다.
 * 지도를 누르면 지금 고른 붓(칠하기 단계)으로 칠하고, "표지 찍기"에서는 누른 자리에 다음 표지를 놓는다.
 */

const REGIONS: { name: string; lon: [number, number]; lat: [number, number] }[] = [
  { name: "세계", lon: [-180, 180], lat: [-60, 85] },
  { name: "아시아", lon: [25, 150], lat: [-12, 60] },
  { name: "동아시아", lon: [95, 150], lat: [18, 55] },
  { name: "동남아시아", lon: [90, 142], lat: [-12, 28] },
  { name: "남부 아시아", lon: [60, 100], lat: [5, 38] },
  { name: "서남아시아·북부 아프리카", lon: [-18, 65], lat: [10, 45] },
  { name: "유럽", lon: [-25, 45], lat: [34, 72] },
  { name: "아프리카", lon: [-20, 55], lat: [-36, 38] },
  { name: "북아메리카", lon: [-170, -50], lat: [10, 75] },
  { name: "앵글로아메리카", lon: [-130, -60], lat: [24, 55] },
  { name: "라틴 아메리카", lon: [-120, -30], lat: [-56, 33] },
  { name: "오세아니아", lon: [110, 180], lat: [-48, 0] },
];
const LABELS = ["A", "B", "C", "D", "E", "(가)", "(나)", "(다)", "(라)", "㉠", "㉡", "㉢", "㉣", "갑", "을", "병", "정"];

let ko: Intl.DisplayNames | null = null;
function nameOf(kind: MapKind, code: string) {
  if (kind === "korea") return code;
  try {
    ko ??= new Intl.DisplayNames(["ko"], { type: "region" });
    return ko.of(code) ?? code;
  } catch {
    return code;
  }
}

export default function MapTool({ initial, onApply, onClose }: { initial?: MapSpec; onApply: (svg: string, spec: MapSpec) => void; onClose: () => void }) {
  const [spec, setSpec] = useState<MapSpec>(initial ?? defaultSpec("world"));
  const [data, setData] = useState<MapData | null>(null);
  const [bboxes, setBboxes] = useState<Map<string, [number, number, number, number]> | null>(null);
  const [mode, setMode] = useState<"paint" | "dot" | "mark" | "line" | "area" | "text">("paint");
  /** 긋는 중인 선·영역의 점들. */
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [pathOpt, setPathOpt] = useState({ dash: false, arrow: true, fill: 0, smooth: true });
  const [textLabel, setTextLabel] = useState("사하라 사막");
  const [brush, setBrush] = useState(2);
  const [label, setLabel] = useState("A");
  const [query, setQuery] = useState("");
  const [lonLat, setLonLat] = useState(() => viewToLonLat(spec));
  const svgRef = useRef<SVGSVGElement>(null);
  const measureRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let dead = false;
    setData(null);
    setBboxes(null);
    fetch(`/maps/${spec.kind}.json`)
      .then((r) => r.json())
      .then((j: MapData) => !dead && setData(j))
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [spec.kind]);

  // 경로마다 크기를 재 둔다(보이는 영역 밖 경로를 빼서 SVG 를 가볍게).
  useEffect(() => {
    const svg = measureRef.current;
    if (!data || !svg) return;
    const m = new Map<string, [number, number, number, number]>();
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.appendChild(p);
    for (const ds of Object.values(data.shapes))
      for (const d of ds) {
        p.setAttribute("d", d);
        try {
          const b = p.getBBox();
          m.set(d, [b.x, b.y, b.width, b.height]);
        } catch {
          /* 재지 못하면 늘 보이는 것으로 */
        }
      }
    svg.removeChild(p);
    setBboxes(m);
  }, [data]);

  const codes = useMemo(() => (data ? Object.keys(data.shapes).sort((a, b) => nameOf(spec.kind, a).localeCompare(nameOf(spec.kind, b), "ko")) : []), [data, spec.kind]);
  const found = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return codes.filter((c) => nameOf(spec.kind, c).includes(q) || c.toLowerCase() === q.toLowerCase()).slice(0, 12);
  }, [codes, query, spec.kind]);

  const setFill = (code: string, lv: number) =>
    setSpec((s) => {
      const fills = { ...s.fills };
      if (lv <= 0) delete fills[code];
      else fills[code] = lv;
      return { ...s, fills };
    });

  function toXY(e: React.MouseEvent): [number, number] | null {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const q = pt.matrixTransform(ctm.inverse());
    return [q.x, q.y];
  }

  function nextLabel() {
    const used = new Set(spec.markers.map((m) => m.label));
    const i = LABELS.indexOf(label);
    const series = i < 5 ? LABELS.slice(0, 5) : i < 9 ? LABELS.slice(5, 9) : i < 13 ? LABELS.slice(9, 13) : LABELS.slice(13);
    return series.find((l) => !used.has(l) && l !== label) ?? label;
  }

  function finishPath() {
    const closed = mode === "area";
    if (draft.length >= (closed ? 3 : 2)) {
      const p: MapPath = { pts: draft, closed, dash: pathOpt.dash, arrow: !closed && pathOpt.arrow, fill: closed ? pathOpt.fill : 0, smooth: pathOpt.smooth };
      setSpec((s) => ({ ...s, paths: [...(s.paths ?? []), p] }));
    }
    setDraft([]);
  }

  function onMapClick(e: React.MouseEvent, code: string | null) {
    if (mode === "line" || mode === "area") {
      const p = toXY(e);
      if (p) setDraft((d) => [...d, p]);
      return;
    }
    if (mode === "text") {
      const p = toXY(e);
      if (p && textLabel.trim()) setSpec((s) => ({ ...s, markers: [...s.markers, { x: p[0], y: p[1], label: textLabel.trim(), dot: false }] }));
      return;
    }
    if (mode === "dot") {
      const p = toXY(e);
      if (p) setSpec((s) => ({ ...s, markers: [...s.markers, { x: p[0], y: p[1], label: "", dot: true }] }));
      return;
    }
    if (mode === "mark") {
      const p = toXY(e);
      if (!p) return;
      setSpec((s) => ({ ...s, markers: [...s.markers, { x: p[0], y: p[1], label, dot: true }] }));
      setLabel(nextLabel());
      return;
    }
    if (code) setFill(code, spec.fills[code] === brush ? 0 : brush);
  }

  function applyView(lon: [number, number], lat: [number, number]) {
    if (spec.kind !== "world") return;
    setSpec((s) => ({ ...s, view: lonLatBox(lon, lat) }));
    setLonLat({ lon: [Math.min(...lon), Math.max(...lon)], lat: [Math.min(...lat), Math.max(...lat)] });
  }

  const preview = useMemo(() => (data ? buildMapSvg(spec, data, bboxes ?? undefined) : ""), [spec, data, bboxes]);
  const sw = Math.max(spec.view[2], spec.view[3]) / 700;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-6xl rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 font-semibold">백지도로 그림 만들기</h2>
          {(["world", "korea"] as MapKind[]).map((k) => (
            <Button
              key={k}
              type="button"
              size="sm"
              variant={spec.kind === k ? "dark" : "outline"}
              onClick={() => {
                if (k === spec.kind) return;
                setSpec(defaultSpec(k));
                setLonLat(viewToLonLat(defaultSpec(k)));
              }}
            >
              {k === "world" ? "세계" : "대한민국"}
            </Button>
          ))}
          <span className="ml-auto text-xs text-slate-400">지도 자료: geogl3 백지도</span>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
              <Button type="button" size="xs" variant={mode === "paint" ? "dark" : "outline"} onClick={() => setMode("paint")}>
                칠하기
              </Button>
              <Button type="button" size="xs" variant={mode === "dot" ? "dark" : "outline"} onClick={() => setMode("dot")}>
                점 찍기
              </Button>
              <Button type="button" size="xs" variant={mode === "mark" ? "dark" : "outline"} onClick={() => setMode("mark")}>
                표지 찍기 (점+글자)
              </Button>
              <Button type="button" size="xs" variant={mode === "text" ? "dark" : "outline"} onClick={() => setMode("text")}>
                글자
              </Button>
              <Button type="button" size="xs" variant={mode === "line" ? "dark" : "outline"} onClick={() => { setDraft([]); setMode("line"); }}>
                선 긋기
              </Button>
              <Button type="button" size="xs" variant={mode === "area" ? "dark" : "outline"} onClick={() => { setDraft([]); setMode("area"); }}>
                영역 그리기
              </Button>
              {mode === "line" || mode === "area" ? (
                <>
                  <span className="text-slate-500">지도를 차례로 눌러 점을 찍고 &lsquo;끝내기&rsquo; ({draft.length}점)</span>
                  <Button type="button" size="xs" onClick={finishPath} disabled={draft.length < (mode === "area" ? 3 : 2)}>
                    끝내기
                  </Button>
                  <button type="button" className="underline" onClick={() => setDraft((d) => d.slice(0, -1))}>
                    한 점 취소
                  </button>
                  <label className="flex items-center gap-0.5">
                    <input type="checkbox" checked={pathOpt.smooth} onChange={(e) => setPathOpt((o) => ({ ...o, smooth: e.target.checked }))} />곡선
                  </label>
                  <label className="flex items-center gap-0.5">
                    <input type="checkbox" checked={pathOpt.dash} onChange={(e) => setPathOpt((o) => ({ ...o, dash: e.target.checked }))} />점선
                  </label>
                  {mode === "line" ? (
                    <label className="flex items-center gap-0.5">
                      <input type="checkbox" checked={pathOpt.arrow} onChange={(e) => setPathOpt((o) => ({ ...o, arrow: e.target.checked }))} />화살표
                    </label>
                  ) : (
                    <select className="rounded border border-slate-300 px-1 py-0.5" value={pathOpt.fill} onChange={(e) => setPathOpt((o) => ({ ...o, fill: Number(e.target.value) }))}>
                      <option value={0}>칠하지 않음</option>
                      {SHADE_LABELS.slice(1).map((l, i) => (
                        <option key={l} value={i + 1}>
                          {l}
                        </option>
                      ))}
                    </select>
                  )}
                </>
              ) : mode === "text" ? (
                <>
                  <span className="text-slate-500">누른 자리에 글자(점 없이)</span>
                  <input className="w-32 rounded border border-slate-300 px-1 py-0.5" value={textLabel} onChange={(e) => setTextLabel(e.target.value.slice(0, 20))} />
                </>
              ) : mode === "dot" ? (
                <span className="text-slate-500">지도를 누르면 그 자리에 점이 찍혀요(나라 위도 돼요). 글자는 아래 목록에서 붙일 수 있어요.</span>
              ) : mode === "paint" ? (
                SHADE_LABELS.slice(1).map((l, i) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setBrush(i + 1)}
                    className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${brush === i + 1 ? "border-slate-900" : "border-slate-200"}`}
                  >
                    <span className="inline-block h-3 w-3 border border-slate-500" style={{ background: i + 1 === 5 ? "repeating-linear-gradient(45deg,#000 0 1px,#fff 1px 4px)" : SHADES[i + 1] }} />
                    {l}
                  </button>
                ))
              ) : (
                <>
                  <span className="text-slate-500">다음 표지</span>
                  <select className="rounded border border-slate-300 px-1 py-0.5" value={label} onChange={(e) => setLabel(e.target.value)}>
                    {LABELS.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                  <input className="w-16 rounded border border-slate-300 px-1 py-0.5" value={label} onChange={(e) => setLabel(e.target.value.slice(0, 8))} />
                </>
              )}
            </div>
            <div className="overflow-hidden rounded border border-slate-200 bg-slate-50">
              {!data ? (
                <p className="p-10 text-center text-sm text-slate-400">지도 불러오는 중…</p>
              ) : (
                <svg ref={svgRef} viewBox={spec.view.join(" ")} className="block h-auto w-full cursor-crosshair select-none" onClick={(e) => mode !== "paint" && onMapClick(e, null)}>
                  {/* 화면용: 경로마다 눌러 칠할 수 있게 따로 그린다 */}
                  <rect x={spec.view[0]} y={spec.view[1]} width={spec.view[2]} height={spec.view[3]} fill="#fff" />
                  {Object.entries(data.shapes).map(([code, ds]) => {
                    const lv = spec.fills[code] ?? 0;
                    return (
                      <g
                        key={code}
                        fill={lv === 5 ? "#999" : SHADES[Math.min(lv, 4)]}
                        stroke="#000"
                        strokeWidth={sw}
                        className="hover:opacity-70"
                        onClick={(e) => {
                          if (mode === "paint") {
                            e.stopPropagation();
                            onMapClick(e, code);
                          }
                        }}
                      >
                        <title>{nameOf(spec.kind, code)}</title>
                        {ds.map((d, k) => (
                          <path key={k} d={d} />
                        ))}
                      </g>
                    );
                  })}
                  {(spec.paths ?? []).map((p, i) => (
                    <path key={`p${i}`} d={pathD(p)} fill={p.closed && p.fill ? "rgba(200,0,0,0.15)" : "none"} stroke="#d00" strokeWidth={sw * 1.6} strokeDasharray={p.dash ? `${sw * 5} ${sw * 3}` : undefined} />
                  ))}
                  {draft.length > 0 && (
                    <path d={pathD({ pts: draft.length === 1 ? [draft[0], draft[0]] : draft, closed: false, dash: false, arrow: false, fill: 0, smooth: pathOpt.smooth })} fill="none" stroke="#06c" strokeWidth={sw * 1.6} />
                  )}
                  {draft.map(([x, y], i) => (
                    <circle key={`d${i}`} cx={x} cy={y} r={sw * 2.5} fill="#06c" />
                  ))}
                  {spec.markers.map((m, i) => (
                    <g key={i}>
                      {m.dot && <circle cx={m.x} cy={m.y} r={sw * 3.2} fill="#d00" />}
                      <text x={m.dot ? m.x + sw * 5 : m.x} y={m.y} fontSize={Math.max(spec.view[2], spec.view[3]) / 26} fontWeight={700} dominantBaseline="middle" fill="#d00">
                        {m.label}
                      </text>
                    </g>
                  ))}
                </svg>
              )}
              <svg ref={measureRef} width={0} height={0} className="absolute" aria-hidden />
            </div>
            <p className="mt-1 text-xs text-slate-400">빗금은 화면에서 회색으로 보이고, 넣은 그림에는 빗금으로 들어가요. 표지는 화면에서만 빨갛게 보여요.</p>
          </div>
          <div className="flex flex-col gap-3 text-sm">
            {spec.kind === "world" && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-slate-600">보일 영역</span>
                <select
                  className="rounded border border-slate-300 px-2 py-1"
                  value=""
                  onChange={(e) => {
                    const r = REGIONS.find((x) => x.name === e.target.value);
                    if (r) applyView(r.lon, r.lat);
                  }}
                >
                  <option value="">지역 고르기…</option>
                  {REGIONS.map((r) => (
                    <option key={r.name}>{r.name}</option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-1 text-xs">
                  {(["lon", "lat"] as const).map((k) =>
                    [0, 1].map((i) => (
                      <label key={k + i} className="flex items-center gap-1">
                        {k === "lon" ? (i ? "경도 끝" : "경도 처음") : i ? "위도 위" : "위도 아래"}
                        <input
                          type="number"
                          className="w-16 rounded border border-slate-300 px-1"
                          value={Math.round(lonLat[k][i])}
                          onChange={(e) => {
                            const n = { ...lonLat, [k]: [...lonLat[k]] as [number, number] };
                            n[k][i] = Number(e.target.value);
                            setLonLat(n);
                          }}
                          onBlur={() => applyView(lonLat.lon, lonLat.lat)}
                        />
                      </label>
                    )),
                  )}
                </div>
                <label className="flex items-center gap-1 text-xs">
                  경위선
                  <select className="rounded border border-slate-300 px-1" value={spec.grid} onChange={(e) => setSpec((s) => ({ ...s, grid: Number(e.target.value) }))}>
                    {[0, 10, 15, 20, 30].map((g) => (
                      <option key={g} value={g}>
                        {g ? `${g}° 간격` : "없음"}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {spec.kind === "world" && <LonLatDot onAdd={(lon, lat, lb) => {
              const [x, y] = lonLatToXY(lon, lat);
              setSpec((s) => ({ ...s, markers: [...s.markers, { x, y, label: lb, dot: true }] }));
            }} />}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-slate-600">{spec.kind === "world" ? "나라 찾아 칠하기" : "시도 찾아 칠하기"}</span>
              <input className="rounded border border-slate-300 px-2 py-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={spec.kind === "world" ? "예: 브라질, 이집트" : "예: 강원"} />
              {found.map((c) => (
                <div key={c} className="flex items-center gap-1 text-xs">
                  <span className="flex-1 truncate">{nameOf(spec.kind, c)}</span>
                  {SHADE_LABELS.map((l, i) => (
                    <button key={l} type="button" title={l} onClick={() => setFill(c, i)} className={`h-4 w-4 border ${(spec.fills[c] ?? 0) === i ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-400"}`} style={{ background: i === 5 ? "repeating-linear-gradient(45deg,#000 0 1px,#fff 1px 3px)" : SHADES[i] }} />
                  ))}
                </div>
              ))}
            </div>
            {Object.keys(spec.fills).length > 0 && (
              <div className="flex flex-col gap-0.5 text-xs">
                <span className="font-semibold text-slate-600">칠한 곳</span>
                {Object.entries(spec.fills).map(([c, lv]) => (
                  <div key={c} className="flex items-center gap-1">
                    <span className="flex-1 truncate">
                      {nameOf(spec.kind, c)} · {SHADE_LABELS[lv]}
                    </span>
                    <button type="button" className="text-red-600" onClick={() => setFill(c, 0)}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {(spec.paths ?? []).length > 0 && (
              <div className="flex flex-col gap-0.5 text-xs">
                <span className="font-semibold text-slate-600">선·영역</span>
                {spec.paths!.map((p, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="flex-1">
                      {p.closed ? "영역" : "선"} {i + 1} · {p.pts.length}점{p.dash ? " · 점선" : ""}
                      {p.arrow ? " · 화살표" : ""}
                    </span>
                    <button type="button" className="text-red-600" onClick={() => setSpec((s) => ({ ...s, paths: (s.paths ?? []).filter((_, k) => k !== i) }))}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {spec.markers.length > 0 && (
              <div className="flex flex-col gap-0.5 text-xs">
                <span className="font-semibold text-slate-600">표지</span>
                {spec.markers.map((m, i) => {
                  const ll = spec.kind === "world" ? xyToLonLat(m.x, m.y) : null;
                  return (
                    <div key={i} className="flex items-center gap-1">
                      <input
                        className="w-14 rounded border border-slate-300 px-1"
                        value={m.label}
                        onChange={(e) => setSpec((s) => ({ ...s, markers: s.markers.map((x, k) => (k === i ? { ...x, label: e.target.value.slice(0, 8) } : x)) }))}
                      />
                      <label className="flex items-center gap-0.5">
                        <input type="checkbox" checked={m.dot} onChange={(e) => setSpec((s) => ({ ...s, markers: s.markers.map((x, k) => (k === i ? { ...x, dot: e.target.checked } : x)) }))} />점
                      </label>
                      <span className="flex-1 text-slate-400">{ll ? `${fmtLon(ll[0])} ${fmtLat(ll[1])}` : ""}</span>
                      <button type="button" className="text-red-600" onClick={() => setSpec((s) => ({ ...s, markers: s.markers.filter((_, k) => k !== i) }))}>
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-auto flex gap-2">
              <Button type="button" disabled={!data || !bboxes} onClick={() => data && onApply(buildMapSvg(spec, data, bboxes ?? undefined), spec)}>
                그림에 넣기
              </Button>
              <Button type="button" variant="outline" onClick={onClose}>
                닫기
              </Button>
            </div>
            {preview && <p className="text-xs text-slate-400">그림 크기 {Math.round(preview.length / 1024)}KB{preview.length > 880_000 ? " — 너무 커요, 영역을 좁혀 주세요" : ""}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function viewToLonLat(spec: MapSpec) {
  if (spec.kind !== "world") return { lon: [-180, 180] as [number, number], lat: [-90, 90] as [number, number] };
  const [x, y, w, h] = spec.view;
  const [lon1, lat2] = xyToLonLat(x, y);
  const [lon2, lat1] = xyToLonLat(x + w, y + h);
  return { lon: [lon1, lon2] as [number, number], lat: [lat1, lat2] as [number, number] };
}
const fmtLon = (v: number) => `${Math.abs(Math.round(v))}°${v < 0 ? "W" : "E"}`;
const fmtLat = (v: number) => `${Math.abs(Math.round(v))}°${v < 0 ? "S" : "N"}`;

/** 경위도를 숫자로 적어 점을 찍는다(예: 37.5°N 127°E). 남위·서경은 음수. */
function LonLatDot({ onAdd }: { onAdd: (lon: number, lat: number, label: string) => void }) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [lb, setLb] = useState("");
  const la = Number(lat), lo = Number(lon);
  const ok = lat.trim() !== "" && lon.trim() !== "" && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-slate-600">경위도로 점 찍기</span>
      <div className="flex items-center gap-1 text-xs">
        <input className="w-16 rounded border border-slate-300 px-1" placeholder="위도" value={lat} onChange={(e) => setLat(e.target.value)} />
        <input className="w-16 rounded border border-slate-300 px-1" placeholder="경도" value={lon} onChange={(e) => setLon(e.target.value)} />
        <input className="w-12 rounded border border-slate-300 px-1" placeholder="글자" value={lb} onChange={(e) => setLb(e.target.value.slice(0, 8))} />
        <Button type="button" size="xs" variant="outline" disabled={!ok} onClick={() => { onAdd(lo, la, lb); setLb(""); }}>
          찍기
        </Button>
      </div>
      <span className="text-[11px] text-slate-400">남위·서경은 음수로(예: 위도 -33.9, 경도 151.2)</span>
    </div>
  );
}
