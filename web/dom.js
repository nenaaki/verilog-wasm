// 要素を作る道具。回路図・波形・表で共通に使う。
//
// SVG 名前空間とふつうの HTML を取り違えると、要素は DOM に入るのに描画されない。
// (真理値表の tr / td を createElementNS で作って表にならなかったことがある)
// 事故らないように、SVG 用と HTML 用で関数を分けてある。

const SVGNS = 'http://www.w3.org/2000/svg';

/** SVG 要素を作る */
export function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

/** HTML 要素を作る */
export function hel(tag, parent, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  parent?.appendChild(e);
  return e;
}

export const $ = (id) => document.getElementById(id);
