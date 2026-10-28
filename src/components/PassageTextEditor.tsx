"use client";

import { useState } from "react";
import type { RichBlock, RichRun } from "@/lib/kice/richText";
import { markupToRuns, runsToMarkup } from "@/lib/kice/richMarkup";
import { Button } from "@/components/ui/button";

/**
 * **국어 지문을 글자로 보여 주고 고친다**(수정 창). 저장된 지문은 오려낸 사진이 아니라 읽어 둔 글(`korean.blocks`)로도 들고 있고,
 * 평가원 PDF 는 이 글을 조판한다. 그 글을 여기서 바로 고치면 PDF 에 그대로 반영된다.
 *
 * - 왼쪽 "글자 수정": 문단마다 글칸(굵게 `**…**` · 밑줄 `__…__` · 작은 네모 `[[…]]`), 들여쓰기·가운데·오른쪽, 문단 추가·삭제, 상자 안도 같다.
 * - "조판 미리보기": 같은 글을 서식대로 보여 준다(굵게·밑줄·네모·상자·그림 자리). 화면용이라 평가원 글꼴·단 폭과는 다르다.
 */

type Props = { blocks: RichBlock[]; onChange: (next: RichBlock[]) => void };

const para = (text = ""): RichBlock => ({ kind: "para", runs: text ? [{ t: text }] : [], indent: true });

function Runs({ runs }: { runs: RichRun[] }) {
  return (
    <>
      {runs.map((r, i) => (
        <span
          key={i}
          style={{
            fontWeight: r.b ? 700 : undefined,
            textDecoration: r.u ? "underline" : undefined,
            textUnderlineOffset: r.u ? 3 : undefined,
            outline: r.sq ? "1px solid #111" : undefined,
            outlineOffset: r.sq ? 1 : undefined,
            margin: r.sq ? "0 2px" : undefined,
            whiteSpace: "pre-wrap",
          }}
        >
          {r.t}
        </span>
      ))}
    </>
  );
}

function Preview({ blocks }: { blocks: RichBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "para") {
          return (
            <p
              key={i}
              className="my-1"
              style={{ textIndent: b.indent ? "1em" : undefined, textAlign: b.center ? "center" : b.right ? "right" : "justify", lineHeight: 1.75 }}
            >
              <Runs runs={b.runs} />
            </p>
          );
        }
        if (b.kind === "box") {
          return b.bracket ? (
            <div key={i} className="relative my-2 pl-9">
              <div className="absolute bottom-0 left-1 top-0 w-3 border-y border-l border-slate-900" />
              <span className="absolute left-[-0.3rem] top-1/2 -translate-y-1/2 text-xs font-semibold">[{b.bracket}]</span>
              <Preview blocks={b.blocks} />
            </div>
          ) : (
            <div key={i} className="my-2 border border-slate-900 px-3 py-1">
              <Preview blocks={b.blocks} />
            </div>
          );
        }
        return b.src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={b.src} alt="" className="mx-auto my-2 block max-w-full" style={{ width: `${Math.round((b.scale ?? 0.8) * 100)}%` }} />
        ) : (
          <div key={i} className="my-2 rounded border border-dashed border-slate-300 py-3 text-center text-xs text-slate-400">
            [그림 자리 {b.id}]
          </div>
        );
      })}
    </>
  );
}

