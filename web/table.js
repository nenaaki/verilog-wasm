// 真理値表 / 状態遷移表の描画。
//
// どちらも 64 レーンのビットスライスで作る。全パターンをレーンに並べて
// eval() を 1 回 (メモリがあれば step 相当を 1 回) 呼ぶだけで表が埋まる。
//
// メモリがある回路では「入力 + 現在の Q」を軸にして、出力と次の Q を読む。
// 出力は commit の前・次の Q は commit の後、という順番が要るのがポイント。
//
// レーンを汚すので、最後に画面の入力値とメモリの中身を必ず書き戻す。

import { hel, $ } from './dom.js';
import { LANES } from '../src/signals.js';

export const MAX_TABLE_BITS = 6;   // 2^6 = 64 = レーン数。入力 + メモリの合計ビット数

/**
 * @param {object} plan  toVerilog の結果
 * @param {object} sim   WasmSimulator (未コンパイルなら null)
 * @param {(nodeId: number) => 0|1} inputValue 画面上の入力の値
 */
export function renderTable(plan, sim, inputValue) {
  const t = $('truth');
  t.textContent = '';
  const outs = plan?.outputs.filter((o) => o.kind === 'out') ?? [];
  const regs = plan?.regs ?? [];
  $('tableHead').textContent = regs.length
    ? '状態遷移表（64 レーン同時評価で 1 クロックから作成）'
    : '真理値表（64 レーン同時評価で 1 回の eval から作成）';

  if (!sim || (outs.length === 0 && regs.length === 0)) {
    note(t, sim ? '出力部品かメモリを置くと表が出ます' : '');
    return;
  }
  // 表の軸。1 軸が 1 ビットとは限らないので、幅ぶんのビット位置を割り振る
  const dims = [...plan.inputs, ...regs].map((d) => ({ ...d, w: d.width ?? 1 }));
  let off = 0;
  for (const d of dims) {
    d.off = off;
    d.mask = (1 << d.w) - 1;
    off += d.w;
  }
  const bits = off;
  if (bits > MAX_TABLE_BITS) {
    note(t, `入力とメモリで ${bits} ビット `
      + `(64 レーンに収まるのは ${MAX_TABLE_BITS} ビットまで)`);
    return;
  }

  const saved = regs.map((r) => Number(sim.get(r.name)));
  const rows = 1 << bits;
  for (let lane = 0; lane < LANES; lane++) {
    const pat = lane < rows ? lane : 0;
    for (const d of dims) sim.setInputLane(d.name, lane, (pat >> d.off) & d.mask);
  }
  sim.eval();
  const outCols = outs.map((o) => sim.getLanes(o.name));      // 現在の状態での出力
  let nextCols = [];
  if (regs.length) {
    sim.commit();
    sim.eval();
    nextCols = regs.map((r) => sim.getLanes(r.name));         // クロック後の Q
  }

  // 幅 1 は 0/1、広いときは 16 進 (画面の部品の見せ方と揃える)
  const fmt = (v, w) => (w <= 1 ? String(v ? 1 : 0)
    : v.toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0'));
  const label = (name, w) => (w > 1 ? `${name}[${w - 1}:0]` : name);

  const head = hel('tr', t);
  for (const d of dims) hel('th', head).textContent = label(d.name, d.w);
  hel('th', head, 'gap');
  for (const r of regs) hel('th', head).textContent = `${label(r.name, r.width ?? 1)}'`;
  for (const o of outs) hel('th', head).textContent = label(o.name, o.width ?? 1);

  // 今の入力とメモリの値が何行目かを求めて、その行に印を付ける
  let now = 0;
  for (const d of dims) {
    const v = regs.some((r) => r.node === d.node)
      ? saved[regs.findIndex((r) => r.node === d.node)]
      : inputValue(d.node);
    now |= (v & d.mask) << d.off;
  }

  let nowRow = null;
  for (let r = 0; r < rows; r++) {
    const tr = hel('tr', t, r === now ? 'now' : '');
    if (r === now) nowRow = tr;
    for (const d of dims) {
      const v = (r >> d.off) & d.mask;
      hel('td', tr, v ? 'one' : 'zero').textContent = fmt(v, d.w);
    }
    hel('td', tr, 'gap');
    for (const [i, lanes] of [...nextCols, ...outCols].entries()) {
      const w = (i < nextCols.length ? regs[i] : outs[i - nextCols.length])?.width ?? 1;
      const v = Number(lanes[r]);
      hel('td', tr, v ? 'one' : 'zero').textContent = fmt(v, w);
    }
  }
  nowRow?.scrollIntoView({ block: 'nearest' });   // 64 行あると印が画面外に行くので

  // レーンを汚したので書き戻す
  regs.forEach((r, i) => sim.setInput(r.name, saved[i]));
  for (const i of plan.inputs) sim.setInput(i.name, inputValue(i.node));
  sim.eval();
}

function note(table, text) {
  if (!text) return;
  const td = hel('td', hel('tr', table));
  td.textContent = text;
  td.style.color = 'var(--dim)';
  td.style.border = '0';
}
