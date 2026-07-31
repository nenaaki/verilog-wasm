// 組合せ回路のトポロジカルソート + 組合せループ検出。
//
// レジスタで回路を切断する:
//   Q 出力は「その場にある値」= ソース、D 入力は「計算結果」= シンク。
// これにより残りは純粋な DAG になる。

import { CompileError } from './errors.js';

export function schedule(netlist) {
  const { nets, gates, regs, signals } = netlist;

  const available = new Uint8Array(nets.length);

  // ソース: 入力ポートのビットと、レジスタの Q
  for (const s of signals.values()) {
    if (s.dir === 'input') s.bits.forEach((n) => (available[n] = 1));
  }
  for (const r of regs) available[r.q] = 1;

  // 各ゲートの未解決入力数と、ネット → 待っているゲートの逆引き
  const pending = new Int32Array(gates.length);
  const waiters = new Map();
  const ready = [];

  gates.forEach((g, gi) => {
    let count = 0;
    for (const n of g.in) {
      if (!available[n]) {
        count++;
        if (!waiters.has(n)) waiters.set(n, []);
        waiters.get(n).push(gi);
      }
    }
    pending[gi] = count;
    if (count === 0) ready.push(gi);
  });

  const order = [];
  while (ready.length > 0) {
    const gi = ready.pop();
    order.push(gi);
    const out = gates[gi].out;
    if (available[out]) continue;
    available[out] = 1;
    for (const w of waiters.get(out) ?? []) {
      if (--pending[w] === 0) ready.push(w);
    }
  }

  if (order.length !== gates.length) {
    const stuck = [];
    gates.forEach((g, gi) => {
      if (pending[gi] > 0) stuck.push(nets[g.out].name);
    });
    throw new CompileError(
      `組合せループを検出しました。関与しているネット: ${stuck.slice(0, 12).join(', ')}${stuck.length > 12 ? ' …' : ''}`,
    );
  }

  return order;
}
