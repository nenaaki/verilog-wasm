// 波形パネルの描画。
//
// 1 列 = クロック 1 回。組合せ回路にはクロックがないので、入力を変えるたびに 1 列進める
// (列の意味が変わるので、パネル右端にどちらのモードかを出す)。
// 履歴 (frames) の持ち方は呼び出し側の責任で、ここは受け取った配列を描くだけ。

import { el, $ } from './dom.js';

export const WAVE = { colW: 26, rowH: 24, top: 16, nameW: 116, max: 256 };

/**
 * @param {Array} frames 列。[{ label, v: { 信号名: 0|1|null } }]
 * @param {Array} rows   行。[{ name, kind }] kind は in / reg / block / out / gate
 * @param {{perClock: boolean, ready: boolean}} opts
 *   perClock … 1 列 = 1 クロックか (組合せ回路では入力の変更回数)
 *   ready    … コンパイルが通っているか (空のときの案内を出し分ける)
 */
export function renderWave(frames, rows, { perClock, ready }) {
  const names = $('waveNames'), svg = $('waveSvg');
  names.textContent = svg.textContent = '';
  const cols = frames.length;

  $('waveInfo').textContent = cols
    ? `${cols} 列 / ${rows.length} 信号`
      + `${perClock ? '（1 列 = 1 クロック）' : '（1 列 = 入力を変えた回数）'}`
    : '';

  const h = WAVE.top + rows.length * WAVE.rowH + 6;
  names.setAttribute('width', WAVE.nameW);
  names.setAttribute('height', h);
  svg.setAttribute('width', Math.max(cols * WAVE.colW + 8, 40));
  svg.setAttribute('height', h);

  if (rows.length === 0 || cols === 0) {
    el('text', { class: 'note', x: 8, y: 20 }, svg).textContent =
      ready ? 'クロックを打つか入力を変えると波形が出ます' : '';
    return;
  }

  rows.forEach((r, i) => {
    const y = WAVE.top + i * WAVE.rowH;
    el('text', { class: r.kind, x: 8, y: y + WAVE.rowH / 2 }, names).textContent = r.name;
    el('line', { class: 'lane', x1: 0, y1: y, x2: cols * WAVE.colW, y2: y }, svg);
  });

  // 列の境界とサイクル番号
  for (let c = 0; c < cols; c++) {
    const x = c * WAVE.colW;
    el('line', { class: 'edge', x1: x, y1: WAVE.top, x2: x, y2: h - 6 }, svg);
    if (cols <= 40 || c % 4 === 0) {
      el('text', { class: 'cyc', x: x + WAVE.colW / 2, y: 9 }, svg).textContent = frames[c].label;
    }
  }

  // 各信号の階段波形。値が不明な区間は破線で中央に引く
  rows.forEach((r, i) => {
    const y = WAVE.top + i * WAVE.rowH;
    const hi = y + 5, lo = y + WAVE.rowH - 7, mid = (hi + lo) / 2;
    const at = (c) => frames[c].v[r.name];
    const level = (c) => (at(c) === null || at(c) === undefined ? mid : at(c) ? hi : lo);
    const unknown = frames.some((f) => f.v[r.name] === null || f.v[r.name] === undefined);

    let d = `M 0 ${level(0)}`;
    for (let c = 0; c < cols; c++) {
      d += ` L ${c * WAVE.colW} ${level(c)} L ${(c + 1) * WAVE.colW} ${level(c)}`;
    }
    // data-bits は目で見る用ではなく、テストと動作確認から値を読むためのもの
    el('path', {
      class: `sig ${unknown ? 'unknown' : ''}`, d,
      'data-sig': r.name,
      'data-bits': frames.map((f) => f.v[r.name] ?? 'x').join(''),
    }, svg);
  });

  $('waveScroll').scrollLeft = $('waveScroll').scrollWidth;
}
