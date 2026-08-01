// テストランナー。node test/run.js
//
// 中核は「WASM バックエンド vs JS 参照実装」の差分テスト。
// ランダムな回路 × ランダムな入力で両者の出力が一致することを確認する。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compile, CompileError } from '../src/compile.js';
import { WasmSimulator } from '../src/sim.js';
import { RefSimulator } from '../src/interp.js';
import {
  SAMPLE_CIRCUITS, checkName, decodeCircuit, encodeCircuit, expandCircuit, packCircuit, toVerilog,
} from '../src/schematic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const example = (n) => readFileSync(join(HERE, '..', 'examples', n), 'utf8');

let passed = 0;
const failures = [];

function ok(cond, label, detail = '') {
  if (cond) passed++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

/** 文字列や個数の比較 (eq は BigInt に寄せるので分けてある) */
function eqs(actual, expected, label) {
  ok(actual === expected, label, actual === expected ? '' : `期待 ${expected} / 実際 ${actual}`);
}

function eq(actual, expected, label) {
  const a = typeof actual === 'bigint' ? actual : BigInt(actual);
  const e = typeof expected === 'bigint' ? expected : BigInt(expected);
  ok(a === e, label, a === e ? '' : `期待 ${e} / 実際 ${a}`);
}

async function bothSims(src) {
  const compiled = compile(src);
  const wasm = await WasmSimulator.create(compiled);
  const ref = new RefSimulator(compiled);
  return { compiled, wasm, ref, all: [wasm, ref] };
}

// ---------------------------------------------------------------- 全加算器
async function testFullAdder() {
  const { compiled, all } = await bothSims(example('full_adder.v'));
  ok(compiled.stats.regs === 0, '全加算器: レジスタなし', `regs=${compiled.stats.regs}`);

  for (const sim of all) {
    const kind = sim.constructor.name;
    for (let v = 0; v < 8; v++) {
      const a = v & 1, b = (v >> 1) & 1, cin = (v >> 2) & 1;
      sim.setInput('a', a).setInput('b', b).setInput('cin', cin);
      sim.step();
      const total = a + b + cin;
      eq(sim.get('sum'), total & 1, `${kind} 全加算器 sum(${a},${b},${cin})`);
      eq(sim.get('cout'), total >> 1, `${kind} 全加算器 cout(${a},${b},${cin})`);
    }
  }
}

// ------------------------------------------------------ ゲートプリミティブ
async function testGates() {
  const { all } = await bothSims(example('gates.v'));
  for (const sim of all) {
    const kind = sim.constructor.name;
    for (let v = 0; v < 4; v++) {
      const a = v & 1, b = (v >> 1) & 1;
      sim.setInput('a', a).setInput('b', b).step();
      eq(sim.get('y_and'), a & b, `${kind} and(${a},${b})`);
      eq(sim.get('y_or'), a | b, `${kind} or(${a},${b})`);
      eq(sim.get('y_xor'), a ^ b, `${kind} xor(${a},${b})`);
      eq(sim.get('y_nand'), (a & b) ^ 1, `${kind} nand(${a},${b})`);
      eq(sim.get('y_nor'), (a | b) ^ 1, `${kind} nor(${a},${b})`);
      eq(sim.get('y_xnor'), (a ^ b) ^ 1, `${kind} xnor(${a},${b})`);
      eq(sim.get('y_not'), a ^ 1, `${kind} not(${a})`);
    }
  }
}

// -------------------------------------------------------------------- DFF
async function testDff() {
  const src = `
    module dff(input clk, input d, output reg q);
      always @(posedge clk) q <= d;
    endmodule`;
  const { all } = await bothSims(src);
  for (const sim of all) {
    const kind = sim.constructor.name;
    sim.reset();
    sim.setInput('d', 1);
    eq(sim.get('q'), 0, `${kind} DFF: クロック前は 0`);
    sim.step();
    eq(sim.get('q'), 1, `${kind} DFF: 1 クロックで取り込む`);
    sim.setInput('d', 0);
    eq(sim.get('q'), 1, `${kind} DFF: d 変化はクロックまで無反応`);
    sim.step();
    eq(sim.get('q'), 0, `${kind} DFF: 次のクロックで 0`);
  }
}

// -------------------------------------------------------- シフトレジスタ
async function testShift8() {
  const { all } = await bothSims(example('shift8.v'));
  for (const sim of all) {
    const kind = sim.constructor.name;
    sim.reset();
    // 1,0,1,1 を順に投入 → q の上位から詰まっていく
    for (const d of [1, 0, 1, 1]) sim.setInput('din', d).step();
    eq(sim.get('q'), 0b11010000, `${kind} shift8: 4 クロック後のパターン`);
    sim.setInput('din', 0).run(4);
    eq(sim.get('q'), 0b00001101, `${kind} shift8: さらに 4 クロックで下位へ`);
    sim.run(4);
    eq(sim.get('q'), 0, `${kind} shift8: 8 クロックで押し出される`);
  }
}

// ------------------------------------------------- イネーブル付きレジスタ
async function testRegEn() {
  const { all } = await bothSims(example('reg_en.v'));
  for (const sim of all) {
    const kind = sim.constructor.name;
    sim.reset();
    sim.setInput('d', 0b1010).setInput('en', 1).step();
    eq(sim.get('q'), 0b1010, `${kind} reg_en: en=1 でロード`);
    sim.setInput('d', 0b0101).setInput('en', 0).run(5);
    eq(sim.get('q'), 0b1010, `${kind} reg_en: en=0 で保持`);
    sim.setInput('en', 1).step();
    eq(sim.get('q'), 0b0101, `${kind} reg_en: en=1 で更新`);
  }
}

// ------------------------------------------------------------------ LFSR
async function testLfsr() {
  const { compiled, wasm, ref } = await bothSims(example('lfsr8.v'));

  // 周期 255 を確認 (レジスタ q はシード用に書き込み可能)
  wasm.reset().setInput('q', 1);
  const seen = new Set();
  for (let i = 0; i < 255; i++) {
    const v = wasm.get('q');
    ok(!seen.has(v.toString()), 'LFSR: 状態が重複しない', `${i} 周目で ${v} が再出現`);
    seen.add(v.toString());
    wasm.step();
  }
  eq(wasm.get('q'), 1, 'LFSR: 255 クロックで初期状態に戻る');
  ok(seen.size === 255, 'LFSR: 255 個の異なる状態', `size=${seen.size}`);

  // WASM と参照実装の状態列が完全一致するか
  wasm.reset().setInput('q', 0xa5);
  ref.reset().setInput('q', 0xa5);
  let match = true;
  for (let i = 0; i < 600; i++) {
    wasm.step();
    ref.step();
    if (wasm.get('q') !== ref.get('q')) { match = false; break; }
  }
  ok(match, 'LFSR: WASM と参照実装が 600 クロック一致');
  ok(compiled.stats.regs === 8, 'LFSR: レジスタ 8 ビット', `regs=${compiled.stats.regs}`);
}

// ------------------------------------------------ ビットスライス (64 レーン)
async function testLanes() {
  const { wasm } = await bothSims(example('full_adder.v'));

  // 64 レーンにそれぞれ違う入力を入れて、1 回の step で 64 パターン評価する
  for (let lane = 0; lane < 64; lane++) {
    wasm.setInputLane('a', lane, lane & 1);
    wasm.setInputLane('b', lane, (lane >> 1) & 1);
    wasm.setInputLane('cin', lane, (lane >> 2) & 1);
  }
  wasm.step();

  let allOk = true;
  for (let lane = 0; lane < 64; lane++) {
    const a = lane & 1, b = (lane >> 1) & 1, cin = (lane >> 2) & 1;
    const total = a + b + cin;
    if (wasm.get('sum', lane) !== BigInt(total & 1)) allOk = false;
    if (wasm.get('cout', lane) !== BigInt(total >> 1)) allOk = false;
  }
  ok(allOk, 'ビットスライス: 64 レーンが独立に正しい');

  // レジスタも 64 レーン独立に動くこと
  const { wasm: sr } = await bothSims(example('shift8.v'));
  sr.reset();
  for (let lane = 0; lane < 64; lane++) sr.setInputLane('din', lane, lane & 1);
  sr.step();
  let laneRegOk = true;
  for (let lane = 0; lane < 64; lane++) {
    const expect = (lane & 1) ? 0b10000000n : 0n;
    if (sr.get('q', lane) !== expect) laneRegOk = false;
  }
  ok(laneRegOk, 'ビットスライス: レジスタも 64 レーン独立');
}

// ------------------------------- レジスタのスワップ (同時代入の要検証ケース)
// a <= b; b <= a; は D ネットが相手の Q ネットそのものになる。
// 次状態スロットを D ネットごとに共有すると commit が逐次代入になって壊れる。
async function testSwap() {
  const src = `
    module swap(input clk, output reg [3:0] a, output reg [3:0] b);
      always @(posedge clk) begin
        a <= b;
        b <= a;
      end
    endmodule`;
  const { all } = await bothSims(src);
  for (const sim of all) {
    const kind = sim.constructor.name;
    sim.reset().setInput('a', 5).setInput('b', 10);
    sim.step();
    eq(sim.get('a'), 10, `${kind} スワップ: a が入れ替わる`);
    eq(sim.get('b'), 5, `${kind} スワップ: b が入れ替わる`);
    sim.step();
    eq(sim.get('a'), 5, `${kind} スワップ: 2 クロックで元に戻る`);
    eq(sim.get('b'), 10, `${kind} スワップ: 2 クロックで元に戻る (b)`);
  }

  // 3 段のローテーションも同様に壊れやすい
  const rot = `
    module rot(input clk, output reg [3:0] x, output reg [3:0] y, output reg [3:0] z);
      always @(posedge clk) begin
        x <= y;
        y <= z;
        z <= x;
      end
    endmodule`;
  const { all: rots } = await bothSims(rot);
  for (const sim of rots) {
    const kind = sim.constructor.name;
    sim.reset().setInput('x', 1).setInput('y', 2).setInput('z', 3);
    sim.step();
    eq(sim.get('x'), 2, `${kind} 3段ローテート x`);
    eq(sim.get('y'), 3, `${kind} 3段ローテート y`);
    eq(sim.get('z'), 1, `${kind} 3段ローテート z`);
    sim.run(2);
    eq(sim.get('x'), 1, `${kind} 3段ローテート: 3 クロックで一巡 x`);
    eq(sim.get('z'), 3, `${kind} 3段ローテート: 3 クロックで一巡 z`);
  }
}

// --------------------------------------------- eval / commit の分離
async function testEvalCommit() {
  // 純粋な組合せ回路は eval() だけで出力が確定する
  const { all } = await bothSims(example('full_adder.v'));
  for (const sim of all) {
    const kind = sim.constructor.name;
    sim.reset().setInput('a', 1).setInput('b', 1).setInput('cin', 0);
    sim.eval();
    eq(sim.get('sum'), 0, `${kind} eval: 組合せ出力が確定 (sum)`);
    eq(sim.get('cout'), 1, `${kind} eval: 組合せ出力が確定 (cout)`);
  }

  // eval() はレジスタを更新しない。commit() で初めて動く
  const dff = `module dff(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule`;
  const { all: dffs } = await bothSims(dff);
  for (const sim of dffs) {
    const kind = sim.constructor.name;
    sim.reset().setInput('d', 1);
    sim.eval();
    eq(sim.get('q'), 0, `${kind} eval: レジスタは変化しない`);
    sim.eval().eval().eval();
    eq(sim.get('q'), 0, `${kind} eval: 何回呼んでもレジスタは変化しない`);
    sim.commit();
    eq(sim.get('q'), 1, `${kind} commit: ここで初めて Q が更新される`);
  }

  // step() 後、レジスタから派生した組合せ出力もエッジ後の状態と整合していること
  const derived = `
    module derived(input clk, input d, output reg q, output y, output z);
      assign y = ~q;
      assign z = q ^ d;
      always @(posedge clk) q <= d;
    endmodule`;
  const { all: ds } = await bothSims(derived);
  for (const sim of ds) {
    const kind = sim.constructor.name;
    sim.reset().setInput('d', 1);
    sim.step();
    eq(sim.get('q'), 1, `${kind} step 後: q`);
    eq(sim.get('y'), 0, `${kind} step 後: 派生出力 y がエッジ後の q と整合`);
    eq(sim.get('z'), 0, `${kind} step 後: 派生出力 z がエッジ後の q と整合`);
    sim.setInput('d', 0);
    sim.run(1);
    eq(sim.get('q'), 0, `${kind} run 後: q`);
    eq(sim.get('y'), 1, `${kind} run 後: 派生出力 y がエッジ後の q と整合`);
  }
}

// ------------------------------------------------------------ エラー検出
async function testErrors() {
  const cases = [
    ['組合せループ',
      `module m(input a, output y); wire t; assign t = a & y; assign y = t; endmodule`,
      /組合せループ/],
    ['未宣言信号',
      `module m(input a, output y); assign y = a & zzz; endmodule`,
      /未宣言の信号/],
    ['多重ドライブ',
      `module m(input a, b, output y); assign y = a; assign y = b; endmodule`,
      /多重にドライブ/],
    ['assign で reg を駆動',
      `module m(input clk, a, output reg q); assign q = a; endmodule`,
      /assign で reg/],
    ['always で wire を駆動',
      `module m(input clk, a, output y); always @(posedge clk) y <= a; endmodule`,
      /reg 宣言が必要/],
    ['範囲外のビット選択',
      `module m(input [3:0] a, output y); assign y = a[7]; endmodule`,
      /宣言範囲/],
    ['negedge は未対応',
      `module m(input clk, a, output reg q); always @(negedge clk) q <= a; endmodule`,
      /negedge/],
    ['ブロッキング代入の誤用',
      `module m(input clk, a, output reg q); always @(posedge clk) q = a; endmodule`,
      /ノンブロッキング/],
    ['モジュール階層は未対応',
      `module m(input a, output y); sub u0(y, a); endmodule`,
      /未対応/],
  ];

  for (const [label, src, pattern] of cases) {
    let caught = null;
    try { compile(src); } catch (e) { caught = e; }
    if (!caught) ok(false, `エラー検出: ${label}`, 'エラーにならなかった');
    else ok(caught instanceof CompileError && pattern.test(caught.message),
      `エラー検出: ${label}`, `実際のメッセージ: ${caught.message}`);
  }
}

// ------------------------------------------- ランダム回路の差分テスト
function makeRng(seed) {
  let s = seed | 0;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}

function randomDesign(rng, nWires) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const pool = ['a', 'b', 'c'];
  const lines = [];

  const expr = (depth) => {
    const r = rng();
    if (depth <= 0 || r < 0.25) {
      const s = pick(pool);
      const k = rng();
      if (k < 0.2) return `${s}[${Math.floor(rng() * 8)}]`;
      if (k < 0.35) {
        const hi = Math.floor(rng() * 8);
        const lo = Math.floor(rng() * (hi + 1));
        return `${s}[${hi}:${lo}]`;
      }
      if (k < 0.45) return `8'h${Math.floor(rng() * 256).toString(16)}`;
      if (k < 0.5) return `1'b${Math.floor(rng() * 2)}`;
      return s;
    }
    if (r < 0.45) return `(~${expr(depth - 1)})`;
    if (r < 0.6) return `(${expr(depth - 1)} & ${expr(depth - 1)})`;
    if (r < 0.72) return `(${expr(depth - 1)} | ${expr(depth - 1)})`;
    if (r < 0.84) return `(${expr(depth - 1)} ^ ${expr(depth - 1)})`;
    if (r < 0.93) return `(${expr(depth - 1)} ? ${expr(depth - 1)} : ${expr(depth - 1)})`;
    return `{${expr(depth - 1)}, ${expr(depth - 1)}}`;
  };

  for (let i = 0; i < nWires; i++) {
    lines.push(`  wire [7:0] w${i};`);
    lines.push(`  assign w${i} = ${expr(3)};`);
    pool.push(`w${i}`);
  }

  // レジスタ (状態) も混ぜる。r は pool に入れて組合せ側からも参照させる
  lines.unshift('  reg [7:0] r;');
  pool.push('r');
  const regExpr = expr(3);
  lines.push(`  always @(posedge clk) r <= ${regExpr};`);
  lines.push(`  assign y = ${expr(3)};`);

  return `module rnd(
  input clk,
  input [7:0] a,
  input [7:0] b,
  input [7:0] c,
  output [7:0] y,
  output [7:0] rout
);
${lines.join('\n')}
  assign rout = r;
endmodule`;
}

