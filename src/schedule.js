// 組合せ回路のトポロジカルソート + 組合せループ検出 + 到達不能ゲートの刈り取り。
//
// レジスタで回路を切断する:
//   Q 出力は「その場にある値」= ソース、D 入力は「計算結果」= シンク。
// これにより残りは純粋な DAG になる。
//
// 返す order がそのままコード生成の対象になる。ループ検出は「全ゲートを並べ切れたか」
// で見るので、刈り取りは並べ切ってから最後にやる (順番を逆にすると、到達不能な
// 組合せループを見逃すようになる)。

import { CompileError } from './errors.js';

export function schedule(netlist) {
  const { nets, gates, regs, signals } = netlist;

  const available = new Uint8Array(nets.length);

  // ソース: top の入力ポートのビットと、レジスタの Q。
  // 子モジュールの入力ポートはソースではない (親から buf で駆動されるので、
  // ここでソース扱いすると順序が付かないまま並べてしまう)
  for (const s of signals.values()) {
    if (s.isTop !== false && s.dir === 'input') s.bits.forEach((n) => (available[n] = 1));
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

  return order.filter(reachable(netlist));
}

/**
 * 出力ポートとレジスタの D から逆向きに辿って、そこに届くゲートだけを残す判定を返す。
 *
 * 外から見えるネットは線形メモリにスロットを持つものだけ (入力ポート・出力ポート・
 * レジスタの Q) で、内部の組合せ配線は WASM の local に載るだけ ([layout.js] 参照)。
 * つまり「出力にもレジスタにも届かないゲート」は誰にも観測されないので、評価しなくても
 * 外から見た挙動は変わらない。local は残るが値が 0 のままになるだけで、読む人がいない。
 *
 * 消えるのは主に、幅の広い式を狭い左辺に代入したときの上位ビット、条件付き代入を後の
 * 無条件代入が上書きしたときの mux 木、使われなかった $const0 / $const1。
 */
function reachable(netlist) {
  const { nets, gates, regs, signals } = netlist;

  // ネット → それを駆動しているゲート (無ければ -1。入力ポートとレジスタ Q がこれ)
  const driver = new Int32Array(nets.length).fill(-1);
  gates.forEach((g, gi) => { driver[g.out] = gi; });

  const live = new Uint8Array(gates.length);
  const stack = [];
  for (const s of signals.values()) {
    if (s.dir === 'output') stack.push(...s.bits);
  }
  for (const r of regs) {
    stack.push(r.d);
    if (r.qAsync != null) stack.push(r.qAsync);   // 非同期リセットの書き戻しも根
  }

  while (stack.length > 0) {
    const gi = driver[stack.pop()];
    if (gi < 0 || live[gi]) continue;
    live[gi] = 1;
    for (const n of gates[gi].in) stack.push(n);
  }

  return (gi) => live[gi] === 1;
}