function Editor({ blocks, onChange, depth = 0 }: { blocks: RichBlock[]; onChange: (next: RichBlock[]) => void; depth?: number }) {
  const set = (i: number, b: RichBlock) => onChange(blocks.map((x, k) => (k === i ? b : x)));
  const remove = (i: number) => onChange(blocks.filter((_, k) => k !== i));
  const addAfter = (i: number) => onChange([...blocks.slice(0, i + 1), para(), ...blocks.slice(i + 1)]);
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) => {
        if (b.kind === "para") {
          return (
            <div key={i} className="rounded-lg border border-slate-200 bg-white p-2">
              <textarea
                className="g-input w-full resize-y font-serif text-sm leading-relaxed"
                rows={Math.min(10, Math.max(2, Math.ceil(runsToMarkup(b.runs).length / 38)))}
                defaultValue={runsToMarkup(b.runs)}
                onBlur={(e) => {
                  const runs = markupToRuns(e.target.value);
                  if (JSON.stringify(runs) !== JSON.stringify(b.runs)) set(i, { ...b, runs });
                }}
              />
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                {(
                  [
                    ["indent", "들여쓰기"],
                    ["center", "가운데"],
                    ["right", "오른쪽"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`rounded border px-1.5 py-0.5 ${b[k] ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-600"}`}
                    onClick={() => set(i, { ...b, [k]: b[k] ? undefined : true })}
                  >
                    {label}
                  </button>
                ))}
                <span className="flex-1" />
                <button type="button" className="rounded border border-slate-300 px-1.5 py-0.5 text-slate-600" onClick={() => addAfter(i)}>
                  + 문단 추가
                </button>
                <button type="button" className="rounded border border-red-200 px-1.5 py-0.5 text-red-600" onClick={() => remove(i)}>
                  삭제
                </button>
              </div>
            </div>
          );
        }
        if (b.kind === "box") {
          return (
            <div key={i} className="rounded-lg border-2 border-slate-400 p-2">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <b>{b.bracket ? "묶음 대괄호" : "네모 상자"}</b>
                <label className="flex items-center gap-1">
                  이름표
                  <input
                    className="g-input w-14 px-1 py-0.5"
                    placeholder="A"
                    defaultValue={b.bracket ?? ""}
                    onBlur={(e) => set(i, { ...b, bracket: e.target.value.trim() || undefined })}
                  />
                </label>
                <span className="text-slate-400">(비우면 네모 상자)</span>
                <span className="flex-1" />
                <button type="button" className="rounded border border-red-200 px-1.5 py-0.5 text-red-600" onClick={() => remove(i)}>
                  상자 삭제
                </button>
              </div>
              {depth < 2 && <Editor blocks={b.blocks} onChange={(inner) => set(i, { ...b, blocks: inner })} depth={depth + 1} />}
            </div>
          );
        }
        return (
          <div key={i} className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-2 py-1.5 text-xs text-slate-500">
            그림 자리 {b.id} — 위치만 이 순서로 고정(그림은 아래 그림 목록에서 다룹니다)
            <span className="flex-1" />
            <button type="button" className="rounded border border-red-200 px-1.5 py-0.5 text-red-600" onClick={() => remove(i)}>
              빼기
            </button>
          </div>
        );
      })}
      {depth === 0 && (
        <Button type="button" variant="outline" size="xs" onClick={() => onChange([...blocks, para()])}>
          + 맨 끝에 문단 추가
        </Button>
      )}
    </div>
  );
}

export default function PassageTextEditor({ blocks, onChange }: Props) {
  const [tab, setTab] = useState<"edit" | "view">("edit");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-700">지문 글자</span>
        <div className="g-seg">
          <button type="button" data-active={tab === "edit"} onClick={() => setTab("edit")}>
            글자 수정
          </button>
          <button type="button" data-active={tab === "view"} onClick={() => setTab("view")}>
            조판 미리보기
          </button>
        </div>
        <span className="text-xs text-slate-500">고친 글은 저장하면 PDF 조판에 그대로 들어가요. <b>**굵게**</b> · __밑줄__ · [[네모]]</span>
      </div>
      {tab === "edit" ? (
        <Editor blocks={blocks} onChange={onChange} />
      ) : (
        <div className="max-h-[32rem] overflow-y-auto rounded-md border border-slate-200 bg-white px-4 py-3 font-serif text-[15px] text-slate-900">
          <Preview blocks={blocks} />
        </div>
      )}
    </div>
  );
}
