"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  /** 카드의 고정 너비(px). 이 값은 어떤 기기에서도 바뀌지 않는다. */
  width: number;
  children: React.ReactNode;
  /**
   * 현재 축소 배율(1이면 원래 크기). 화면 좌표를 카드 좌표로 되돌려야 하는
   * 쪽(예: 드래그)이 이 값을 필요로 한다.
   */
  onScaleChange?: (scale: number) => void;
};

/**
 * 문제 카드를 화면 폭에 맞게 **축소해서** 보여준다.
 *
 * 카드는 어떤 기기에서든 같은 결과가 나와야 하므로 너비를 고정한다. 그런데
 * 휴대폰 화면은 그보다 좁아서, 예전에는 가로 스크롤로 밀어 봐야 했다. 폭을
 * 줄이는 대신 통째로 축소하면 레이아웃은 그대로 유지하면서 한눈에 들어온다.
 *
 * 축소는 바깥 껍데기에만 건다 — 카드 자체(PNG로 캡처되는 요소)에 transform이
 * 걸리면 캡처 결과가 같이 줄거나 잘릴 수 있다. 캡처 대상은 원래 크기 그대로
 * 두고, 보는 것만 줄인다.
 *
 * transform은 레이아웃 크기를 바꾸지 않아서(줄여도 원래 크기만큼 자리를
 * 차지한다) 바깥 높이를 직접 계산해 준다. 안 그러면 카드 아래에 빈 공간이
 * 잔뜩 남는다.
 */
export default function ScaledCard({ width, children, onScaleChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [innerHeight, setInnerHeight] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    const inner = innerRef.current;
    if (!host || !inner) return;

    const measure = () => {
      // 쓸 수 있는 폭이 카드보다 좁을 때만 줄인다(넓다고 늘리지는 않는다).
      const avail = host.clientWidth;
      const next = avail > 0 ? Math.min(1, avail / width) : 1;
      setScale(next);
      // offsetHeight는 transform의 영향을 받지 않는 원래 높이다.
      setInnerHeight(inner.offsetHeight);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [width]);

  useEffect(() => {
    onScaleChange?.(scale);
  }, [scale, onScaleChange]);

  return (
    <div
      ref={hostRef}
      className="w-full overflow-hidden"
      // 축소한 만큼만 자리를 차지하게 한다. 아직 못 쟀으면(0) 높이를 비워
      // 두어 내용이 잘리지 않게 한다.
      style={innerHeight > 0 ? { height: innerHeight * scale } : undefined}
    >
      <div
        ref={innerRef}
        style={{
          width,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </div>
  );
}
