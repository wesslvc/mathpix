"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 손으로 자를 때의 **기본 모양**. 기본은 사각형이고, 다각형으로 바꿔 둘 수 있다
 * (사용자 요청 — "기본은 사각형인데 설정 가능하게").
 *
 * **기기마다 기억한다**(localStorage). 휴대폰으로는 네모가, PC 로는 다각형이 편한
 * 식으로 갈릴 수 있고, 계정에 저장하면 DB 왕복과 마이그레이션이 든다. 자르는 화면
 * 어디서든(한 문제 자르기 · 지면 통째로 · 국어 모드) 바꾸면 그게 곧 기본값이 되고,
 * 프로필 화면에서도 같은 값을 바꾼다.
 *
 * 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서는 늘 사각형이다 — 깨지지 않는다.
 */
export type CropShape = "rect" | "poly";

const KEY = "reprint.cropShape";
/** 같은 탭 안의 다른 화면도 곧바로 따라오게 알리는 이벤트(storage 이벤트는 다른 탭만 받는다). */
const EVENT = "reprint:cropshape";

export function readCropShape(): CropShape {
  try {
    return window.localStorage.getItem(KEY) === "poly" ? "poly" : "rect";
  } catch {
    return "rect";
  }
}

export function writeCropShape(shape: CropShape) {
  try {
    window.localStorage.setItem(KEY, shape);
  } catch {
    // 기억하지 못해도 이번 화면에서는 바뀐 값으로 동작한다.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: shape }));
}

/** 지금 기본 모양과 바꾸는 함수. 바꾸면 열려 있는 다른 화면도 따라온다. */
export function useCropShape(): [CropShape, (s: CropShape) => void] {
  // 서버 렌더와 첫 화면이 어긋나지 않게 처음에는 사각형으로 그리고, 붙은 뒤 읽는다.
  const [shape, setShape] = useState<CropShape>("rect");

  useEffect(() => {
    setShape(readCropShape());
    const onLocal = (e: Event) => setShape((e as CustomEvent<CropShape>).detail);
    const onOther = (e: StorageEvent) => {
      if (e.key === KEY) setShape(readCropShape());
    };
    window.addEventListener(EVENT, onLocal);
    window.addEventListener("storage", onOther);
    return () => {
      window.removeEventListener(EVENT, onLocal);
      window.removeEventListener("storage", onOther);
    };
  }, []);

  const set = useCallback((s: CropShape) => {
    setShape(s);
    writeCropShape(s);
  }, []);

  return [shape, set];
}