async function testRandomDiff() {
  const rng = makeRng(20260731);
  let designs = 0;
  let mismatch = null;

  for (let d = 0; d < 25 && !mismatch; d++) {
    const src = randomDesign(rng, 6);
    let compiled;
    try {
      compiled = compile(src);
    } catch (e) {
      // ランダム生成が組合せループを作ることはない構造だが、念のため記録して継続
      failures.push(`ランダム差分: コンパイル失敗 ${e.message}\n${src}`);
      continue;
    }
    designs++;
    const wasm = await WasmSimulator.create(compiled);
    const ref = new RefSimulator(compiled);

    for (let t = 0; t < 12 && !mismatch; t++) {
      const a = Math.floor(rng() * 256);
      const b = Math.floor(rng() * 256);
      const c = Math.floor(rng() * 256);
      for (const sim of [wasm, ref]) sim.setInput('a', a).setInput('b', b).setInput('c', c);
      wasm.step();
      ref.step();
      for (const port of ['y', 'rout']) {
        if (wasm.get(port) !== ref.get(port)) {
          mismatch = `${port}: wasm=${wasm.get(port)} ref=${ref.get(port)} (a=${a} b=${b} c=${c} t=${t})\n${src}`;
        }
      }
    }
  }

  ok(designs === 25, 'ランダム差分: 25 回路すべてコンパイルできた', `designs=${designs}`);
  ok(!mismatch, `ランダム差分テスト (${designs} 回路 × 12 ベクタ)`, mismatch ?? '');
}

