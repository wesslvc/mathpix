/**
 * 등치선 생성기 — 스칼라 장 `f(u,v)` 에서 **marching squares** 로 등치선을 뽑아 이어진 선(폴리라인) 목록으로 돌려준다.
 * 지구과학의 등속선·등압선·등온선 단면은 "극값 몇 개가 서로 얽힌 장"이라, 극값 위치·크기만 정하면 서로 겹치거나 엉키지 않는
 * 진짜 등치선이 나온다(손으로 곡선을 그리던 근사와 다르다). 순수 계산이라 DOM·pdf-lib 을 모른다.
 */
export type Field = (u: number, v: number) => number;
export type Poly = [number, number][];

/** `level` 등치선을 격자 `nx × ny`(u,v ∈ [0,1])에서 뽑는다. 닫힌 곡선은 처음과 끝점이 같다. */
export function contourLines(f: Field, level: number, nx = 220, ny = 90): Poly[] {
  const val: number[][] = [];
  for (let j = 0; j <= ny; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nx; i++) row.push(f(i / nx, j / ny) - level);
    val.push(row);
  }
  const segs: [Poly[number], Poly[number]][] = [];
  const lerp = (a: number, b: number) => (a === b ? 0.5 : a / (a - b));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = val[j][i];
      const b = val[j][i + 1];
      const c = val[j + 1][i + 1];
      const d = val[j + 1][i];
      const idx = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const x = i / nx;
      const y = j / ny;
      const dx = 1 / nx;
      const dy = 1 / ny;
      const bot: Poly[number] = [x + lerp(a, b) * dx, y];
      const right: Poly[number] = [x + dx, y + lerp(b, c) * dy];
      const top: Poly[number] = [x + lerp(d, c) * dx, y + dy];
      const left: Poly[number] = [x, y + lerp(a, d) * dy];
      const add = (p: Poly[number], q: Poly[number]) => segs.push([p, q]);
      switch (idx) {
        case 1: case 14: add(left, bot); break;
        case 2: case 13: add(bot, right); break;
        case 3: case 12: add(left, right); break;
        case 4: case 11: add(right, top); break;
        case 6: case 9: add(bot, top); break;
        case 7: case 8: add(left, top); break;
        case 5: add(left, bot); add(right, top); break;
        case 10: add(bot, right); add(left, top); break;
      }
    }
  }
  // 선분을 끝점 키로 이어 붙인다.
  const key = (p: Poly[number]) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
  const map = new Map<string, number[]>();
  segs.forEach((s, k) => {
    for (const p of s) {
      const kk = key(p);
      (map.get(kk) ?? map.set(kk, []).get(kk)!).push(k);
    }
  });
  const used = new Array(segs.length).fill(false);
  const out: Poly[] = [];
  const nextOf = (p: Poly[number], self: number) => (map.get(key(p)) ?? []).find((k) => k !== self && !used[k]);
  for (let k = 0; k < segs.length; k++) {
    if (used[k]) continue;
    used[k] = true;
    const line: Poly = [segs[k][0], segs[k][1]];
    for (const dir of [1, 0]) {
      for (;;) {
        const end = dir ? line[line.length - 1] : line[0];
        const n = nextOf(end, -1);
        if (n === undefined) break;
        used[n] = true;
        const [p, q] = segs[n];
        const add = key(p) === key(end) ? q : p;
        if (dir) line.push(add);
        else line.unshift(add);
      }
    }
    out.push(line);
  }
  return out;
}
