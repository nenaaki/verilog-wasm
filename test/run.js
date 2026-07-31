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

const HERE = dirname(fileURLToPath(import.meta.url));
const example = (n) => readFileSync(join(HERE, '..', 'examples', n), 'utf8');

let passed = 0;
const failures = [];

function ok(cond, label, detail = '') {
  if (cond) passed++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
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