// ------------------------------------------------------------- WAT 出力
async function testWat() {
  const compiled = compile(example('reg_en.v'));
  ok(compiled.wat.includes('(module'), 'WAT: module を出力');
  ok(compiled.wat.includes('(func $step (export "step")'), 'WAT: step 関数を出力');
  ok(compiled.wat.includes('i64.store'), 'WAT: 状態の書き戻しがある');
  ok(/i64\.and/.test(compiled.wat), 'WAT: 論理演算がある');
}

// -------------------------------------- GUI 回路エディタ (グラフ → Verilog)
async function testSchematic() {
  // サンプル回路が全部コンパイルできて、期待どおりの真理値表になること
  for (const [name, c] of Object.entries(SAMPLE_CIRCUITS)) {
    const { source, inputs, outputs } = toVerilog(expandCircuit(c));
    ok(source !== null, `回路グラフ ${name}: Verilog を生成`);

    if (c.loop) {
      let err = null;
      try { compile(source); } catch (e) { err = e; }
      ok(err instanceof CompileError && /組合せループ/.test(err.message),
        `回路グラフ ${name}: 組合せループを検出`, err?.message ?? 'エラーが出なかった');
      continue;
    }

    const { all } = await bothSims(source);

    // メモリを含む回路: 入力を変えながらクロックを打って追いかける
    if (c.seq) {
      for (const sim of all) {
        const kind = sim.constructor.name;
        sim.reset();
        c.seq.forEach((frame, k) => {
          for (const [signal, v] of Object.entries(frame.set ?? {})) sim.setInput(signal, v);
          sim.eval();
          for (let i = 0; i < (frame.clock ?? 0); i++) sim.step();
          for (const [signal, v] of Object.entries(frame.expect)) {
            eq(sim.get(signal), v, `${kind} 回路グラフ ${name}: ${signal} (${k} 番目のフレーム)`);
          }
        });
      }
      continue;
    }

    for (const sim of all) {
      for (let pat = 0; pat < (1 << inputs.length); pat++) {
        inputs.forEach((i, b) => sim.setInput(i.name, (pat >> b) & 1));
        sim.eval();
        for (const [signal, table] of Object.entries(c.expect)) {
          eq(sim.get(signal), table[pat],
            `${sim.constructor.name} 回路グラフ ${name}: ${signal}(pat=${pat})`);
        }
      }
    }
    // 期待値を書いた出力が実際にポートとして出ていること
    for (const signal of Object.keys(c.expect)) {
      ok(outputs.some((o) => o.name === signal && o.kind === 'out'),
        `回路グラフ ${name}: ${signal} が出力ポートにある`);
    }
  }

  // メモリは output reg として宣言され、暗黙のクロックが生える
  const mem = toVerilog(expandCircuit(SAMPLE_CIRCUITS['クロックで反転する 1 ビットメモリ']));
  ok(/^\s+input\s+clk,?$/m.test(mem.source), '回路グラフ: メモリを置くと clk が生える', mem.source);
  ok(/output reg q,/.test(mem.source), '回路グラフ: メモリは output reg', mem.source);
  ok(/always @\(posedge clk\)/.test(mem.source), '回路グラフ: posedge で駆動', mem.source);
  eq(mem.regs.length, 1, '回路グラフ: regs にメモリが 1 個');
  eq(compile(mem.source).stats.regs, 1, '回路グラフ: ネットリスト上も 1 ビット');

  // メモリを使わない回路にはクロックを生やさない
  const comb = toVerilog(expandCircuit(SAMPLE_CIRCUITS['AND ゲート']));
  ok(!comb.source.includes('clk'), '回路グラフ: 組合せ回路に clk は出ない', comb.source);
  eq(comb.regs.length, 0, '回路グラフ: regs は空');

  // D が未配線のメモリは下流ごと除外される
  const openD = toVerilog({
    nodes: [{ id: 1, type: 'dff' }, { id: 2, type: 'out' }],
    wires: [{ from: { node: 1, port: 0 }, to: { node: 2, port: 0 } }],
  });
  eq(openD.incomplete.size, 2, '回路グラフ: D 未配線のメモリと下流を除外');
  ok(openD.source === null, '回路グラフ: 残るものが無ければソースを作らない');

  // メモリを挟んだフィードバックは組合せループにならない
  const looped = toVerilog(expandCircuit(SAMPLE_CIRCUITS['クロックで反転する 1 ビットメモリ']));
  eq(looped.incomplete.size, 0, '回路グラフ: メモリ経由の帰還は未完成にしない');

  // バレルシフタ: 論理左シフトになっていること (全 64 パターン × 4 ビット)
  const barrel = SAMPLE_CIRCUITS['4 ビットバレルシフタ (論理左シフト)'];
  const bs = toVerilog(expandCircuit(barrel));
  eq(bs.inputs.length, 6, 'バレルシフタ: 入力はデータ 4 + シフト量 2');
  ok(bs.inputs.map((i) => i.name).join(',') === 'd0,d1,d2,d3,s0,s1',
    'バレルシフタ: 付けた名前がそのまま入力名になる', bs.inputs.map((i) => i.name).join(','));
  ok(/assign \w+ = 1'b0;/.test(bs.source), 'バレルシフタ: 定数 0 がリテラルになる');
  const bsc = compile(bs.source);
  ok(bsc.stats.regs === 0, 'バレルシフタ: 組合せ回路', `regs=${bsc.stats.regs}`);
  const bsim = await WasmSimulator.create(bsc);
  let mismatch = 0;
  for (let pat = 0; pat < 64; pat++) {
    bs.inputs.forEach((i, b) => bsim.setInputLane(i.name, pat, (pat >> b) & 1));
  }
  bsim.eval();   // 64 レーンで 64 パターンを一度に評価する
  for (let bit = 0; bit < 4; bit++) {
    const lanes = bsim.getLanes(`y${bit}`);
    for (let pat = 0; pat < 64; pat++) {
      if (Number(lanes[pat]) !== barrel.expect[`y${bit}`][pat]) mismatch++;
    }
  }
  eq(mismatch, 0, 'バレルシフタ: 64 パターン × 4 ビットが論理左シフトと一致');

  // ---- 端子の名前 ----
  const named = toVerilog({
    nodes: [
      { id: 1, type: 'in', name: 'sel' }, { id: 2, type: 'in' },      // 2 は自動名
      { id: 3, type: 'and' }, { id: 4, type: 'out', name: 'result' },
    ],
    wires: [
      { from: { node: 1, port: 0 }, to: { node: 3, port: 0 } },
      { from: { node: 2, port: 0 }, to: { node: 3, port: 1 } },
      { from: { node: 3, port: 0 }, to: { node: 4, port: 0 } },
    ],
  });
  eqs(named.inputs.map((i) => i.name).join(','), 'sel,a', '名前: 付けた名前と自動名が混ざる');
  ok(named.source.includes('assign result = '), '名前: 出力名が Verilog に出る', named.source);
  const { wasm: nw } = await bothSims(named.source);
  nw.setInput('sel', 1).setInput('a', 1).eval();
  eq(nw.get('result'), 1, '名前: 付けた名前で読める');

  // 自動名は「空いている名前」を取る (手で 'a' を使っていたら次は 'b')
  const collide = toVerilog({
    nodes: [{ id: 1, type: 'in', name: 'a' }, { id: 2, type: 'in' }, { id: 3, type: 'out', name: 'y0' }, { id: 4, type: 'out' }],
    wires: [{ from: { node: 1, port: 0 }, to: { node: 3, port: 0 } }, { from: { node: 2, port: 0 }, to: { node: 4, port: 0 } }],
  });
  eqs(collide.inputs.map((i) => i.name).join(','), 'a,b', '名前: 自動名は重複を避ける');
  eqs(collide.outputs.map((o) => o.name).join(','), 'y0,y1', '名前: 出力の自動名も重複を避ける');

  // 無効な名前は自動名にまわす (GUI で弾くが、通っても Verilog は壊れない)
  const bad = toVerilog({
    nodes: [
      { id: 1, type: 'in', name: 'clk' },     // 予約語
      { id: 2, type: 'in', name: '1st' },     // 識別子として無効
      { id: 3, type: 'in', name: 'ok_1' },
    ],
    wires: [],
  });
  eqs(bad.inputs.map((i) => i.name).join(','), 'a,b,ok_1', '名前: 無効な名前は自動名になる');
  for (const [name, why] of [['clk', '予約語'], ['1st', '識別子でない'], ['x y', '空白入り'], ['', '空']]) {
    ok(checkName(name) !== null, `名前: ${why} を弾く (${name})`);
  }
  ok(checkName('q_2$') === null, '名前: Verilog の識別子は通す');
  ok(checkName('q', new Set(['q'])) !== null, '名前: 重複を弾く');

  // ---- 保存形式 (pack / expand / リンク) ----
  for (const [name, c] of Object.entries(SAMPLE_CIRCUITS)) {
    const g = expandCircuit(c);
    const round = expandCircuit(packCircuit(g));
    eqs(JSON.stringify(round), JSON.stringify(g), `保存形式: ${name} が往復して一致する`);
    eqs(JSON.stringify(decodeCircuit(encodeCircuit(g))), JSON.stringify(g),
      `保存形式: ${name} がリンク経由でも一致する`);
  }
  ok(encodeCircuit(expandCircuit(SAMPLE_CIRCUITS['AND ゲート'])).length < 200,
    '保存形式: 小さい回路のリンクは短い',
    String(encodeCircuit(expandCircuit(SAMPLE_CIRCUITS['AND ゲート'])).length));
  ok(!/[+/=]/.test(encodeCircuit(expandCircuit(SAMPLE_CIRCUITS['多数決 (3 入力のうち 2 つ以上が 1)']))),
    '保存形式: URL に置ける文字だけを使う');

  // 名前と値も残る
  const withName = expandCircuit(packCircuit({
    nodes: [{ id: 3, type: 'in', x: 10, y: 20, value: 1, name: 'sel' },
      { id: 4, type: 'dff', x: 30, y: 40, value: 0 }],
    wires: [{ from: { node: 3, port: 0 }, to: { node: 4, port: 0 } }],
  }));
  eqs(withName.nodes[0].name, 'sel', '保存形式: 端子の名前が残る');
  eq(withName.nodes[0].value, 1, '保存形式: 入力の値が残る');
  eqs(withName.nodes[1].name, undefined, '保存形式: 名前なしは名前なしのまま');
  eq(withName.wires.length, 1, '保存形式: 配線が残る');

  // 壊れたデータは理由を付けて弾く
  for (const [data, why] of [
    [null, 'null'],
    [{}, 'nodes が無い'],
    [{ nodes: [], wires: {} }, 'wires が配列でない'],
    [{ nodes: [[0, 'in', 0, 0]], wires: [] }, 'id が 0'],
    [{ nodes: [[1.5, 'in', 0, 0]], wires: [] }, 'id が整数でない'],
    [{ nodes: [[1, 'zzz', 0, 0]], wires: [] }, '知らない部品'],
    [{ nodes: [[1, 'in', 0, 0], [1, 'out', 0, 0]], wires: [] }, 'id の重複'],
    [{ nodes: 'x', wires: [] }, 'nodes が配列でない'],
  ]) {
    let err = null;
    try { expandCircuit(data); } catch (e) { err = e; }
    ok(err !== null, `保存形式: ${why} を弾く`, err ? '' : '通ってしまった');
  }
  let tooBig = null;
  try {
    expandCircuit({ nodes: Array.from({ length: 501 }, (_, i) => [i + 1, 'in', 0, 0]), wires: [] });
  } catch (e) { tooBig = e; }
  ok(tooBig !== null && /多すぎ/.test(tooBig.message), '保存形式: 部品が多すぎるものを弾く');

  // 筋の通らない配線は黙って捨てる (回路自体は開けたほうが良い)
  const dropped = expandCircuit({
    nodes: [[1, 'in', 0, 0], [2, 'and', 0, 0], [3, 'out', 0, 0]],
    wires: [
      [1, 0, 2, 0],
      [1, 0, 99, 0],       // 行き先が無い
      [1, 0, 2, 5],        // 端子番号が範囲外
      [1, 1, 2, 1],        // 出力端子は 0 しかない
      [3, 0, 2, 1],        // 出力部品に出力端子は無い
      [1, 0, 2, 0],        // 同じ入力端子への 2 本目
    ],
  });
  eq(dropped.wires.length, 1, '保存形式: 通らない配線は捨てる');

  // 座標が壊れていても落ちない
  const coords = expandCircuit({ nodes: [[1, 'in', NaN, '9', 0], [2, 'in', -50, 99999, 0]], wires: [] });
  eq(coords.nodes[0].x, 0, '保存形式: NaN の座標は 0 に');
  eq(coords.nodes[1].x, 0, '保存形式: 負の座標は 0 に');
  ok(coords.nodes[1].y <= 4000, '保存形式: 大きすぎる座標は丸める', String(coords.nodes[1].y));

  let brokenLink = null;
  try { decodeCircuit('これはbase64ではない###'); } catch (e) { brokenLink = e; }
  ok(brokenLink !== null, '保存形式: 壊れたリンクを弾く');

  // ---- 定数 ----
  const konst = toVerilog({
    nodes: [
      { id: 1, type: 'const', value: 0 }, { id: 2, type: 'const', value: 1 },
      { id: 3, type: 'or' }, { id: 4, type: 'out', name: 'y' },
      { id: 5, type: 'and' }, { id: 6, type: 'out', name: 'z' },
    ],
    wires: [
      { from: { node: 1, port: 0 }, to: { node: 3, port: 0 } },
      { from: { node: 2, port: 0 }, to: { node: 3, port: 1 } },
      { from: { node: 1, port: 0 }, to: { node: 5, port: 0 } },
      { from: { node: 2, port: 0 }, to: { node: 5, port: 1 } },
      { from: { node: 3, port: 0 }, to: { node: 4, port: 0 } },
      { from: { node: 5, port: 0 }, to: { node: 6, port: 0 } },
    ],
  });
  eqs(konst.inputs.length, 0, '定数: 入力ポートにはならない');
  ok(konst.source.includes("assign n1 = 1'b0;"), '定数: 0 がリテラルになる', konst.source);
  ok(konst.source.includes("assign n2 = 1'b1;"), '定数: 1 がリテラルになる', konst.source);
  ok(konst.outputs.some((o) => o.kind === 'const'), '定数: kind は const');
  const { all: kall } = await bothSims(konst.source);
  for (const sim of kall) {
    sim.eval();
    eq(sim.get('y'), 1, `${sim.constructor.name} 定数: 0 | 1 = 1`);
    eq(sim.get('z'), 0, `${sim.constructor.name} 定数: 0 & 1 = 0`);
    eq(sim.get('n1'), 0, `${sim.constructor.name} 定数: 0 の値を読める`);
    eq(sim.get('n2'), 1, `${sim.constructor.name} 定数: 1 の値を読める`);
  }

  // 未配線のノードとその下流は回路から除外される
  const partial = toVerilog({
    nodes: [
      { id: 1, type: 'in' }, { id: 2, type: 'and' },   // and の入力 1 が未配線
      { id: 3, type: 'not' }, { id: 4, type: 'out' },  // その下流
      { id: 5, type: 'not' }, { id: 6, type: 'out' },  // こちらは完成している
    ],
    wires: [
      { from: { node: 1, port: 0 }, to: { node: 2, port: 0 } },
      { from: { node: 2, port: 0 }, to: { node: 3, port: 0 } },
      { from: { node: 3, port: 0 }, to: { node: 4, port: 0 } },
      { from: { node: 1, port: 0 }, to: { node: 5, port: 0 } },
      { from: { node: 5, port: 0 }, to: { node: 6, port: 0 } },
    ],
  });
  eq(partial.incomplete.size, 3, '回路グラフ: 未配線とその下流を除外');
  ok([2, 3, 4].every((id) => partial.incomplete.has(id)), '回路グラフ: 除外されたのは and / not / out');
  ok(!partial.source.includes('n2'), '回路グラフ: 未完成ノードは Verilog に出ない');
  const { wasm } = await bothSims(partial.source);
  wasm.setInput('a', 1).eval();
  eq(wasm.get('y1'), 0, '回路グラフ: 完成している側は動く');

  // 部品が何もなければソースは作らない
  ok(toVerilog({ nodes: [], wires: [] }).source === null, '回路グラフ: 空なら null');

  // ゲートの出力も観測できる (配線に値を色付けするために output にしている)
  const half = toVerilog(expandCircuit(SAMPLE_CIRCUITS['半加算器 (sum / carry)']));
  const gateProbe = half.outputs.find((o) => o.kind === 'gate');
  ok(gateProbe !== undefined, '回路グラフ: ゲート出力も観測用ポートになる');
  const { wasm: hw } = await bothSims(half.source);
  hw.setInput('a', 1).setInput('b', 1).eval();
  eq(hw.get(gateProbe.name), gateProbe.name === 'n3' ? 0 : 1, '回路グラフ: ゲート出力を読める');
}

// ---------------------------------------------------------------- 実行
const suites = [
  ['全加算器', testFullAdder],
  ['ゲートプリミティブ', testGates],
  ['DFF', testDff],
  ['シフトレジスタ', testShift8],
  ['イネーブル付きレジスタ', testRegEn],
  ['LFSR', testLfsr],
  ['ビットスライス', testLanes],
  ['レジスタのスワップ', testSwap],
  ['eval / commit の分離', testEvalCommit],
  ['エラー検出', testErrors],
  ['ランダム差分', testRandomDiff],
  ['WAT 出力', testWat],
  ['GUI 回路グラフ', testSchematic],
];

for (const [label, fn] of suites) {
  const before = failures.length;
  try {
    await fn();
  } catch (e) {
    failures.push(`${label}: 例外 ${e.stack ?? e.message}`);
  }
  const bad = failures.length - before;
  console.log(`${bad === 0 ? 'ok  ' : 'FAIL'} ${label}${bad ? ` (${bad} 件失敗)` : ''}`);
}

console.log(`\n${passed} 件成功, ${failures.length} 件失敗`);
if (failures.length > 0) {
  console.log('');
  for (const f of failures.slice(0, 25)) console.log(`  × ${f}`);
  if (failures.length > 25) console.log(`  … 他 ${failures.length - 25} 件`);
  process.exitCode = 1;
}
