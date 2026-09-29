"use client";

import { useCropShape } from "@/lib/cropShape";
import CropShapeToggle from "./CropShapeToggle";
import { Card } from "@/components/ui/card";

/**
 * 프로필 화면의 "자르기 기본 모양" 설정. 자르는 화면에서 바꿔도 같은 값이
 * 바뀐다 — 여기는 그 값을 한눈에 보고 바꾸는 자리다. 이 기기에만 기억된다.
 */
export default function CropShapeSetting() {
  const [shape, setShape] = useCropShape();
  return (
    <Card className="flex flex-col gap-3 p-4 sm:p-5">
      <div>
        <p className="text-sm font-semibold text-ink">자르기 기본 모양</p>
        <p className="mt-0.5 text-xs text-slate-500">
          사진에서 문제를 손으로 자를 때 처음 쓰는 모양이에요. 다각형은 옆 문제가 귀퉁이를
          파고든 지면처럼 네모로는 깔끔히 안 잘리는 곳에 좋아요. 자르는 화면에서도 바꿀 수
          있고, 이 기기에만 기억돼요.
        </p>
      </div>
      <CropShapeToggle value={shape} onChange={setShape} size="md" />
    </Card>
  );
}
