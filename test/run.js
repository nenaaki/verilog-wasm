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
  blockPorts, checkName, decodeCircuit, encodeCircuit, expandCircuit,
  flattenGraph, insOf, outsOf, packCircuit, toVerilog,
} from '../src/schematic.js';
import { SAMPLE_CIRCUITS } from '../src/samples.js';

const MAX_DEPTH_TEST = 10;   // src 側の上限 (8) より深くする

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

// -------------------------------------------------------------- 加算・減算
//
// 加算器はビットに展開した時点で「ふつうのゲートの塊」になるので、WASM と参照
// 実装を突き合わせるだけでは算術としての正しさは分からない (両者は同じネット
// リストを見ている)。ここは JS の算術と直接比べる。
async function testArith() {
  const src = `module arith(
  input [3:0] a,
  input [3:0] b,
  output [4:0] sum,
  output [3:0] wrap,
  output [4:0] diff,
  output [3:0] neg,
  output [4:0] chain,
  output [4:0] pre1,
  output [4:0] pre2,
  output [4:0] slice,
  output [7:0] wide
);
  assign sum   = a + b;        // 桁上げまで受けられる 5 ビット
  assign wrap  = a + b;        // 4 ビットに切り詰められる
  assign diff  = a - b;
  assign neg   = -a;
  assign chain = a + b - a;
  assign pre1  = a + b & 4'hC; // + は & より強い → (a+b) & C
  assign pre2  = a & b + 4'h1; // → a & (b+1)
  assign slice = a[2:0] + 1;
  assign wide  = a - b;        // 8 ビット文脈で計算される (文脈依存幅)
endmodule`;
  const { compiled, wasm, ref } = await bothSims(src);

  let bad = null;
  for (let a = 0; a < 16 && !bad; a++) {
    for (let b = 0; b < 16 && !bad; b++) {
      for (const sim of [wasm, ref]) sim.setInput('a', a).setInput('b', b).eval();
      const expect = {
        sum: (a + b) & 31,
        wrap: (a + b) & 15,
        diff: (a - b) & 31,       // 符号なしなので 3 - 5 は 5 ビットで 30
        neg: (-a) & 15,
        chain: ((a + b) - a) & 31,
        pre1: ((a + b) & 0xc) & 31,
        pre2: (a & ((b + 1) & 31)) & 31,
        slice: ((a & 7) + 1) & 31,
        wide: ((a - b) % 256 + 256) % 256,   // 代入先が 8 ビットなので 8 ビットで計算される
      };
      for (const [port, want] of Object.entries(expect)) {
        for (const sim of [wasm, ref]) {
          if (Number(sim.get(port)) !== want) {
            bad = `${sim.constructor.name} ${port}: a=${a} b=${b} 期待 ${want} / 実際 ${sim.get(port)}`;
            break;
          }
        }
      }
    }
  }
  ok(!bad, '加算・減算: 全 256 通りが JS の算術と一致', bad ?? '');

  // 減算の符号なし意味づけ (Verilog は文脈幅で計算するので 3 - 5 は 30)
  for (const sim of [wasm, ref]) sim.setInput('a', 3).setInput('b', 5).eval();
  eq(wasm.get('diff'), 30, '減算: 3 - 5 は 5 ビット幅で 30');
  eq(wasm.get('sum'), 8, '加算: 桁上げが 5 ビット目に出る');
  for (const sim of [wasm, ref]) sim.setInput('a', 15).setInput('b', 1).eval();
  eq(wasm.get('sum'), 16, '加算: 15 + 1 は 5 ビットで 16');
  eq(wasm.get('wrap'), 0, '加算: 4 ビットに代入すると 0 に回る');

  // 計算幅は代入先の幅まで広がる (文脈依存幅)。同じ `a - b` が代入先ごとに
  // 違う値になり、どれも Verilog と一致する。
  for (const sim of [wasm, ref]) sim.setInput('a', 3).setInput('b', 5).eval();
  eq(wasm.get('diff'), 30, '減算: 5 ビットに代入すると 3 - 5 は 30');
  eq(wasm.get('wide'), 254, '減算: 8 ビットに代入すると 3 - 5 は 254');
  eq(ref.get('wide'), 254, '減算: 参照実装も同じ');

  // 64 レーン同時に別々の足し算をさせる (加算器もビット単位なので効く)
  wasm.reset();
  for (let lane = 0; lane < 64; lane++) {
    wasm.setInputLane('a', lane, lane & 15).setInputLane('b', lane, (lane >> 2) & 15);
  }
  wasm.eval();
  const lanes = wasm.getLanes('sum');
  let laneBad = 0;
  for (let lane = 0; lane < 64; lane++) {
    if (Number(lanes[lane]) !== (((lane & 15) + ((lane >> 2) & 15)) & 31)) laneBad++;
  }
  ok(laneBad === 0, '加算: 64 レーンが独立に計算される', `${laneBad} レーン不一致`);

  ok(compiled.stats.regs === 0, '加算・減算: レジスタなし', `regs=${compiled.stats.regs}`);
}

// ------------------------------------------------------------------ 比較器
//
// 加算器と同じ理由で、ここも JS の比較と直接突き合わせる。
async function testCompare() {
  const { compiled, wasm, ref } = await bothSims(example('cmp4.v'));
  eqs(compiled.stats.regs, 0, '比較器: レジスタなし');

  let bad = null;
  for (let a = 0; a < 16 && !bad; a++) {
    for (let b = 0; b < 16 && !bad; b++) {
      for (const sim of [wasm, ref]) sim.setInput('a', a).setInput('b', b).eval();
      const expect = { lt: a < b ? 1 : 0, eq: a === b ? 1 : 0, gt: a > b ? 1 : 0 };
      for (const [port, want] of Object.entries(expect)) {
        for (const sim of [wasm, ref]) {
          if (Number(sim.get(port)) !== want) {
            bad = `${sim.constructor.name} ${port}: a=${a} b=${b} 期待 ${want} / 実際 ${sim.get(port)}`;
          }
        }
      }
    }
  }
  ok(!bad, 'cmp4: 全 256 通りが JS の比較と一致', bad ?? '');

  // 6 演算子すべてと、幅の違う辺・リテラル・1 ビットになる結果
  const src = `module cmps(
  input [3:0] a,
  input [3:0] b,
  output eq, output ne, output lt, output le, output gt, output ge,
  output narrow, output lit, output [7:0] widened,
  output prec1, output [3:0] prec2, output prec3
);
  assign eq  = a == b;
  assign ne  = a != b;
  assign lt  = a <  b;
  assign le  = a <= b;
  assign gt  = a >  b;
  assign ge  = a >= b;
  assign narrow  = a[1:0] < b;   // 2 ビット対 4 ビット
  assign lit     = a >= 4'h8;
  assign widened = a < b;        // 結果は 1 ビットなのでゼロ拡張される
  assign prec1   = a < b == 1'b1;  // 等価は関係より弱い → (a<b) == 1
  assign prec2   = a & b == b;     // & は等価より弱い → a & (b==b) = a & 1
  assign prec3   = a + 1 <= b;     // 算術は関係より強い → (a+1) <= b
endmodule`;
  const { wasm: w2, ref: r2 } = await bothSims(src);
  let bad2 = null;
  for (let a = 0; a < 16 && !bad2; a++) {
    for (let b = 0; b < 16 && !bad2; b++) {
      for (const sim of [w2, r2]) sim.setInput('a', a).setInput('b', b).eval();
      const expect = {
        eq: a === b ? 1 : 0,
        ne: a !== b ? 1 : 0,
        lt: a < b ? 1 : 0,
        le: a <= b ? 1 : 0,
        gt: a > b ? 1 : 0,
        ge: a >= b ? 1 : 0,
        narrow: (a & 3) < b ? 1 : 0,
        lit: a >= 8 ? 1 : 0,
        widened: a < b ? 1 : 0,
        prec1: (a < b ? 1 : 0) === 1 ? 1 : 0,
        prec2: a & 1,
        // 比較のオペランドは外の文脈を受け取らないが、サイズ無しの 1 が 32 ビット
        // なので両辺が 32 ビットに揃い、a + 1 は折り返さない
        prec3: (a + 1) <= b ? 1 : 0,
      };
      for (const [port, want] of Object.entries(expect)) {
        for (const sim of [w2, r2]) {
          if (Number(sim.get(port)) !== want) {
            bad2 = `${sim.constructor.name} ${port}: a=${a} b=${b} 期待 ${want} / 実際 ${sim.get(port)}`;
          }
        }
      }
    }
  }
  ok(!bad2, '比較器: 6 演算子 × 全 256 通り (幅違い・優先順位込み)', bad2 ?? '');

  // 比較の幅規則は代入先を見ないが、結果が 1 ビットなので + / - と違って
  // Verilog と食い違わない。8 ビットに代入しても 0 か 1 のまま。
  for (const sim of [w2, r2]) sim.setInput('a', 1).setInput('b', 9).eval();
  eq(w2.get('widened'), 1, '比較器: 8 ビットに代入しても 1 ビットの値');
  for (const sim of [w2, r2]) sim.setInput('a', 9).setInput('b', 1).eval();
  eq(w2.get('widened'), 0, '比較器: 偽なら 0');

  // 64 レーンで別々の比較
  w2.reset();
  for (let lane = 0; lane < 64; lane++) {
    w2.setInputLane('a', lane, lane & 15).setInputLane('b', lane, (lane >> 2) & 15);
  }
  w2.eval();
  const lanes = w2.getLanes('ge');
  let laneBad = 0;
  for (let lane = 0; lane < 64; lane++) {
    if (Number(lanes[lane]) !== ((lane & 15) >= ((lane >> 2) & 15) ? 1 : 0)) laneBad++;
  }
  ok(laneBad === 0, '比較器: 64 レーンが独立に比較される', `${laneBad} レーン不一致`);

  // 式の中の <= (関係) と、ノンブロッキング代入の <= が同居できるか
  const { wasm: w3 } = await bothSims(`module amb(input clk, input [3:0] a, input [3:0] b, output reg q);
  always @(posedge clk)
    q <= a <= b;
endmodule`);
  for (const [a, b] of [[3, 5], [5, 3], [4, 4]]) {
    w3.setInput('a', a).setInput('b', b).step();
    eq(w3.get('q'), a <= b ? 1 : 0, `<= の曖昧性: q <= a <= b (a=${a} b=${b})`);
  }
}

// ------------------------------------------------------------ モジュール階層
//
// 展開して 1 個の平坦なネットリストにするので、確かめたいのは
// 「境界をまたいでも値が正しいか」と「奥の状態が観測できるか」。
async function testHierarchy() {
  // 半加算器 2 個で全加算器 → 全加算器 2 個で 2 ビット加算器 (2 段の入れ子)
  const { compiled, all } = await bothSims(example('adder2.v'));
  eqs(compiled.top, 'adder2', '階層: インスタンス化されていない module が top になる');
  eqs(compiled.warnings.length, 0, '階層: 未駆動の警告なし', compiled.warnings.join(' / '));

  for (const sim of all) {
    const kind = sim.constructor.name;
    let bad = null;
    for (let a = 0; a < 4 && !bad; a++) {
      for (let b = 0; b < 4 && !bad; b++) {
        for (const cin of [0, 1]) {
          sim.setInput('a', a).setInput('b', b).setInput('cin', cin).eval();
          const total = a + b + cin;
          if (Number(sim.get('sum')) !== (total & 3) || Number(sim.get('cout')) !== (total >> 2)) {
            bad = `a=${a} b=${b} cin=${cin} 期待 sum=${total & 3} cout=${total >> 2}`
              + ` / 実際 sum=${sim.get('sum')} cout=${sim.get('cout')}`;
            break;
          }
        }
      }
    }
    ok(!bad, `${kind} adder2: 全 4×4×2 通りが加算と一致`, bad ?? '');
  }

  // 部分木を top に切り替えられる
  const fa = compile(example('adder2.v'), { top: 'full_adder' });
  eqs(fa.top, 'full_adder', '階層: --top で部分木を選べる');
  const faSim = await WasmSimulator.create(fa);
  let faBad = 0;
  for (let v = 0; v < 8; v++) {
    const a = v & 1;
    const b = (v >> 1) & 1;
    const cin = (v >> 2) & 1;
    faSim.setInput('a', a).setInput('b', b).setInput('cin', cin).eval();
    const total = a + b + cin;
    if (Number(faSim.get('sum')) !== (total & 1) || Number(faSim.get('cout')) !== (total >> 1)) faBad++;
  }
  eqs(faBad, 0, '階層: 部分木だけでも正しく動く');

  // 平坦化したので、階層のあるなしで同じ回路になる
  const flat = compile(`module full_adder(input a, input b, input cin, output sum, output cout);
    wire axb;
    assign axb = a ^ b;
    assign sum = axb ^ cin;
    assign cout = (a & b) | (cin & axb);
  endmodule`);
  const sameBits = fa.stats.gates >= flat.stats.gates;
  ok(sameBits, '階層: 平坦に書いた版と同程度のゲート数',
    `階層=${fa.stats.gates} 平坦=${flat.stats.gates} (差は中継の buf)`);

  // 奥のレジスタが完全修飾名で観測でき、クロックが境界をまたいで共有される
  const withRegs = `module counter(input clk, input rst, output [3:0] q);
  reg [3:0] cnt;
  always @(posedge clk or posedge rst)
    if (rst) cnt <= 4'h0;
    else cnt <= cnt + 1;
  assign q = cnt;
endmodule

module top(input clk, input rst, output [3:0] a, output [3:0] b, output same);
  counter c0(.clk(clk), .rst(rst), .q(a));
  counter c1(clk, rst, b);
  assign same = a == b;
endmodule`;
  const { compiled: wc, all: ws } = await bothSims(withRegs);
  eqs(wc.stats.regs, 8, '階層: 子のレジスタが 2 個ぶん (4 ビット × 2) 出る');
  const names = wc.layout.signalTable.map((s) => s.name);
  ok(names.includes('c0.cnt') && names.includes('c1.cnt'),
    '階層: 奥のレジスタが完全修飾名で信号表に出る', names.join(', '));

  for (const sim of ws) {
    const kind = sim.constructor.name;
    sim.reset().setInput('rst', 0).run(5);
    eq(sim.get('a'), 5, `${kind} 階層: 子のカウンタが 5 まで進む`);
    eq(sim.get('b'), 5, `${kind} 階層: もう 1 個も同じクロックで進む`);
    eq(sim.get('same'), 1, `${kind} 階層: 親の比較器が両方を見る`);
    eq(sim.get('c0.cnt'), 5, `${kind} 階層: 奥のレジスタを名前で読める`);
    // 非同期リセットも境界をまたいで効く (状態は eval 1 回で戻る)
    sim.setInput('rst', 1).eval();
    eq(sim.get('c0.cnt'), 0, `${kind} 階層: 子の非同期リセットが eval だけで効く`);
  }

  // 未接続のポートは 0 に固定されて警告が出る
  const unconn = compile(`module sub(input a, input b, output y); assign y = a & b; endmodule
    module m(input a, output y); sub u0(.a(a), .y(y)); endmodule`);
  ok(/u0\.b/.test(unconn.warnings[0] ?? ''), '階層: 未接続の入力ポートが未駆動検査に乗る',
    unconn.warnings.join(' / '));

  // 入れ子の深さ上限
  let deep = 'module d0(input a, output y); assign y = ~a; endmodule\n';
  for (let i = 1; i <= 20; i++) {
    deep += `module d${i}(input a, output y); d${i - 1} u0(a, y); endmodule\n`;
  }
  let caught = null;
  try { compile(deep, { top: 'd20' }); } catch (e) { caught = e; }
  ok(caught instanceof CompileError && /入れ子が深すぎる/.test(caught.message),
    '階層: 入れ子が深すぎるとエラーになる', caught ? caught.message : 'エラーにならなかった');

  // 上限内なら通る
  const ok16 = compile(deep, { top: 'd15' });
  eqs(ok16.top, 'd15', '階層: 上限内の深さなら通る');
}

// ------------------------------------------------------------------ parameter
//
// 効いているかどうかは「同じ module が幅も動きも変わって展開されるか」で分かる。
async function testParams() {
  const { compiled, all } = await bothSims(example('counter_param.v'));
  eqs(compiled.top, 'counter_param', 'parameter: top が選ばれる');
  eqs(compiled.warnings.length, 0, 'parameter: 未駆動の警告なし', compiled.warnings.join(' / '));
  // 4 + 8 + 4 ビットぶんのレジスタになる
  eqs(compiled.stats.regs, 16, 'parameter: インスタンスごとに幅が変わる', `regs=${compiled.stats.regs}`);
  const widthOf = (name) => compiled.layout.signalTable.find((s) => s.name === name)?.width;
  eqs(widthOf('c0.cnt'), 4, 'parameter: .WIDTH(4) の指定が効く');
  eqs(widthOf('c1.cnt'), 8, 'parameter: 指定しなければ既定値');
  eqs(widthOf('c2.cnt'), 4, 'parameter: 順番指定の 1 個目が WIDTH');

  for (const sim of all) {
    const kind = sim.constructor.name;
    sim.reset().setInput('rst', 0).run(5);
    eq(sim.get('small'), 5, `${kind} parameter: 4 ビット版が 5 まで数える`);
    eq(sim.get('big'), 5, `${kind} parameter: 8 ビット版も同じクロックで進む`);
    eq(sim.get('by3'), 15, `${kind} parameter: STEP=3 版は 3 刻み`);
    sim.run(20);
    eq(sim.get('small'), 25 % 16, `${kind} parameter: 4 ビットは 16 で回る`);
    eq(sim.get('big'), 25, `${kind} parameter: 8 ビットは回らない`);
  }

  // --top で部分木を既定値のまま見られる
  const solo = compile(example('counter_param.v'), { top: 'counter' });
  eqs(solo.stats.regs, 8, 'parameter: 単体で見ると既定の 8 ビット');

  // 本体宣言スタイル・前のパラメータの参照・式の中での使用・親から子へ渡す
  const chain = `module leaf(input [7:0] a, output [7:0] y);
  parameter MASK = 8'h0F;
  parameter SHIFT = 1;
  localparam DOUBLE = SHIFT + SHIFT;
  assign y = ((a & MASK) << DOUBLE) | SHIFT;
endmodule

module mid #(parameter W = 4, parameter W1 = W + 1) (
  input [7:0] a, output [7:0] y, output [7:0] z, output [7:0] p
);
  leaf #(.SHIFT(W)) l0(a, y);
  leaf #(.MASK(8'hFF), .SHIFT(1)) l1(a, z);
  assign p = W1;
endmodule

module top(input [7:0] a, output [7:0] y, output [7:0] z, output [7:0] p);
  mid #(.W(2)) m0(a, y, z, p);
endmodule`;
  const { all: cs } = await bothSims(chain);
  for (const sim of cs) {
    const kind = sim.constructor.name;
    let bad = null;
    for (const a of [0, 1, 0xa5, 0xff, 0x10]) {
      sim.setInput('a', a).eval();
      const wantY = (((a & 0x0f) << 4) | 2) & 255;   // SHIFT=2 → DOUBLE=4
      const wantZ = (((a & 0xff) << 2) | 1) & 255;   // SHIFT=1 → DOUBLE=2
      if (Number(sim.get('y')) !== wantY && !bad) bad = `y: a=${a} 期待 ${wantY} / 実際 ${sim.get('y')}`;
      if (Number(sim.get('z')) !== wantZ && !bad) bad = `z: a=${a} 期待 ${wantZ} / 実際 ${sim.get('z')}`;
    }
    ok(!bad, `${kind} parameter: 本体宣言・localparam・親から子への受け渡し`, bad ?? '');
    eq(sim.get('p'), 3, `${kind} parameter: 前のパラメータを参照した既定値 (W+1)`);
  }

  // 定数式で使える演算子
  const consts = compile(`module m(output [7:0] a, output [7:0] b, output [7:0] c, output [7:0] d);
    parameter P = 6;
    localparam SHIFTED = P << 1;
    localparam MASKED = P & 3;
    localparam COND = (P > 4) ? 9 : 1;
    localparam NEG = 0 - P;
    assign a = SHIFTED;
    assign b = MASKED;
    assign c = COND;
    assign d = NEG;
  endmodule`);
  const cv = await WasmSimulator.create(consts);
  cv.eval();
  eq(cv.get('a'), 12, '定数式: << が使える');
  eq(cv.get('b'), 2, '定数式: & が使える');
  eq(cv.get('c'), 9, '定数式: ?: が使える');
  eq(cv.get('d'), 250, '定数式: 負の値は 32 ビットに丸めて配線される');

  // 同じ module を違うパラメータで 2 回展開しても互いに影響しない
  const twice = compile(`module w #(parameter N = 1) (input [7:0] a, output [7:0] y);
    assign y = a << N;
  endmodule
  module m(input [7:0] a, output [7:0] p, output [7:0] q);
    w #(.N(1)) u0(a, p);
    w #(.N(3)) u1(a, q);
  endmodule`);
  const tv = await WasmSimulator.create(twice);
  tv.setInput('a', 5).eval();
  eq(tv.get('p'), 10, 'parameter: 1 個目のインスタンスは N=1');
  eq(tv.get('q'), 40, 'parameter: 2 個目のインスタンスは N=3');
}

// ------------------------------------------------------------ 非同期リセット
//
// 「クロックを待たない」のが非同期の意味なので、step() ではなく eval() だけで
// Q が変わることを確かめるのが本質。WASM と参照実装で別々に実装している所なので
// 両方を突き合わせる。
async function testAsyncReset() {
  const dffr = `module dffr(input clk, input rst, input [3:0] d, output reg [3:0] q);
  always @(posedge clk or posedge rst)
    if (rst) q <= 4'h0;
    else q <= d;
endmodule`;
  const { all } = await bothSims(dffr);
  for (const sim of all) {
    const kind = sim.constructor.name;
    sim.reset().setInput('rst', 0).setInput('d', 5).step();
    eq(sim.get('q'), 5, `${kind} 非同期リセット: 通常のロード`);

    // ここが非同期の要点 — クロックを打たずに eval() だけで 0 になる
    sim.setInput('rst', 1).eval();
    eq(sim.get('q'), 0, `${kind} 非同期リセット: eval() だけで Q が 0 になる`);

    // 続けて eval しても変わらない (べき等)
    sim.eval().eval();
    eq(sim.get('q'), 0, `${kind} 非同期リセット: eval を重ねても 0`);

    // リセットを下げてもクロックが来るまで値は戻らない
    sim.setInput('rst', 0).eval();
    eq(sim.get('q'), 0, `${kind} 非同期リセット: 解除しただけでは 0 のまま`);

    sim.setInput('d', 9).step();
    eq(sim.get('q'), 9, `${kind} 非同期リセット: 解除後のクロックで取り込む`);

    // リセット中は何クロック打っても 0
    sim.setInput('rst', 1).setInput('d', 7).run(5);
    eq(sim.get('q'), 0, `${kind} 非同期リセット: リセット中は run(5) でも 0`);
    sim.setInput('rst', 0).step();
    eq(sim.get('q'), 7, `${kind} 非同期リセット: 解除後に d を取り込む`);
  }

  // 負論理リセット (negedge rst_n + if (!rst_n))、非ゼロのリセット値、部分リセット、
  // リセット側に出てこない reg
  const lowActive = `module m(input clk, input rst_n, input [3:0] d,
  output reg [3:0] a, output reg [3:0] b, output reg [3:0] c);
  always @(posedge clk or negedge rst_n)
    if (!rst_n) begin
      a <= 4'hF;
      b[1:0] <= 2'b01;
    end else begin
      a <= d;
      b <= d;
      c <= d;
    end
endmodule`;
  const { compiled: lc, all: ls } = await bothSims(lowActive);
  eqs(lc.warnings.length, 0, '非同期リセット: 部分リセットでも未駆動の警告なし', lc.warnings.join(' / '));
  for (const sim of ls) {
    const kind = sim.constructor.name;
    sim.reset().setInput('rst_n', 1).setInput('d', 0xa).step();
    eq(sim.get('a'), 0xa, `${kind} 負論理: 通常動作 (a)`);
    sim.setInput('rst_n', 0).eval();
    eq(sim.get('a'), 0xf, `${kind} 負論理: eval だけで非ゼロのリセット値になる`);
    eq(sim.get('b'), 0b1001, `${kind} 負論理: 部分リセット (上位 2 ビットは保持)`);
    eq(sim.get('c'), 0xa, `${kind} 負論理: リセット側に無い reg は保持`);
    sim.setInput('rst_n', 1).setInput('d', 3).step();
    eq(sim.get('a'), 3, `${kind} 負論理: 解除後に取り込む`);
    eq(sim.get('b'), 3, `${kind} 負論理: b も取り込む`);
  }

  // 例題のカウンタ
  const { all: cs } = await bothSims(example('counter_rst.v'));
  for (const sim of cs) {
    const kind = sim.constructor.name;
    sim.reset().setInput('rst', 0).setInput('en', 1).run(20);
    eq(sim.get('q'), 20, `${kind} counter_rst: 20 クロック数える`);
    sim.setInput('rst', 1).eval();
    eq(sim.get('q'), 0, `${kind} counter_rst: クロック無しでクリア`);
    sim.setInput('rst', 0).setInput('en', 0).step();
    eq(sim.get('q'), 0, `${kind} counter_rst: en=0 なら止まったまま`);
    sim.setInput('en', 1).step();
    eq(sim.get('q'), 1, `${kind} counter_rst: en=1 で再開`);
  }

  // else が無い形 (リセット以外では保持)
  const noElse = `module m(input clk, input rst, output reg [3:0] q);
  always @(posedge clk or posedge rst)
    if (rst) q <= 4'h5;
endmodule`;
  const { all: ns } = await bothSims(noElse);
  for (const sim of ns) {
    const kind = sim.constructor.name;
    sim.reset().setInput('rst', 1).eval();
    eq(sim.get('q'), 5, `${kind} 非同期リセット: else 無しでもリセットは効く`);
    sim.setInput('rst', 0).run(3);
    eq(sim.get('q'), 5, `${kind} 非同期リセット: else 無しなら以後は保持`);
  }

  // 同期リセット (イベント 1 つ) との違い: そちらは eval() では変わらない
  const syncRst = `module m(input clk, input rst, input [3:0] d, output reg [3:0] q);
  always @(posedge clk)
    if (rst) q <= 4'h0;
    else q <= d;
endmodule`;
  const { all: ss } = await bothSims(syncRst);
  for (const sim of ss) {
    const kind = sim.constructor.name;
    sim.reset().setInput('rst', 0).setInput('d', 6).step();
    eq(sim.get('q'), 6, `${kind} 同期リセット: 通常のロード`);
    sim.setInput('rst', 1).eval();
    eq(sim.get('q'), 6, `${kind} 同期リセット: eval() では変わらない (非同期との違い)`);
    sim.step();
    eq(sim.get('q'), 0, `${kind} 同期リセット: クロックで 0 になる`);
  }

  // 64 レーンで別々にリセットをかける
  const { wasm: lw } = await bothSims(dffr);
  lw.reset();
  for (let lane = 0; lane < 64; lane++) {
    lw.setInputLane('d', lane, lane & 15).setInputLane('rst', lane, lane & 1);
  }
  lw.step();
  const lanes = lw.getLanes('q');
  let laneBad = 0;
  for (let lane = 0; lane < 64; lane++) {
    if (Number(lanes[lane]) !== ((lane & 1) ? 0 : (lane & 15))) laneBad++;
  }
  ok(laneBad === 0, '非同期リセット: 64 レーンが独立にリセットされる', `${laneBad} レーン不一致`);
}

// ---------------------------------------------- 定数畳み込みと共通部分式除去
//
// ゲートを作る所でたたむので、たたんだ結果が正しいことを真理値表で押さえる。
// ゲート数の主張は「同じ意味の書き方どうしで一致する」形にして、実装が変わっても
// 意味のある不変条件が残るようにしてある。
async function testFoldCse() {
  // --- たたんだ結果が真理値表として正しいか ---
  const src = `module f(
  input a,
  input b,
  input [3:0] v,
  output andZero, output andOne, output orOne, output orZero,
  output xorZero, output xorOne, output notNot,
  output selfAnd, output selfOr, output selfXor,
  output muxTrue, output muxFalse, output muxSame, output muxIdent, output muxInv,
  output [3:0] maskLow, output [3:0] orAll
);
  assign andZero  = a & 1'b0;
  assign andOne   = a & 1'b1;
  assign orOne    = a | 1'b1;
  assign orZero   = a | 1'b0;
  assign xorZero  = a ^ 1'b0;
  assign xorOne   = a ^ 1'b1;
  assign notNot   = ~(~a);
  assign selfAnd  = a & a;
  assign selfOr   = a | a;
  assign selfXor  = a ^ a;
  assign muxTrue  = 1'b1 ? a : b;
  assign muxFalse = 1'b0 ? a : b;
  assign muxSame  = b ? a : a;
  assign muxIdent = a ? 1'b1 : 1'b0;
  assign muxInv   = a ? 1'b0 : 1'b1;
  assign maskLow  = v & 4'b0011;
  assign orAll    = v | 4'b1111;
endmodule`;
  const { compiled, wasm, ref } = await bothSims(src);

  let bad = null;
  for (let a = 0; a < 2 && !bad; a++) {
    for (let b = 0; b < 2 && !bad; b++) {
      for (let v = 0; v < 16 && !bad; v++) {
        for (const sim of [wasm, ref]) {
          sim.setInput('a', a).setInput('b', b).setInput('v', v).eval();
        }
        const expect = {
          andZero: 0, andOne: a, orOne: 1, orZero: a,
          xorZero: a, xorOne: 1 - a, notNot: a,
          selfAnd: a, selfOr: a, selfXor: 0,
          muxTrue: a, muxFalse: b, muxSame: a, muxIdent: a, muxInv: 1 - a,
          maskLow: v & 3, orAll: 15,
        };
        for (const [port, want] of Object.entries(expect)) {
          for (const sim of [wasm, ref]) {
            if (Number(sim.get(port)) !== want && !bad) {
              bad = `${sim.constructor.name} ${port}: a=${a} b=${b} v=${v}`
                + ` 期待 ${want} / 実際 ${sim.get(port)}`;
            }
          }
        }
      }
    }
  }
  ok(!bad, '畳み込み: たたんだ 17 通りの形が真理値表と一致', bad ?? '');

  // 上の回路は全部たためるので、論理ゲートが 1 個も残らないはず
  // (残るのは出力を駆動する buf、~a の not、定数ゲートだけ)
  const kindsOf = (c) => {
    const n = {};
    for (const gi of c.order) {
      const op = c.netlist.gates[gi].op;
      n[op] = (n[op] ?? 0) + 1;
    }
    return n;
  };
  const kinds = kindsOf(compiled);
  ok(!kinds.and && !kinds.or && !kinds.xor && !kinds.mux,
    '畳み込み: and / or / xor / mux が 1 個も残らない', JSON.stringify(kinds));

  // --- 定数を含む形が、定数を書かない形と同じ回路になるか ---
  const pairs = [
    ['a & 1\'b1 と a', 'assign y = a & 1\'b1;', 'assign y = a;'],
    ['a ^ 1\'b0 と a', 'assign y = a ^ 1\'b0;', 'assign y = a;'],
    ['~(~a) と a', 'assign y = ~(~a);', 'assign y = a;'],
    ['a ? 1\'b1 : 1\'b0 と a', 'assign y = a ? 1\'b1 : 1\'b0;', 'assign y = a;'],
    ['v + 4\'d0 と v', 'assign y = v + 4\'d0;', 'assign y = v;'],
    ['v - 4\'d0 と v', 'assign y = v - 4\'d0;', 'assign y = v;'],
    ['v << 0 と v', 'assign y = v << 0;', 'assign y = v;'],
  ];
  for (const [label, folded, plainBody] of pairs) {
    const wrap = (body) => `module m(input a, input [3:0] v, output [3:0] y); ${body} endmodule`;
    const f = compile(wrap(folded));
    const g = compile(wrap(plainBody));
    eqs(f.stats.gates, g.stats.gates, `畳み込み: ${label} が同じゲート数`,
      `${f.stats.gates} vs ${g.stats.gates}`);
  }

  // --- 共通部分式除去 ---
  // 同じ式を 2 回書いても、2 回目はゲートを作らない
  const once = compile('module m(input [3:0] a, input [3:0] b, output [3:0] y); assign y = a ^ b; endmodule');
  const twice = compile(`module m(input [3:0] a, input [3:0] b, output [3:0] y, output [3:0] z);
    assign y = a ^ b;
    assign z = a ^ b;
  endmodule`);
  eqs(twice.stats.gates - once.stats.gates, 4,
    'CSE: 同じ式を 2 回書いても増えるのは出力の buf 4 個だけ',
    `1 回=${once.stats.gates} 2 回=${twice.stats.gates}`);

  // 入力の順番が違っても同じゲートになる (and / or / xor は可換)
  const swapped = compile(`module m(input [3:0] a, input [3:0] b, output [3:0] y, output [3:0] z);
    assign y = a & b;
    assign z = b & a;
  endmodule`);
  const oneAnd = compile('module m(input [3:0] a, input [3:0] b, output [3:0] y); assign y = a & b; endmodule');
  eqs(swapped.stats.gates - oneAnd.stats.gates, 4,
    'CSE: a & b と b & a が共有される', `${oneAnd.stats.gates} → ${swapped.stats.gates}`);

  // 共有しても値は正しい
  const { all: sw } = await bothSims(`module m(input [3:0] a, input [3:0] b, output [3:0] y, output [3:0] z);
    assign y = a & b;
    assign z = b & a;
  endmodule`);
  for (const sim of sw) {
    let mismatch = 0;
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) {
        sim.setInput('a', a).setInput('b', b).eval();
        if (Number(sim.get('y')) !== (a & b) || Number(sim.get('z')) !== (a & b)) mismatch++;
      }
    }
    eqs(mismatch, 0, `${sim.constructor.name} CSE: 共有しても全 256 通り正しい`);
  }

  // --- 定数だけの式は完全にたためる (加算器が丸ごと消える) ---
  const constOnly = compile(`module m(output [3:0] y); assign y = (4'd3 + 4'd4) & 4'hF; endmodule`);
  const constKinds = kindsOf(constOnly);
  ok(!constKinds.and && !constKinds.or && !constKinds.xor && !constKinds.mux,
    '畳み込み: 定数だけの式は論理ゲートが残らない', JSON.stringify(constKinds));
  const cs = await WasmSimulator.create(constOnly);
  cs.eval();
  eq(cs.get('y'), 7, '畳み込み: 定数だけの式の値が正しい');
}

// -------------------------------------------------- 到達不能ゲートの刈り取り
//
// 消してよいのは「出力にもレジスタにも届かないゲート」だけ。観測できる信号が
// 残っていることと、消しても値が変わらないことの両方を見る。
async function testPrune() {
  // 幅の広い式を狭い左辺に代入すると、上位ビットの計算が誰にも届かなくなる
  const narrow = compile('module m(input [7:0] a, input [7:0] b, output [3:0] y); assign y = a - b; endmodule');
  ok(narrow.stats.pruned > 0, '刈り取り: 切り詰められた上位ビットが消える',
    `pruned=${narrow.stats.pruned}`);
  eqs(narrow.stats.gates + narrow.stats.pruned, narrow.netlist.gates.length,
    '刈り取り: gates + pruned が作ったゲート数と一致');
  eqs(narrow.order.length, narrow.stats.gates, '刈り取り: order が刈り取り後の並び');

  // 使われなかった定数ゲートも消える
  const noConst = compile('module m(input [3:0] a, input [3:0] b, output [3:0] y); assign y = a & b; endmodule');
  eqs(noConst.stats.pruned, 2, '刈り取り: 使われない $const0 / $const1 が消える',
    `pruned=${noConst.stats.pruned}`);

  // 消しても値は変わらない (狭い代入・上書きされた分岐の両方)
  const live = `module m(
  input clk,
  input c,
  input [7:0] a,
  input [7:0] b,
  output [3:0] narrowSub,
  output reg [3:0] overwritten
);
  assign narrowSub = a - b;
  always @(posedge clk) begin
    if (c) overwritten <= a;      // この mux 木は下の代入に上書きされて死ぬ
    overwritten <= b;
  end
endmodule`;
  const { compiled, all } = await bothSims(live);
  ok(compiled.stats.pruned > 0, '刈り取り: 上書きされた mux 木も消える',
    `pruned=${compiled.stats.pruned}`);
  for (const sim of all) {
    const kind = sim.constructor.name;
    let bad = null;
    for (const [a, b] of [[3, 5], [200, 1], [0, 0], [255, 255], [16, 32]]) {
      for (const cv of [0, 1]) {
        sim.setInput('a', a).setInput('b', b).setInput('c', cv).step();
        const want = ((a - b) % 256 + 256) % 256 & 15;
        if (Number(sim.get('narrowSub')) !== want && !bad) {
          bad = `narrowSub: a=${a} b=${b} 期待 ${want} / 実際 ${sim.get('narrowSub')}`;
        }
        if (Number(sim.get('overwritten')) !== (b & 15) && !bad) {
          bad = `overwritten: b=${b} 期待 ${b & 15} / 実際 ${sim.get('overwritten')}`;
        }
      }
    }
    ok(!bad, `${kind} 刈り取り: 消しても観測できる値は変わらない`, bad ?? '');
  }

  // 出力ポートにつながっていない内部 reg も、signalTable から読めるので消してはいけない
  const hidden = `module m(input clk, input [3:0] d, output [3:0] y);
  reg [3:0] hiddenReg;
  always @(posedge clk) hiddenReg <= d;
  assign y = d;
endmodule`;
  const { all: hs } = await bothSims(hidden);
  for (const sim of hs) {
    const kind = sim.constructor.name;
    sim.reset().setInput('d', 0xa).step();
    eq(sim.get('hiddenReg'), 0xa, `${kind} 刈り取り: 出力に出ていない reg も更新される`);
    sim.setInput('d', 0x5).step();
    eq(sim.get('hiddenReg'), 0x5, `${kind} 刈り取り: 2 クロック目も追従する`);
  }

  // 刈りすぎていない確認。両方の定数を使う回路なら消すものが無い
  const bothConst = compile(`module m(output [1:0] y); assign y = {1'b1, 1'b0}; endmodule`);
  eqs(bothConst.stats.pruned, 0, '刈り取り: 全部使っている回路では 0',
    `pruned=${bothConst.stats.pruned} gates=${bothConst.stats.gates}`);
  eq(await (async () => {
    const sim = await WasmSimulator.create(bothConst);
    sim.eval();
    return sim.get('y');
  })(), 2, '刈り取り: 定数だけの回路も正しく動く');

  // リテラルを使わない回路で消えるのは定数ゲート 2 個ちょうど
  const fa = compile(example('full_adder.v'));
  eqs(fa.stats.pruned, 2, '刈り取り: 定数を使わない回路では $const0 / $const1 だけ消える',
    `pruned=${fa.stats.pruned} gates=${fa.stats.gates}`);

  // 到達不能な場所にある組合せループも、刈り取りより先に見つかること
  let caught = null;
  try {
    compile(`module m(input a, output y);
      wire t, u;
      assign t = a & u;
      assign u = ~t;      // y にはつながっていない組合せループ
      assign y = a;
    endmodule`);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof CompileError && /組合せループ/.test(caught.message),
    '刈り取り: 到達不能な組合せループも見逃さない', caught ? caught.message : 'エラーにならなかった');
}

// ------------------------------------------------------------ 文脈依存幅
//
// 「どの演算子が代入先の幅を受け取り、どれが受け取らないか」が本体なので、
// 受け取る側と受け取らない側を並べて、同じ部分式が幅で変わることを確かめる。
async function testContextWidth() {
  const src = `module ctxw(
  input [3:0] a,
  input [3:0] b,
  input [3:0] hi,
  input c,
  output [7:0] sub8,
  output [3:0] sub4,
  output [7:0] thruAnd,
  output [7:0] thruTern,
  output [7:0] thruNot,
  output [7:0] thruShift,
  output [7:0] inConcat,
  output [7:0] inCmp,
  output [7:0] cmpMutual,
  output [7:0] inAmt,
  output [7:0] inLogic
);
  // --- 文脈が配られる側 ---
  assign sub8      = a - b;                // 8 ビットで計算
  assign sub4      = a - b;                // 同じ式が 4 ビットで計算
  assign thruAnd   = (a - b) & 8'hFF;      // & が 8 を下に配る
  assign thruTern  = c ? a - b : 8'h00;    // ?: の値側に配られる
  assign thruNot   = ~(a - b);             // ~ が配る
  assign thruShift = hi << 4;              // << の左オペランドに配られる

  // --- 文脈が配られない側 (自己決定) ---
  assign inConcat  = {4'h0, a - b};        // 連接のパートは自己決定 (4 ビット)
  assign inCmp     = (a - b) == 4'hE;      // 比較は外の文脈を受け取らない
  assign cmpMutual = (a - b) == 8'hFE;     // ただし両辺は互いの max(幅) に揃う
  assign inAmt     = hi << (a - b);        // シフト量は自己決定 (4 ビット)
  assign inLogic   = (hi << 4) && 1'b1;    // 論理演算のオペランドは自己決定
endmodule`;
  const { wasm, ref } = await bothSims(src);

  const mod = (v, m) => ((v % m) + m) % m;
  let bad = null;
  for (let a = 0; a < 16 && !bad; a++) {
    for (let b = 0; b < 16 && !bad; b++) {
      for (const hi of [0, 1, 10, 15]) {
        for (const c of [0, 1]) {
          for (const sim of [wasm, ref]) {
            sim.setInput('a', a).setInput('b', b).setInput('hi', hi).setInput('c', c).eval();
          }
          const d8 = mod(a - b, 256);
          const d4 = mod(a - b, 16);
          const expect = {
            sub8: d8,
            sub4: d4,
            thruAnd: d8,
            thruTern: c ? d8 : 0,
            thruNot: (~d8) & 255,
            thruShift: (hi << 4) & 255,
            inConcat: d4,                        // 上位ニブルは 4'h0
            inCmp: d4 === 14 ? 1 : 0,
            cmpMutual: d8 === 254 ? 1 : 0,
            inAmt: d4 >= 8 ? 0 : (hi << d4) & 255,
            inLogic: 0,                          // 4 ビットの hi << 4 は必ず 0
          };
          for (const [port, want] of Object.entries(expect)) {
            for (const sim of [wasm, ref]) {
              if (Number(sim.get(port)) !== want && !bad) {
                bad = `${sim.constructor.name} ${port}: a=${a} b=${b} hi=${hi} c=${c}`
                  + ` 期待 ${want} / 実際 ${sim.get(port)}`;
              }
            }
          }
        }
      }
    }
  }
  ok(!bad, '文脈依存幅: 配られる側と配られない側が全通りで一致', bad ?? '');

  // 代表値を名前つきで固定する (3 - 5 は代入先の幅で 14 / 30 / 254 に変わる)
  const widths = `module w(input [3:0] a, input [3:0] b,
    output [3:0] w4, output [4:0] w5, output [7:0] w8, output [15:0] w16);
    assign w4 = a - b;
    assign w5 = a - b;
    assign w8 = a - b;
    assign w16 = a - b;
  endmodule`;
  const { wasm: ww } = await bothSims(widths);
  ww.setInput('a', 3).setInput('b', 5).eval();
  eq(ww.get('w4'), 14, '文脈依存幅: 3 - 5 を 4 ビットに代入すると 14');
  eq(ww.get('w5'), 30, '文脈依存幅: 5 ビットなら 30');
  eq(ww.get('w8'), 254, '文脈依存幅: 8 ビットなら 254');
  eq(ww.get('w16'), 65534, '文脈依存幅: 16 ビットなら 65534');

  // ノンブロッキング代入でも代入先の幅が文脈になる
  const nb = `module n(input clk, input [3:0] a, input [3:0] b,
    output reg [3:0] q4, output reg [7:0] q8);
    always @(posedge clk) begin
      q4 <= a - b;
      q8 <= a - b;
    end
  endmodule`;
  const { all: nbs } = await bothSims(nb);
  for (const sim of nbs) {
    sim.reset().setInput('a', 3).setInput('b', 5).step();
    eq(sim.get('q4'), 14, `${sim.constructor.name} 文脈依存幅: always の 4 ビット代入`);
    eq(sim.get('q8'), 254, `${sim.constructor.name} 文脈依存幅: always の 8 ビット代入`);
  }

  // 幅より大きい値を書いたサイズ付きリテラルは、文脈で広がる前に自分の幅で切られる
  const lit = `module l(output [7:0] over, output [3:0] narrow, output [7:0] sum);
    assign over   = 4'hFF;         // 15。8 ビット文脈でも 15 のまま
    assign narrow = 4'hFF;         // 15
    assign sum    = 4'hFF + 4'h1;  // 8 ビット文脈で 15 + 1 → 16
  endmodule`;
  const { all: lits } = await bothSims(lit);
  for (const sim of lits) {
    sim.eval();
    const kind = sim.constructor.name;
    eq(sim.get('over'), 15, `${kind} 文脈依存幅: 4'hFF は自分の幅で切られてから広がる`);
    eq(sim.get('narrow'), 15, `${kind} 文脈依存幅: 狭い文脈でも 15`);
    eq(sim.get('sum'), 16, `${kind} 文脈依存幅: 4'hFF + 4'h1 は 8 ビット文脈で 16`);
  }

  // サイズ無しリテラルは 32 ビット (Verilog の integer と同じ)。文脈が配られない
  // 位置でも折り返さない。
  const unsized = `module u(input [3:0] a, input [3:0] b,
    output [7:0] shiftAmt, output [7:0] noWrap, output cmp32, output [31:0] max32, output [7:0] based);
    assign shiftAmt = a << (1 + 1);     // 1 + 1 = 2
    assign noWrap   = a << (15 + 1);    // 15 + 1 = 16。4 ビットで折り返さないので全部押し出される
    assign cmp32    = a + 1 <= b;       // 両辺が 32 ビットに揃うので a + 1 も折り返さない
    assign max32    = 4294967295;       // 32 ビットに収まる最大値
    assign based    = 'h5A;             // サイズ無しの基数付きリテラルも 32 ビット
  endmodule`;
  const { all: us } = await bothSims(unsized);
  for (const sim of us) {
    const kind = sim.constructor.name;
    sim.setInput('a', 5).setInput('b', 0).eval();
    eq(sim.get('shiftAmt'), 20, `${kind} リテラル幅: a << (1 + 1) は 5 << 2`);
    eq(sim.get('noWrap'), 0, `${kind} リテラル幅: a << (15 + 1) は 16 ビットぶん押し出される`);
    eq(sim.get('max32'), 4294967295, `${kind} リテラル幅: 32 ビットの最大値が入る`);
    eq(sim.get('based'), 0x5a, `${kind} リテラル幅: サイズ無しの 'h5A も読める`);
    sim.setInput('a', 15).setInput('b', 0).eval();
    eq(sim.get('cmp32'), 0, `${kind} リテラル幅: 15 + 1 <= 0 は偽 (折り返さない)`);
    sim.setInput('a', 1).setInput('b', 2).eval();
    eq(sim.get('cmp32'), 1, `${kind} リテラル幅: 1 + 1 <= 2 は真`);
  }

  // 32 ビットで計算しても、届かないぶんは刈り取られるのでゲートは増えない
  const plus1 = compile('module m(input clk, output reg [7:0] q); always @(posedge clk) q <= q + 1; endmodule');
  const plus1Sized = compile("module m(input clk, output reg [7:0] q); always @(posedge clk) q <= q + 8'd1; endmodule");
  eqs(plus1.stats.gates, plus1Sized.stats.gates,
    'リテラル幅: q + 1 と q + 8\'d1 でゲート数が同じ (上位ビットは刈られる)',
    `サイズ無し=${plus1.stats.gates} サイズ付き=${plus1Sized.stats.gates} pruned=${plus1.stats.pruned}`);
  ok(plus1.stats.pruned > plus1Sized.stats.pruned,
    'リテラル幅: サイズ無しのほうが刈り取り量が多い',
    `${plus1.stats.pruned} vs ${plus1Sized.stats.pruned}`);

  // シフト量の式でも同じ。刈り取りは効かない位置 (バレルシフタは「幅を超えたか」の
  // 判定でシフト量の全ビットを見る) だが、定数畳み込みが 32 ビット減算器を
  // たたんでしまうので、サイズを書いても書かなくても同じ回路になる。
  const amtUnsized = compile('module m(input [7:0] p, input [2:0] s, output [7:0] y); assign y = p >> (8 - s); endmodule');
  const amtSized = compile("module m(input [7:0] p, input [2:0] s, output [7:0] y); assign y = p >> (4'd8 - s); endmodule");
  eqs(amtUnsized.stats.gates, amtSized.stats.gates,
    'リテラル幅: シフト量の式でもサイズ有無でゲート数が変わらない',
    `サイズ無し=${amtUnsized.stats.gates} サイズ付き=${amtSized.stats.gates}`);
  eqs(amtUnsized.stats.wasmBytes, amtSized.stats.wasmBytes,
    'リテラル幅: WASM のバイト数まで同じ',
    `サイズ無し=${amtUnsized.stats.wasmBytes} サイズ付き=${amtSized.stats.wasmBytes}`);

  // 加算の桁上げも「代入先を 1 ビット広くする」で受けられる
  const carry = `module c(input [3:0] a, input [3:0] b, output [3:0] s4, output [4:0] s5);
    assign s4 = a + b;
    assign s5 = a + b;
  endmodule`;
  const { wasm: cw } = await bothSims(carry);
  cw.setInput('a', 15).setInput('b', 1).eval();
  eq(cw.get('s4'), 0, '文脈依存幅: 15 + 1 を 4 ビットに代入すると 0');
  eq(cw.get('s5'), 16, '文脈依存幅: 5 ビットなら桁上げが残って 16');
}

// ------------------------------------------------------------------ ALU
//
// case の書き方 (複数ラベル・default) と、単項マイナス・中置 XNOR をまとめて通す。
async function testAlu() {
  const { all } = await bothSims(example('alu4.v'));
  for (const sim of all) {
    const kind = sim.constructor.name;
    let bad = null;
    for (const [a, b] of [[9, 5], [0, 0], [15, 1], [7, 7], [3, 12]]) {
      const want = [
        (a + b) & 15, (a - b) & 15, a & b, a | b, (-a) & 15,
        (~(a ^ b)) & 15, (~(a ^ b)) & 15, 0,
      ];
      for (let op = 0; op < 8; op++) {
        sim.reset().setInput('a', a).setInput('b', b).setInput('op', op).step();
        if (Number(sim.get('y')) !== want[op] && !bad) {
          bad = `op=${op} a=${a} b=${b} 期待 ${want[op]} / 実際 ${sim.get('y')}`;
        }
        if (Number(sim.get('eq')) !== (a === b ? 1 : 0) && !bad) {
          bad = `eq: a=${a} b=${b} 実際 ${sim.get('eq')}`;
        }
      }
    }
    ok(!bad, `${kind} alu4: 8 演算 × 5 組が一致`, bad ?? '');
  }

  // default に落ちるのは 3'd7 だけ、3'd5 と 3'd6 は同じ結果 (複数ラベル)
  const sim = (await bothSims(example('alu4.v'))).all[0];
  sim.reset().setInput('a', 9).setInput('b', 5).setInput('op', 5).step();
  const at5 = sim.get('y');
  sim.reset().setInput('a', 9).setInput('b', 5).setInput('op', 6).step();
  eq(sim.get('y'), at5, 'alu4: 複数ラベルはどちらも同じ結果');
  sim.reset().setInput('a', 9).setInput('b', 5).setInput('op', 7).step();
  eq(sim.get('y'), 0, 'alu4: 残りは default に落ちる');
}

// ---------------------------------------------------- 非 ANSI と多入力ゲート
async function testOnehot() {
  const { compiled, all } = await bothSims(example('onehot.v'));
  eqs(compiled.warnings.length, 0, 'onehot: 未駆動の警告なし', compiled.warnings.join(' / '));
  for (const sim of all) {
    const kind = sim.constructor.name;
    let bad = null;
    for (let v = 0; v < 8; v++) {
      const a = v & 1;
      const b = (v >> 1) & 1;
      const c = (v >> 2) & 1;
      sim.setInput('a', a).setInput('b', b).setInput('c', c).eval();
      const n = a + b + c;
      const expect = {
        any: n > 0 ? 1 : 0,
        all: n === 3 ? 1 : 0,
        none: n === 0 ? 1 : 0,
        exactly: n === 1 ? 1 : 0,
        copy: a,
      };
      for (const [port, want] of Object.entries(expect)) {
        if (Number(sim.get(port)) !== want && !bad) {
          bad = `${port}: a=${a} b=${b} c=${c} 期待 ${want} / 実際 ${sim.get(port)}`;
        }
      }
    }
    ok(!bad, `${kind} onehot: 非 ANSI ポート + 3 入力ゲートが全 8 通り一致`, bad ?? '');
  }
}

// ---------------------------------------------------------- リダクション演算子
//
// 全ビットを 1 個に畳むので、幅が奇数か偶数かで XNOR 系の答えが変わる。
// そこを外さないように、幅 4 と幅 3 の両方を並べて JS と突き合わせる。
async function testReduce() {
  const src = `module red(
  input [3:0] a,
  input [2:0] b,
  output rAnd, output rOr, output rXor,
  output rNand, output rNor, output rXnor, output rXnorAlt,
  output odd3, output xnor3,
  output [3:0] bitXnor, output caretNot,
  output [7:0] widened, output ofExpr, output single
);
  assign rAnd     = &a;
  assign rOr      = |a;
  assign rXor     = ^a;
  assign rNand    = ~&a;
  assign rNor     = ~|a;
  assign rXnor    = ~^a;
  assign rXnorAlt = ^~a;              // ~^ と同じ意味
  assign odd3     = ^b;               // 奇数幅のパリティ
  assign xnor3    = ~^b;
  assign bitXnor  = a ~^ {1'b0, b};   // 中置の XNOR (ビットごと)
  assign caretNot = a[0] ^ ~b[0];     // ^ ~ が 1 トークンに食われても同じ値
  assign widened  = &a;               // 結果 1 ビットなのでゼロ拡張される
  assign ofExpr   = ^(a & 4'h3);      // 式のリダクション
  assign single   = ^a[0];            // 1 ビットのリダクションは素通し
endmodule`;
  const { compiled, wasm, ref } = await bothSims(src);

  const par = (v, n) => {
    let p = 0;
    for (let i = 0; i < n; i++) p ^= (v >> i) & 1;
    return p;
  };

  let bad = null;
  for (let a = 0; a < 16 && !bad; a++) {
    for (let b = 0; b < 8 && !bad; b++) {
      for (const sim of [wasm, ref]) sim.setInput('a', a).setInput('b', b).eval();
      const expect = {
        rAnd: a === 15 ? 1 : 0,
        rOr: a !== 0 ? 1 : 0,
        rXor: par(a, 4),
        rNand: a === 15 ? 0 : 1,
        rNor: a !== 0 ? 0 : 1,
        rXnor: 1 - par(a, 4),
        rXnorAlt: 1 - par(a, 4),
        odd3: par(b, 3),
        xnor3: 1 - par(b, 3),
        bitXnor: (~(a ^ b)) & 15,
        caretNot: ((a & 1) ^ (~b & 1)) & 1,
        widened: a === 15 ? 1 : 0,
        ofExpr: par(a & 3, 4),
        single: a & 1,
      };
      for (const [port, want] of Object.entries(expect)) {
        for (const sim of [wasm, ref]) {
          if (Number(sim.get(port)) !== want && !bad) {
            bad = `${sim.constructor.name} ${port}: a=${a} b=${b} 期待 ${want} / 実際 ${sim.get(port)}`;
          }
        }
      }
    }
  }
  ok(!bad, 'リダクション: 全 16×8 通り × 14 出力が JS と一致', bad ?? '');

  // ~^ と ^~ が同じ回路になる (1 トークンとして扱えている証拠)
  const wrapped = (body) => `module m(input [3:0] a, output y); assign y = ${body}; endmodule`;
  eqs(compile(wrapped('~^a')).stats.gates, compile(wrapped('^~a')).stats.gates,
    'リダクション: ~^ と ^~ が同じ回路になる');
  // ^(~a) は幅が偶数だと ~^a と違う (別トークンに割れていないことの裏取り)
  const asOne = await WasmSimulator.create(compile(wrapped('~^a')));
  const asSplit = await WasmSimulator.create(compile(wrapped('^(~a)')));
  asOne.setInput('a', 0b0001).eval();
  asSplit.setInput('a', 0b0001).eval();
  eq(asOne.get('y'), 0, 'リダクション: ~^4\'b0001 は 0');
  eq(asSplit.get('y'), 1, 'リダクション: ^(~4\'b0001) は 1 (幅が偶数なので別物)');

  // ゲート数: 4 ビットのリダクションは 3 個、8 ビットなら 7 個
  const base = compile('module m(input [7:0] a, output y); assign y = a[0]; endmodule');
  const r4 = compile('module m(input [7:0] a, output y); assign y = ^a[3:0]; endmodule');
  const r8 = compile('module m(input [7:0] a, output y); assign y = ^a; endmodule');
  eqs(r4.stats.gates - base.stats.gates, 3, 'リダクション: 4 ビットは xor 3 個',
    `差分=${r4.stats.gates - base.stats.gates}`);
  eqs(r8.stats.gates - base.stats.gates, 7, 'リダクション: 8 ビットは xor 7 個',
    `差分=${r8.stats.gates - base.stats.gates}`);

  // 例題
  const { all: ps } = await bothSims(example('parity8.v'));
  for (const sim of ps) {
    const kind = sim.constructor.name;
    let pbad = null;
    for (let d = 0; d < 256; d++) {
      sim.setInput('d', d).eval();
      const p = par(d, 8);
      if (Number(sim.get('odd')) !== p) pbad = `odd: d=${d} 期待 ${p}`;
      else if (Number(sim.get('even')) !== 1 - p) pbad = `even: d=${d}`;
      else if (Number(sim.get('allOnes')) !== (d === 255 ? 1 : 0)) pbad = `allOnes: d=${d}`;
      else if (Number(sim.get('anyOne')) !== (d !== 0 ? 1 : 0)) pbad = `anyOne: d=${d}`;
      else if (Number(sim.get('withParity')) !== (p << 8 | d)) pbad = `withParity: d=${d}`;
      if (pbad) break;
    }
    ok(!pbad, `${kind} parity8: 全 256 通り一致`, pbad ?? '');
  }

  // 64 レーン
  wasm.reset();
  for (let lane = 0; lane < 64; lane++) wasm.setInputLane('a', lane, lane & 15);
  wasm.eval();
  const lanes = wasm.getLanes('rXor');
  let laneBad = 0;
  for (let lane = 0; lane < 64; lane++) {
    if (Number(lanes[lane]) !== par(lane & 15, 4)) laneBad++;
  }
  ok(laneBad === 0, 'リダクション: 64 レーンが独立にパリティを出す', `${laneBad} レーン不一致`);
}

// -------------------------------------------------------------- 論理演算子
//
// ビットごとに働く ~ / & / | と混同しやすいので、両方を並べて JS と比べる。
async function testLogical() {
  const src = `module lg(
  input [3:0] a,
  input [3:0] b,
  output land, output lor, output lnot, output dblNot,
  output [3:0] bitNot, output [3:0] bitAnd,
  output chain, output precBitOr, output precEq, output precUnary,
  output [7:0] widened, output tern, output selfAnd
);
  assign land   = a && b;
  assign lor    = a || b;
  assign lnot   = !a;
  assign dblNot = !!a;            // 0 でないか
  assign bitNot = ~a;             // ビットごと。!a と区別できるか
  assign bitAnd = a & b;
  assign chain  = a && b || !a;   // && は || より強い
  assign precBitOr = a | b && 4'h0;  // | は && より強い → (a|b) && 0
  assign precEq = a && b == b;    // == は && より強い → a && (b==b)
  assign precUnary = !a == 1'b1;  // 単項は == より強い → (!a) == 1
  assign widened = a && b;        // 結果は 1 ビットなのでゼロ拡張される
  assign tern = a || b ? 1'b1 : 1'b0;
  assign selfAnd = a && a;
endmodule`;
  const { wasm, ref } = await bothSims(src);

  let bad = null;
  for (let a = 0; a < 16 && !bad; a++) {
    for (let b = 0; b < 16 && !bad; b++) {
      for (const sim of [wasm, ref]) sim.setInput('a', a).setInput('b', b).eval();
      const A = a !== 0;
      const B = b !== 0;
      const expect = {
        land: A && B ? 1 : 0,
        lor: A || B ? 1 : 0,
        lnot: A ? 0 : 1,
        dblNot: A ? 1 : 0,
        bitNot: (~a) & 15,
        bitAnd: a & b,
        chain: (A && B) || !A ? 1 : 0,
        precBitOr: 0,                    // (a|b) && 0 は常に 0
        precEq: A ? 1 : 0,               // b == b は常に真
        precUnary: A ? 0 : 1,            // (!a) == 1
        widened: A && B ? 1 : 0,
        tern: A || B ? 1 : 0,
        selfAnd: A ? 1 : 0,
      };
      for (const [port, want] of Object.entries(expect)) {
        for (const sim of [wasm, ref]) {
          if (Number(sim.get(port)) !== want && !bad) {
            bad = `${sim.constructor.name} ${port}: a=${a} b=${b}`
              + ` 期待 ${want} / 実際 ${sim.get(port)}`;
          }
        }
      }
    }
  }
  ok(!bad, '論理演算子: 全 256 通りが JS の論理と一致 (優先順位込み)', bad ?? '');

  // ! と ~ の違いを 1 点で押さえる
  for (const sim of [wasm, ref]) sim.setInput('a', 0b0010).setInput('b', 1).eval();
  eq(wasm.get('lnot'), 0, '論理否定: !4\'b0010 は 0');
  eq(wasm.get('bitNot'), 0b1101, 'ビット反転: ~4\'b0010 は 4\'b1101');

  // 4 ビットの && は OR リダクション 3 個 × 2 辺 + and 1 個
  const plain = compile('module m(input [3:0] a, output y); assign y = a[0]; endmodule');
  const logAnd = compile('module m(input [3:0] a, input [3:0] b, output y); assign y = a && b; endmodule');
  eqs(logAnd.stats.gates - plain.stats.gates, 7,
    '論理演算子: 4 ビット同士の && は or 6 個 + and 1 個',
    `差分=${logAnd.stats.gates - plain.stats.gates}`);

  // 1 ビット同士なら潰す必要がないのでゲート 1 個
  const bit1 = compile('module m(input a, input b, output y); assign y = a && b; endmodule');
  const bit1ref = compile('module m(input a, input b, output y); assign y = a & b; endmodule');
  eqs(bit1.stats.gates, bit1ref.stats.gates,
    '論理演算子: 1 ビット同士の && は & と同じゲート数',
    `&&=${bit1.stats.gates} &=${bit1ref.stats.gates}`);

  // 64 レーン
  wasm.reset();
  for (let lane = 0; lane < 64; lane++) {
    wasm.setInputLane('a', lane, lane & 3).setInputLane('b', lane, (lane >> 2) & 3);
  }
  wasm.eval();
  const lanes = wasm.getLanes('land');
  let laneBad = 0;
  for (let lane = 0; lane < 64; lane++) {
    const want = (lane & 3) !== 0 && ((lane >> 2) & 3) !== 0 ? 1 : 0;
    if (Number(lanes[lane]) !== want) laneBad++;
  }
  ok(laneBad === 0, '論理演算子: 64 レーンが独立に評価される', `${laneBad} レーン不一致`);
}

// ------------------------------------------------ 論理演算子を使った回路
async function testWindow() {
  const { all } = await bothSims(example('window.v'));
  for (const sim of all) {
    const kind = sim.constructor.name;
    let bad = null;
    for (let x = 0; x < 16 && !bad; x++) {
      for (let lo = 0; lo < 16 && !bad; lo++) {
        for (let hi = 0; hi < 16 && !bad; hi++) {
          for (const valid of [0, 1]) {
            sim.setInput('x', x).setInput('lo', lo).setInput('hi', hi).setInput('valid', valid).eval();
            const inside = valid !== 0 && x >= lo && x <= hi ? 1 : 0;
            if (Number(sim.get('inside')) !== inside) {
              bad = `inside: x=${x} lo=${lo} hi=${hi} valid=${valid}`
                + ` 期待 ${inside} / 実際 ${sim.get('inside')}`;
            } else if (Number(sim.get('outside')) !== 1 - inside) {
              bad = `outside: x=${x} lo=${lo} hi=${hi} valid=${valid} 実際 ${sim.get('outside')}`;
            } else if (Number(sim.get('empty')) !== (lo > hi ? 1 : 0)) {
              bad = `empty: lo=${lo} hi=${hi} 実際 ${sim.get('empty')}`;
            }
            if (bad) break;
          }
        }
      }
    }
    ok(!bad, `${kind} window: 範囲判定が全 16×16×16×2 通り一致`, bad ?? '');
  }
}

// ------------------------------------------------------------------ シフト
//
// 定数シフトと可変シフトで幅の扱いが変わるので、両方を JS のシフトと比べる。
async function testShift() {
  // --- 定数シフトは並べ替えだけ ---
  // 素通しと比べて増えるのは $const0 の 1 個だけ。空いたビットに 0 を入れるために
  // 定数ゲートが生きるぶんで、シフト量に比例するゲートは 1 個も出ない。
  const plain = compile('module m(input [7:0] a, output [7:0] y); assign y = a; endmodule');
  const shifted = compile('module m(input [7:0] a, output [7:0] y); assign y = a << 3; endmodule');
  eqs(shifted.stats.gates, plain.stats.gates + 1,
    '定数シフト: 素通しに対して増えるのは $const0 の 1 個だけ',
    `素通し=${plain.stats.gates} シフト=${shifted.stats.gates}`);

  const sh1 = compile('module m(input [7:0] a, output [7:0] y); assign y = a << 1; endmodule');
  const sh7 = compile('module m(input [7:0] a, output [7:0] y); assign y = a >> 7; endmodule');
  eqs(sh1.stats.gates, sh7.stats.gates,
    '定数シフト: シフト量や向きを変えてもゲート数は同じ',
    `<<1=${sh1.stats.gates} >>7=${sh7.stats.gates}`);

  const src = `module sh(
  input [3:0] a,
  input [2:0] amt,
  input [3:0] wideAmt,
  output [3:0] l1, output [3:0] l2, output [3:0] r1, output [3:0] r2,
  output [7:0] grow, output [3:0] narrowShift, output [3:0] l9, output [3:0] r9,
  output [7:0] concatPack,
  output [3:0] vl, output [3:0] vr,
  output [3:0] vlWide, output [3:0] vrWide,
  output [7:0] prec1, output prec2,
  output [7:0] litAmt, output [7:0] sizedAmt, output [7:0] wrapAmt
);
  assign l1 = a << 1;
  assign l2 = a << 2;
  assign r1 = a >> 1;
  assign r2 = a >> 2;
  assign grow = a << 3;                // 8 ビット文脈なので押し出されない (文脈依存幅)
  assign narrowShift = a << 3;         // 4 ビット文脈だと押し出される
  assign l9 = a << 9;                  // 全部押し出される
  assign r9 = a >> 9;
  assign concatPack = {a, 4'h0} | a;   // 連接は文脈を受け取らないので常に 8 ビット
  assign vl = a << amt;                // バレルシフタ
  assign vr = a >> amt;
  assign vlWide = a << wideAmt;        // シフト量が幅より大きくなり得る
  assign vrWide = a >> wideAmt;
  assign prec1 = a + 1 << 2;           // 算術が先 → (a+1) << 2。8 ビット文脈で計算
  assign prec2 = a << 1 < amt;         // シフトが先 → (a<<1) < amt。比較の辺は自己決定
  assign litAmt = a << (1 + 1);           // サイズ無しリテラルは 32 ビットなので 1+1 = 2
  assign sizedAmt = a << (2'd1 + 2'd1);   // サイズ付きの 2 ビットでも 2
  assign wrapAmt = a << (15 + 1);         // 15+1 = 16。4 ビットで折り返さないので全部押し出される
endmodule`;
  const { wasm, ref } = await bothSims(src);

  let bad = null;
  for (let a = 0; a < 16 && !bad; a++) {
    for (let amt = 0; amt < 8 && !bad; amt++) {
      for (let wideAmt = 0; wideAmt < 16 && !bad; wideAmt++) {
        for (const sim of [wasm, ref]) {
          sim.setInput('a', a).setInput('amt', amt).setInput('wideAmt', wideAmt).eval();
        }
        const expect = {
          l1: (a << 1) & 15,
          l2: (a << 2) & 15,
          r1: a >> 1,
          r2: a >> 2,
          grow: (a << 3) & 255,          // 8 ビット文脈で計算されるので押し出されない
          narrowShift: (a << 3) & 15,    // 4 ビット文脈だと消える
          l9: 0,
          r9: 0,
          concatPack: ((a << 4) | a) & 255,
          vl: (a << amt) & 15,
          vr: (a >> amt) & 15,
          vlWide: (a << wideAmt) & 15,
          vrWide: wideAmt >= 4 ? 0 : (a >> wideAmt) & 15,
          prec1: ((a + 1) << 2) & 255,   // 8 ビット文脈が a+1 にも配られる
          prec2: ((a << 1) & 15) < amt ? 1 : 0,
          litAmt: (a << 2) & 255,
          sizedAmt: (a << 2) & 255,
          wrapAmt: 0,
        };
        for (const [port, want] of Object.entries(expect)) {
          for (const sim of [wasm, ref]) {
            if (Number(sim.get(port)) !== want && !bad) {
              bad = `${sim.constructor.name} ${port}: a=${a} amt=${amt} wideAmt=${wideAmt}`
                + ` 期待 ${want} / 実際 ${sim.get(port)}`;
            }
          }
        }
      }
    }
  }
  ok(!bad, 'シフト: 16 × 8 × 16 通りが JS のシフトと一致', bad ?? '');

  // 同じ `a << 3` が代入先の幅で変わる (文脈依存幅)。どちらも Verilog と一致する
  for (const sim of [wasm, ref]) {
    sim.setInput('a', 5).setInput('amt', 2).setInput('wideAmt', 2).eval();
  }
  eq(wasm.get('grow'), 40, 'シフト: 8 ビットに代入すると 5 << 3 は 40');
  eq(wasm.get('narrowShift'), 8, 'シフト: 4 ビットに代入すると 5 << 3 は 8');
  eq(wasm.get('l2'), 4, 'シフト: 4 ビット文脈の 5 << 2 は 4');
  eq(wasm.get('vlWide'), 4, 'シフト: 信号の量でも同じ (4 ビット文脈)');
  eq(wasm.get('concatPack'), 0x55, 'シフト: 連接は文脈に関係なく 8 ビット');

  // シフト量は文脈が配られない位置なので、リテラルの幅がそのまま効く。
  // サイズ無しリテラルは 32 ビットなので 1 + 1 は折り返さず 2 になる。
  eq(wasm.get('litAmt'), 20, 'リテラル幅: a << (1 + 1) は 5 << 2 = 20');
  eq(wasm.get('sizedAmt'), 20, 'リテラル幅: サイズ付きの 2\'d1 + 2\'d1 も同じ');
  eq(wasm.get('wrapAmt'), 0, 'リテラル幅: 15 + 1 は 4 ビットで折り返さず 16 になる');

  // バレルシフタの段数。定数シフト版との差が mux のぶんそのものになる
  const barrel = compile('module m(input [7:0] a, input [2:0] s, output [7:0] y); assign y = a << s; endmodule');
  eqs(barrel.stats.gates - shifted.stats.gates, 24,
    'シフト: 8 ビット × 3 ビット量のバレルシフタは mux 24 個',
    `差分=${barrel.stats.gates - shifted.stats.gates}`);

  // シフト量が幅を超え得るビットは、段を積まずに 1 段のマスクにまとめる
  const wide = compile('module m(input [7:0] a, input [7:0] s, output [7:0] y); assign y = a << s; endmodule');
  eqs(wide.stats.gates - shifted.stats.gates, 36,
    'シフト: 8 ビット量でも 24 + (or 4 + mux 8) で済む',
    `差分=${wide.stats.gates - shifted.stats.gates}`);

  // 64 レーンで別々のシフト量
  wasm.reset();
  for (let lane = 0; lane < 64; lane++) {
    wasm.setInputLane('a', lane, lane & 15).setInputLane('amt', lane, (lane >> 3) & 7);
  }
  wasm.eval();
  const lanes = wasm.getLanes('vl');
  let laneBad = 0;
  for (let lane = 0; lane < 64; lane++) {
    if (Number(lanes[lane]) !== (((lane & 15) << ((lane >> 3) & 7)) & 15)) laneBad++;
  }
  ok(laneBad === 0, 'シフト: 64 レーンが独立にシフトされる', `${laneBad} レーン不一致`);
}

// ---------------------------------------------------- シフトを使った回路
async function testShifter() {
  const { all } = await bothSims(example('shifter.v'));
  for (const sim of all) {
    const kind = sim.constructor.name;
    let bad = null;
    for (let hi = 0; hi < 16 && !bad; hi++) {
      for (let lo = 0; lo < 16 && !bad; lo++) {
        for (let amt = 0; amt < 8 && !bad; amt++) {
          sim.setInput('hi', hi).setInput('lo', lo).setInput('amt', amt).eval();
          const p = ((hi << 4) | lo) & 255;
          const want = ((p << amt) | (p >> (8 - amt))) & 255;
          if (Number(sim.get('packed')) !== p) {
            bad = `packed: hi=${hi} lo=${lo} 期待 ${p} / 実際 ${sim.get('packed')}`;
          } else if (Number(sim.get('shr')) !== (p >> 2)) {
            bad = `shr: p=${p} 期待 ${p >> 2} / 実際 ${sim.get('shr')}`;
          } else if (Number(sim.get('rotl')) !== want) {
            bad = `rotl: p=${p} amt=${amt} 期待 ${want} / 実際 ${sim.get('rotl')}`;
          }
        }
      }
    }
    ok(!bad, `${kind} shifter: 連接・定数シフト・左ローテートが全 16×16×8 通り一致`, bad ?? '');
  }
}

// ---------------------------------------------------------------- if / case
//
// 分岐は「代入されなかったビットは保持」がいちばん間違えやすいので、JS の素直な
// モデルをサイクルごとに突き合わせる。
async function testIfCase() {
  const src = `module ctrl(
  input clk,
  input [1:0] sel,
  input c,
  input [3:0] d,
  input [3:0] any,
  output reg [3:0] hold,
  output reg [3:0] both,
  output reg [3:0] chain,
  output reg [3:0] cse,
  output reg [3:0] multi,
  output reg [3:0] nodflt,
  output reg [3:0] lastwins,
  output reg [3:0] nest,
  output reg [3:0] dup,
  output reg [3:0] midDflt,
  output reg [3:0] wideCond
);
  always @(posedge clk) begin
    if (c) hold <= d;                       // else なし → 保持

    if (c) both <= d; else both <= 4'hF;

    if (sel == 2'b00) chain <= 4'h1;
    else if (sel == 2'b01) chain <= 4'h2;
    else if (sel == 2'b10) chain <= 4'h3;
    else chain <= 4'h4;

    case (sel)
      2'b00: cse <= 4'h9;
      2'b01: cse <= 4'hA;
      default: cse <= 4'h0;
    endcase

    case (sel)
      2'b00, 2'b11: multi <= 4'h5;          // 1 項目に複数ラベル
      default: multi <= 4'h6;
    endcase

    case (sel)
      2'b00: nodflt <= 4'h7;                // default なし → 他は保持
    endcase

    lastwins <= 4'h0;                       // 既定値を置いてから上書きする形
    if (c) lastwins <= d;

    case (sel)
      2'b01: begin
        if (c) nest <= 4'hC;
        else nest <= 4'hD;
      end
      default: nest <= 4'hE;
    endcase

    case (sel)
      2'b01: dup <= 4'h1;
      2'b01: dup <= 4'h2;                   // 上が勝つので到達しない
      default: dup <= 4'h0;
    endcase

    case (sel)
      2'b00: midDflt <= 4'h8;
      default: midDflt <= 4'h3;
      2'b10: midDflt <= 4'h9;               // default より後でも項目が優先される
    endcase

    if (any) wideCond <= 4'hA; else wideCond <= 4'hB;   // 4 ビット条件 → OR リダクション
  end
endmodule`;

  const { compiled, wasm, ref } = await bothSims(src);
  eqs(compiled.warnings.length, 0, 'if / case: 未駆動の警告なし', compiled.warnings.join(' / '));

  // 同じ意味を JS で素直に書いたもの
  const model = (st, sel, c, d, any) => ({
    hold: c ? d : st.hold,
    both: c ? d : 0xf,
    chain: sel === 0 ? 1 : sel === 1 ? 2 : sel === 2 ? 3 : 4,
    cse: sel === 0 ? 9 : sel === 1 ? 0xa : 0,
    multi: sel === 0 || sel === 3 ? 5 : 6,
    nodflt: sel === 0 ? 7 : st.nodflt,
    lastwins: c ? d : 0,
    nest: sel === 1 ? (c ? 0xc : 0xd) : 0xe,
    dup: sel === 1 ? 1 : 0,
    midDflt: sel === 0 ? 8 : sel === 2 ? 9 : 3,
    wideCond: any !== 0 ? 0xa : 0xb,
  });

  const ports = ['hold', 'both', 'chain', 'cse', 'multi', 'nodflt',
    'lastwins', 'nest', 'dup', 'midDflt', 'wideCond'];
  let st = {};
  for (const p of ports) st[p] = 0;

  const vectors = [
    [0, 0, 3, 0], [0, 1, 5, 1], [1, 1, 9, 0], [1, 0, 2, 8], [2, 1, 7, 0],
    [3, 0, 1, 5], [3, 1, 0xf, 0], [1, 1, 6, 2], [0, 0, 0, 0], [2, 0, 4, 15],
  ];
  let bad = null;
  for (const [sel, c, d, any] of vectors) {
    for (const sim of [wasm, ref]) {
      sim.setInput('sel', sel).setInput('c', c).setInput('d', d).setInput('any', any).step();
    }
    st = model(st, sel, c, d, any);
    for (const p of ports) {
      for (const sim of [wasm, ref]) {
        if (Number(sim.get(p)) !== st[p] && !bad) {
          bad = `${sim.constructor.name} ${p}: sel=${sel} c=${c} d=${d} any=${any}`
            + ` 期待 ${st[p]} / 実際 ${sim.get(p)}`;
        }
      }
    }
  }
  ok(!bad, `if / case: ${vectors.length} サイクル × ${ports.length} 出力が JS のモデルと一致`, bad ?? '');

  // 部分代入。触っていないビットは未駆動として 0 に固定される (既存の挙動)
  const part = compile(`module p(input clk, input [1:0] sel, output reg [3:0] q);
  always @(posedge clk) if (sel[0]) q[1:0] <= sel;
endmodule`);
  ok(/q\[2\], q\[3\]/.test(part.warnings[0] ?? ''),
    'if / case: 分岐の中の部分代入も未駆動検査に乗る', part.warnings.join(' / '));

  // if だけで代入されるレジスタは D に自分の Q が回り込む。組合せループにはならない
  const selfHold = await bothSims(`module h(input clk, input c, input [3:0] d, output reg [3:0] q);
  always @(posedge clk) if (c) q <= d;
endmodule`);
  for (const sim of selfHold.all) {
    const kind = sim.constructor.name;
    sim.reset().setInput('c', 1).setInput('d', 0xa).step();
    eq(sim.get('q'), 0xa, `${kind} 保持: c=1 で取り込む`);
    sim.setInput('c', 0).setInput('d', 0x5).run(4);
    eq(sim.get('q'), 0xa, `${kind} 保持: c=0 なら 4 クロック経っても変わらない`);
    sim.setInput('c', 1).step();
    eq(sim.get('q'), 0x5, `${kind} 保持: c=1 に戻すと取り込む`);
  }
}

// ------------------------------------------------------------------- FSM
async function testSeqDet() {
  const { compiled, all } = await bothSims(example('seqdet.v'));
  eqs(compiled.stats.regs, 3, 'seqdet: state 2 ビット + found 1 ビット');

  const step = (st, din) => {
    if (st === 0) return [din ? 1 : 0, 0];
    if (st === 1) return [din ? 1 : 2, 0];
    if (st === 2) return [din ? 3 : 0, 0];
    return din ? [1, 1] : [2, 0];
  };

  const stream = [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1];
  for (const sim of all) {
    const kind = sim.constructor.name;
    sim.reset();
    let st = 0;
    const hits = [];
    let bad = null;
    stream.forEach((din, i) => {
      sim.setInput('din', din).step();
      const [ns, f] = step(st, din);
      st = ns;
      if (f) hits.push(i);
      if ((Number(sim.get('state')) !== st || Number(sim.get('found')) !== f) && !bad) {
        bad = `i=${i} din=${din} 実際(state=${sim.get('state')},found=${sim.get('found')})`
          + ` 期待(state=${st},found=${f})`;
      }
    });
    ok(!bad, `${kind} seqdet: 20 サイクルがモデルと一致`, bad ?? '');
    eqs(hits.join(','), '3,6,9,13,19', `${kind} seqdet: "1011" の終端位置で検出`);
  }
}

// -------------------------------------------------------------- カウンタ
async function testCounter8() {
  const { all } = await bothSims(example('counter8.v'));
  for (const sim of all) {
    const kind = sim.constructor.name;
    sim.reset().setInput('clr', 0).setInput('en', 1);
    for (let i = 1; i <= 20; i++) {
      sim.step();
      eq(sim.get('q'), i, `${kind} counter8: ${i} クロック目`);
    }
    sim.setInput('en', 0).run(5);
    eq(sim.get('q'), 20, `${kind} counter8: en=0 で止まる`);

    // 255 まで進めて 0 に回るところ
    sim.reset().setInput('en', 1).setInput('clr', 0).run(255);
    eq(sim.get('q'), 255, `${kind} counter8: 255 まで数える`);
    sim.step();
    eq(sim.get('q'), 0, `${kind} counter8: 255 の次は 0`);

    sim.run(7);
    sim.setInput('clr', 1).step();
    eq(sim.get('q'), 0, `${kind} counter8: clr=1 でクリア`);
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
    ['単独の negedge は未対応',
      `module m(input clk, a, output reg q); always @(negedge clk) q <= a; endmodule`,
      /negedge/],
    ['非同期リセットの本体が if でない',
      `module m(input clk, rst, d, output reg q);
       always @(posedge clk or posedge rst) q <= d; endmodule`,
      /本体全体を if/],
    ['リセット条件がどちらの信号か決まらない',
      `module m(input clk, rst, c, d, output reg q);
       always @(posedge clk or posedge rst) if (c) q <= 1'b0; else q <= d; endmodule`,
      /どちらを見ているか決まらない/],
    ['クロックが negedge',
      `module m(input clk, rst, d, output reg q);
       always @(negedge clk or posedge rst) if (rst) q <= 1'b0; else q <= d; endmodule`,
      /posedge でなければならない/],
    ['イベントが 3 つ',
      `module m(input clk, a, b, d, output reg q);
       always @(posedge clk or posedge a or posedge b) if (a) q <= 1'b0; else q <= d; endmodule`,
      /イベントは 2 つまで/],
    ['非同期リセットが多ビット',
      `module m(input clk, input [1:0] rst, input d, output reg q);
       always @(posedge clk or posedge rst) if (rst) q <= 1'b0; else q <= d; endmodule`,
      /1 ビットでなければならない/],
    ['ブロッキング代入の誤用',
      `module m(input clk, a, output reg q); always @(posedge clk) q = a; endmodule`,
      /ノンブロッキング/],
    ['無い module のインスタンス化',
      `module m(input a, output y); sub u0(y, a); endmodule`,
      /module 'sub' が見つからない/],
    ['ポートの数が多い',
      `module sub(input a, output y); assign y = ~a; endmodule
       module m(input a, output y); sub u0(a, y, a); endmodule`,
      /ポートは 2 個だが 3 個/],
    ['無いポート名',
      `module sub(input a, output y); assign y = ~a; endmodule
       module m(input a, output y); sub u0(.a(a), .zz(y)); endmodule`,
      /にポート 'zz' は無い/],
    ['ポート接続の名前と順番の混在',
      `module sub(input a, output y); assign y = ~a; endmodule
       module m(input a, output y); sub u0(a, .y(y)); endmodule`,
      /混ぜられない/],
    ['出力ポートに式をつなぐ',
      `module sub(input a, output y); assign y = ~a; endmodule
       module m(input a, output y); sub u0(.a(a), .y(a & a)); endmodule`,
      /信号名をつなぐ/],
    ['インスタンス名の重複',
      `module sub(input a, output y); assign y = ~a; endmodule
       module m(input a, output y, output z); sub u0(a, y); sub u0(a, z); endmodule`,
      /インスタンス名 'u0' が重複/],
    ['自己再帰するインスタンス化',
      `module m(input a, output y); m u0(a, y); endmodule`,
      /自分自身を含んでいる/],
    ['相互再帰するインスタンス化',
      `module p(input a, output y); q u0(a, y); endmodule
       module q(input a, output y); p u0(a, y); endmodule`,
      /自分自身を含んでいる/],
    ['無い parameter を指定',
      `module leaf #(parameter W = 4) (input a, output y); assign y = ~a; endmodule
       module m(input a, output y); leaf #(.NOPE(1)) u0(a, y); endmodule`,
      /parameter 'NOPE' は無い/],
    ['localparam は差し替えられない',
      `module leaf(input a, output y); localparam L = 1; assign y = ~a; endmodule
       module m(input a, output y); leaf #(.L(2)) u0(a, y); endmodule`,
      /localparam は差し替えられない/],
    ['parameter の順番指定が多すぎる',
      `module leaf #(parameter W = 4) (input a, output y); assign y = ~a; endmodule
       module m(input a, output y); leaf #(1, 2) u0(a, y); endmodule`,
      /parameter は 1 個だが 2 個目/],
    ['同じ parameter を 2 回指定',
      `module leaf #(parameter W = 4) (input a, output y); assign y = ~a; endmodule
       module m(input a, output y); leaf #(.W(1), .W(2)) u0(a, y); endmodule`,
      /parameter 'W' を 2 回指定/],
    ['parameter 指定の名前と順番の混在',
      `module leaf #(parameter W = 4) (input a, output y); assign y = ~a; endmodule
       module m(input a, output y); leaf #(1, .W(2)) u0(a, y); endmodule`,
      /名前指定と順番指定を混ぜられない/],
    ['信号は定数式に使えない',
      `module m(input [3:0] a, output y); wire [a:0] w; assign y = ~a[0]; endmodule`,
      /定数式に使えない/],
    ['定数式の単項 ~ は未対応',
      `module m(output y); parameter P = ~1; assign y = 1'b0; endmodule`,
      /定数式では単項/],
    ['parameter は信号にできない',
      `module m(output y); parameter P = 1; assign P = 1'b0; endmodule`,
      /parameter なので信号として使えない/],
    ['parameter の幅指定は未対応',
      `module m(output y); parameter [3:0] P = 1; assign y = 1'b0; endmodule`,
      /parameter の幅指定は未対応/],
    ['幅が負になる範囲',
      `module m #(parameter W = 0) (output [W-2:0] y); assign y = 0; endmodule`,
      /ビット範囲 \[-2:0\] が不正/],
    ['乗算は未対応',
      `module m(input [3:0] a, output [7:0] y); assign y = a * a; endmodule`,
      /解釈できない文字/],
    ['=== は未対応',
      `module m(input [3:0] a, output y); assign y = a === 4'h3; endmodule`,
      /=== は未対応/],
    ['<<< は未対応',
      `module m(input [3:0] a, output [3:0] y); assign y = a <<< 1; endmodule`,
      /<<< は未対応/],
    ['>>> は未対応',
      `module m(input [3:0] a, output [3:0] y); assign y = a >>> 1; endmodule`,
      />>> は未対応/],
    ['initial は未対応',
      `module m(output reg y); initial y = 1'b0; endmodule`,
      /'initial' は未対応/],
    ['generate は未対応',
      `module m(input a, output y); generate assign y = ~a; endgenerate endmodule`,
      /'generate' は未対応/],
    ['always_comb は未対応',
      `module m(input a, output reg y); always_comb y = ~a; endmodule`,
      /'always_comb' は未対応/],
    ['casez は未対応',
      `module m(input clk, input [1:0] s, output reg q);
       always @(posedge clk) casez (s) 2'b00: q <= 1'b1; endcase endmodule`,
      /casez は未対応/],
    ['endcase 忘れ',
      `module m(input clk, input [1:0] s, output reg q);
       always @(posedge clk) case (s) 2'b00: q <= 1'b1; endmodule`,
      /'endcase' が見つからない/],
    ['end 忘れ',
      `module m(input clk, input a, output reg q);
       always @(posedge clk) begin if (a) q <= 1'b1; endmodule`,
      /'end' が見つからない/],
    ['空の case',
      `module m(input clk, input [1:0] s, output reg q);
       always @(posedge clk) case (s) endcase endmodule`,
      /case の中身が空/],
    ['default が 2 つ',
      `module m(input clk, input [1:0] s, output reg q);
       always @(posedge clk) case (s) default: q <= 1'b1; default: q <= 1'b0; endcase endmodule`,
      /default が 2 つ/],
    ['if の中でブロッキング代入',
      `module m(input clk, input a, output reg q); always @(posedge clk) if (a) q = 1'b1; endmodule`,
      /ノンブロッキング/],
    ['if で wire を駆動',
      `module m(input clk, input a, output y); always @(posedge clk) if (a) y <= 1'b1; endmodule`,
      /reg 宣言が必要/],
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
    if (r < 0.4) return `(~${expr(depth - 1)})`;
    if (r < 0.52) return `(${expr(depth - 1)} & ${expr(depth - 1)})`;
    if (r < 0.62) return `(${expr(depth - 1)} | ${expr(depth - 1)})`;
    if (r < 0.72) return `(${expr(depth - 1)} ^ ${expr(depth - 1)})`;
    if (r < 0.75) {
      const lg = ['&&', '||'][Math.floor(rng() * 2)];
      return `(${expr(depth - 1)} ${lg} ${expr(depth - 1)})`;
    }
    if (r < 0.77) return `(!${expr(depth - 1)})`;
    if (r < 0.8) {
      // リダクション。~& / ~| / ~^ も混ぜる
      const red = ['&', '|', '^', '~&', '~|', '~^'][Math.floor(rng() * 6)];
      return `(${red}${expr(depth - 1)})`;
    }
    if (r < 0.82) return `(${expr(depth - 1)} + ${expr(depth - 1)})`;
    if (r < 0.85) return `(${expr(depth - 1)} - ${expr(depth - 1)})`;
    if (r < 0.87) return `(-${expr(depth - 1)})`;
    if (r < 0.9) {
      const cmp = ['==', '!=', '<', '<=', '>', '>='][Math.floor(rng() * 6)];
      return `(${expr(depth - 1)} ${cmp} ${expr(depth - 1)})`;
    }
    if (r < 0.94) {
      // リテラル量 (並べ替え) と信号量 (バレルシフタ) の両方を出す
      const op = rng() < 0.5 ? '<<' : '>>';
      const amt = rng() < 0.5 ? String(Math.floor(rng() * 10)) : expr(0);
      return `(${expr(depth - 1)} ${op} ${amt})`;
    }
    if (r < 0.97) return `(${expr(depth - 1)} ? ${expr(depth - 1)} : ${expr(depth - 1)})`;
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

  // 分岐のある always ブロックも 1 本入れる。mux 木がコード生成まで通るか見る。
  // 分岐の中身は begin...end で囲んで、dangling else を生まないようにする。
  lines.unshift('  reg [7:0] r2;');
  const stmt = (depth) => {
    const r = rng();
    if (depth <= 0 || r < 0.4) return `r2 <= ${expr(2)};`;
    if (r < 0.7) {
      const then = `begin ${stmt(depth - 1)} end`;
      const els = rng() < 0.5 ? ` else begin ${stmt(depth - 1)} end` : '';
      return `if (${expr(2)}) ${then}${els}`;
    }
    const arms = [`2'd0: begin ${stmt(depth - 1)} end`, `2'd1: begin ${stmt(depth - 1)} end`];
    if (rng() < 0.7) arms.push(`default: begin ${stmt(depth - 1)} end`);
    return `case (${expr(1)}) ${arms.join(' ')} endcase`;
  };
  lines.push(`  always @(posedge clk) begin ${stmt(3)} end`);
  lines.push(`  assign rout2 = r2;`);

  // 非同期リセット付きのレジスタも 1 本。eval で Q を書き戻す経路が WASM と
  // 参照実装で別実装なので、ここを差分テストに通したい。
  lines.unshift('  reg [7:0] r3;');
  lines.push(`  always @(posedge clk or posedge rst)`);
  lines.push(`    if (rst) r3 <= ${expr(1)};`);
  lines.push(`    else r3 <= ${expr(2)};`);
  lines.push(`  assign rout3 = r3;`);
  lines.push(`  assign rout4 = subOut ^ subOut2;`);

  // 部品を 1 個インスタンス化する。境界をまたぐ buf と平坦化を差分テストに通す。
  // 子の中身は自分のポートだけで書く必要があるので、プールを一時的に差し替える
  const parentPool = [...pool];
  pool.length = 0;
  pool.push('p', 'q');
  const subBody = expr(2);
  pool.length = 0;
  pool.push(...parentPool);

  // パラメータ付きで 2 回インスタンス化して、同じ module が別の幅で展開されるのを見る
  const shiftBy = 1 + Math.floor(rng() * 4);
  lines.push(`  wire [7:0] subOut, subOut2;`);
  lines.push(`  rndsub s0(.p(${pick(pool)}), .q(${pick(pool)}), .r(subOut));`);
  lines.push(`  rndsub #(.SH(${shiftBy})) s1(.p(${pick(pool)}), .q(${pick(pool)}), .r(subOut2));`);
  pool.push('subOut', 'subOut2');

  lines.push(`  assign y = ${expr(3)};`);

  return `module rndsub #(parameter SH = 0) (input [7:0] p, input [7:0] q, output [7:0] r);
  localparam SH2 = SH + SH;
  assign r = (${subBody}) << SH2;
endmodule

module rnd(
  input clk,
  input rst,
  input [7:0] a,
  input [7:0] b,
  input [7:0] c,
  output [7:0] y,
  output [7:0] rout,
  output [7:0] rout2,
  output [7:0] rout3,
  output [7:0] rout4
);
${lines.join('\n')}
  assign rout = r;
endmodule`;
}

async function testRandomDiff() {
  const rng = makeRng(20260731);
  let designs = 0;
  let mismatch = null;

  // 生成器が特定の構文を作らなくなったことに気づけるように数えておく
  const seen = {
    'if': 0, 'case': 0, '+ / -': 0, '比較': 0, 'シフト': 0, '論理': 0,
    '非同期リセット': 0, '階層': 0, 'parameter': 0, 'リダクション': 0,
  };

  for (let d = 0; d < 25 && !mismatch; d++) {
    const src = randomDesign(rng, 6);
    if (/\bif \(/.test(src)) seen['if']++;
    if (/\bcase \(/.test(src)) seen['case']++;
    if (/[-+] /.test(src)) seen['+ / -']++;
    if (/(==|!=|<=|>=|< |> )/.test(src)) seen['比較']++;
    if (/(<<|>>)/.test(src)) seen['シフト']++;
    if (/(&&|\|\||\(!)/.test(src)) seen['論理']++;
    if (/or posedge rst/.test(src)) seen['非同期リセット']++;
    if (/rndsub s0\(/.test(src)) seen['階層']++;
    if (/rndsub #\(\.SH\(/.test(src)) seen['parameter']++;
    if (/\((&|\||\^|~&|~\||~\^)[(a-z]/.test(src)) seen['リダクション']++;
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
      // rst は 1/4 の頻度で上げる。上げた回は step ではなく eval だけを回して、
      // 「クロックなしで Q が変わる」経路も両実装で突き合わせる
      const rst = rng() < 0.25 ? 1 : 0;
      for (const sim of [wasm, ref]) {
        sim.setInput('a', a).setInput('b', b).setInput('c', c).setInput('rst', rst);
      }
      if (rst) {
        wasm.eval();
        ref.eval();
      } else {
        wasm.step();
        ref.step();
      }
      for (const port of ['y', 'rout', 'rout2', 'rout3', 'rout4']) {
        if (wasm.get(port) !== ref.get(port)) {
          mismatch = `${port}: wasm=${wasm.get(port)} ref=${ref.get(port)}`
            + ` (a=${a} b=${b} c=${c} rst=${rst} t=${t})\n${src}`;
        }
      }
    }
  }

  ok(designs === 25, 'ランダム差分: 25 回路すべてコンパイルできた', `designs=${designs}`);
  const missing = Object.entries(seen).filter(([, n]) => n === 0).map(([k]) => k);
  ok(missing.length === 0, 'ランダム差分: 生成器が全構文を出している',
    `出ていない構文: ${missing.join(', ')} / 内訳 ${JSON.stringify(seen)}`);
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
}

async function testBlockMemory() {
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
}

async function testBarrel() {
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
}

async function testPortNames() {
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
}

async function testBlocks() {
  // ---- 回路部品 (block) ----
  // 半加算器を「保存した回路」に見立てて、2 個から全加算器を組む
  const halfDef = packCircuit(expandCircuit(SAMPLE_CIRCUITS['半加算器 (sum / carry)']));
  const halfPorts = blockPorts(halfDef);
  eqs(halfPorts.inputs.join(','), 'a,b', '部品: 中身の入力が端子になる');
  eqs(halfPorts.outputs.join(','), 'sum,carry', '部品: 中身の出力が端子になる (名前もそのまま)');

  const fullAdder = {
    nodes: [
      [1, 'in', 20, 40, 1, 'a'], [2, 'in', 20, 140, 1, 'b'], [3, 'in', 20, 300, 1, 'cin'],
      [10, 'block', 200, 60, 0, null, { ref: '半加算器', def: halfDef }],
      [11, 'block', 420, 200, 0, null, { ref: '半加算器', def: halfDef }],
      [20, 'or', 640, 320],
      [30, 'out', 800, 200, 0, 'sum'], [31, 'out', 800, 340, 0, 'cout'],
    ],
    wires: [
      [1, 0, 10, 0], [2, 0, 10, 1],       // a, b → 1 段目
      [10, 0, 11, 0], [3, 0, 11, 1],      // 1 段目の sum, cin → 2 段目
      [11, 0, 30, 0],                     // 2 段目の sum → sum
      [10, 1, 20, 0], [11, 1, 20, 1],     // 桁上がり 2 本 → OR
      [20, 0, 31, 0],
    ],
  };
  const fa = expandCircuit(fullAdder);
  eq(insOf(fa.nodes.find((n) => n.id === 10)), 2, '部品: 入力端子は 2 個');
  eq(outsOf(fa.nodes.find((n) => n.id === 10)), 2, '部品: 出力端子は 2 個');
  eq(fa.wires.length, 8, '部品: 端子番号 1 への配線も通る');

  const flatFa = flattenGraph(fa);
  ok(flatFa.nodes.every((n) => n.type !== 'block'), '平坦化: ブロックは残らない');
  eq(flatFa.outletOf.size, 4, '平坦化: 出力端子ぶんの観測点ができる');

  const faPlan = toVerilog(fa);
  ok(!faPlan.source.includes('block'), '平坦化: Verilog は 1 個の module');
  ok(faPlan.source.includes('assign u10_a = a;'), '平坦化: 端子は中継の assign になる', faPlan.source);
  ok(faPlan.source.includes('u10_n3 = u10_a ^ u10_b'), '平坦化: 中身の信号に u<id>_ が付く', faPlan.source);
  eqs(faPlan.inputs.map((i) => i.name).join(','), 'a,b,cin', '平坦化: 最上位の入力だけがポート');

  const { all: faSims } = await bothSims(faPlan.source);
  for (const sim of faSims) {
    for (let v = 0; v < 8; v++) {
      const a = v & 1, b = (v >> 1) & 1, cin = (v >> 2) & 1;
      sim.setInput('a', a).setInput('b', b).setInput('cin', cin).eval();
      const total = a + b + cin;
      eq(sim.get('sum'), total & 1, `${sim.constructor.name} 部品: 全加算器 sum(${a},${b},${cin})`);
      eq(sim.get('cout'), total >> 1, `${sim.constructor.name} 部品: 全加算器 cout(${a},${b},${cin})`);
    }
  }

  // 部品の中の値も観測できる (画面で端子に色を付けるため)
  const faSim = await WasmSimulator.create(compile(faPlan.source));
  faSim.setInput('a', 1).setInput('b', 1).setInput('cin', 0).eval();
  const carry1 = faPlan.signalOf.get(faPlan.outletOf.get('10:1'));
  eq(faSim.get(carry1), 1, '部品: 出力端子 (1 段目の carry) の値を読める');

  // 入れ子: 全加算器を部品にして 2 個並べる (2 ビット加算器)
  const faDef = packCircuit(fa);
  const nested = expandCircuit({
    nodes: [
      [1, 'in', 20, 20, 0, 'a0'], [2, 'in', 20, 80, 0, 'b0'],
      [3, 'in', 20, 140, 0, 'a1'], [4, 'in', 20, 200, 0, 'b1'],
      [5, 'const', 20, 260, 0],
      [10, 'block', 200, 20, 0, null, { ref: '全加算器', def: faDef }],
      [11, 'block', 200, 200, 0, null, { ref: '全加算器', def: faDef }],
      [20, 'out', 500, 20, 0, 's0'], [21, 'out', 500, 100, 0, 's1'], [22, 'out', 500, 180, 0, 'c2'],
    ],
    wires: [
      [1, 0, 10, 0], [2, 0, 10, 1], [5, 0, 10, 2],
      [3, 0, 11, 0], [4, 0, 11, 1], [10, 1, 11, 2],
      [10, 0, 20, 0], [11, 0, 21, 0], [11, 1, 22, 0],
    ],
  });
  const nestedPlan = toVerilog(nested);
  ok(nestedPlan.source.includes('u10_u10_'), '入れ子: 2 段の接頭辞が付く');
  const { wasm: nsim } = await bothSims(nestedPlan.source);
  let addBad = 0;
  for (let v = 0; v < 16; v++) {
    const a = v & 3, b = (v >> 2) & 3;
    nestedPlan.inputs.forEach((i) => {
      const bit = { a0: a & 1, a1: (a >> 1) & 1, b0: b & 1, b1: (b >> 1) & 1 }[i.name];
      nsim.setInput(i.name, bit);
    });
    nsim.eval();
    const got = Number(nsim.get('s0')) + 2 * Number(nsim.get('s1')) + 4 * Number(nsim.get('c2'));
    if (got !== a + b) { addBad++; }
  }
  eq(addBad, 0, '入れ子: 全加算器 2 個で 2 ビットの足し算になる');

  // メモリを含む回路も部品にできる
  const memDef = packCircuit(expandCircuit(SAMPLE_CIRCUITS['書き込みイネーブル付き 1 ビットメモリ']));
  const withMem = expandCircuit({
    nodes: [
      [1, 'in', 20, 20, 1, 'din'], [2, 'in', 20, 100, 1, 'wr'],
      [10, 'block', 200, 20, 0, null, { ref: 'メモリ', def: memDef }],
      [20, 'out', 500, 20, 0, 'q'],
    ],
    wires: [[1, 0, 10, 0], [2, 0, 10, 1], [10, 0, 20, 0]],
  });
  const memPlan = toVerilog(withMem);
  ok(memPlan.source.includes('always @(posedge clk)'), '部品: 中のメモリも動く形になる', memPlan.source);
  eq(memPlan.regs.length, 1, '部品: メモリは 1 個');
  const { wasm: msim } = await bothSims(memPlan.source);
  msim.reset().setInput('din', 1).setInput('wr', 1).eval();
  eq(msim.get('q'), 0, '部品: クロック前は 0');
  msim.step();
  eq(msim.get('q'), 1, '部品: 中のメモリに書ける');
  msim.setInput('wr', 0).setInput('din', 0).eval();
  msim.step(); msim.step();
  eq(msim.get('q'), 1, '部品: 中のメモリが保持する');

  // 保存・共有リンクは中身を埋め込んでいるので単体で完結する
  const faLink = decodeCircuit(encodeCircuit(fa));
  eqs(JSON.stringify(packCircuit(faLink)), JSON.stringify(packCircuit(fa)),
    '部品: リンク経由でも中身ごと往復する');
  eq(toVerilog(faLink).inputs.length, 3, '部品: 復元した回路も同じようにコンパイルできる');

  // 壊れた部品は弾く
  for (const [nodes, why] of [
    [[[1, 'block', 0, 0, 0, null]], '中身が無い'],
    [[[1, 'block', 0, 0, 0, null, { def: null }]], 'def が null'],
    [[[1, 'block', 0, 0, 0, null, { def: { nodes: 'x', wires: [] } }]], 'def の形が違う'],
    [[[1, 'block', 0, 0, 0, null, { def: { nodes: [[1, 'zzz', 0, 0]], wires: [] } }]], '中身に知らない部品'],
    [[[1, 'alias', 0, 0]], '内部用の部品を直接置く'],
  ]) {
    let err = null;
    try { expandCircuit({ nodes, wires: [] }); } catch (e) { err = e; }
    ok(err !== null, `部品: ${why} を弾く`, err ? '' : '通ってしまった');
  }

  // 入れ子が深すぎるものは弾く
  let deep = { nodes: [[1, 'in', 0, 0, 0, 'x'], [2, 'out', 100, 0, 0, 'y']], wires: [[1, 0, 2, 0]] };
  for (let i = 0; i < MAX_DEPTH_TEST; i++) {
    deep = { nodes: [[1, 'block', 0, 0, 0, null, { ref: `d${i}`, def: deep }]], wires: [] };
  }
  let deepErr = null;
  try { expandCircuit(deep); } catch (e) { deepErr = e; }
  ok(deepErr !== null && /入れ子/.test(deepErr.message), '部品: 深すぎる入れ子を弾く',
    deepErr?.message ?? '通ってしまった');
}

async function testSaveFormat() {
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

  // ---- 幅 (バス) ----
  // 幅を持つのは in / const / dff だけ。ゲートと out は駆動元から伝播する。
  const bus = expandCircuit({
    nodes: [[1, 'in', 0, 0, 10, 'a', null, 4], [2, 'in', 0, 100, 3, 'b', null, 4],
      [3, 'and', 200, 50], [4, 'out', 400, 50, 0, 'y']],
    wires: [[1, 0, 3, 0], [2, 0, 3, 1], [3, 0, 4, 0]],
  });
  eq(bus.nodes[0].w, 4, '幅: 保存形式から幅が読める');
  eq(bus.nodes[0].value, 10, '幅: 幅ぶんの値が残る');
  eqs(JSON.stringify(expandCircuit(packCircuit(bus))), JSON.stringify(bus),
    '幅: 幅つきの回路が往復して一致する');
  eqs(JSON.stringify(decodeCircuit(encodeCircuit(bus))), JSON.stringify(bus),
    '幅: リンク経由でも一致する');

  const busPlan = toVerilog(bus);
  ok(busPlan.source.includes('input  [3:0] a'), '幅: 入力ポートに幅が付く', busPlan.source);
  ok(busPlan.source.includes('output [3:0] n3'), '幅: ゲートに幅が伝播する', busPlan.source);
  ok(busPlan.source.includes('output [3:0] y'), '幅: 出力に幅が伝播する', busPlan.source);
  ok(busPlan.source.includes('assign n3 = a & b;'),
    '幅: 本体の式は 1 ビットのときと同じ (宣言だけが変わる)', busPlan.source);
  eqs(busPlan.widthErrors.length, 0, '幅: 揃っていれば幅エラーなし');

  // 幅が合わないゲートは未配線と同じく下流ごと外れる
  const bad = toVerilog(expandCircuit({
    nodes: [[1, 'in', 0, 0, 0, 'a', null, 4], [2, 'in', 0, 100, 0, 'b'],
      [3, 'and', 200, 50], [4, 'out', 400, 50, 0, 'y']],
    wires: [[1, 0, 3, 0], [2, 0, 3, 1], [3, 0, 4, 0]],
  }));
  eqs(bad.widthErrors.join(','), 'n3', '幅: 揃っていないゲートを報告する');
  ok(bad.incomplete.has(3) && bad.incomplete.has(4),
    '幅: 揃っていないゲートと下流が除外される', [...bad.incomplete].join(','));
  ok(!bad.source.includes('assign'), '幅: 除外されたので式が出ない', bad.source);

  // dff は自分で幅を持つ (帰還があると伝播で決まらないため)
  const toggle = toVerilog(expandCircuit({
    nodes: [[1, 'dff', 100, 0, 0, 'm', null, 4], [2, 'not', 300, 0], [3, 'out', 500, 0, 0, 'q']],
    wires: [[1, 0, 2, 0], [2, 0, 1, 0], [1, 0, 3, 0]],
  }));
  ok(toggle.source.includes('output reg [3:0] m'), '幅: メモリに幅が付く', toggle.source);
  ok(toggle.source.includes('output [3:0] n2'), '幅: 帰還の先にも伝播する', toggle.source);
  eqs(toggle.widthErrors.length, 0, '幅: 帰還だけでも幅が決まる');

  // 多ビット定数はサイズ付きリテラルになる
  const konst = toVerilog(expandCircuit({
    nodes: [[1, 'const', 0, 0, 10, null, null, 4], [2, 'out', 200, 0, 0, 'y']],
    wires: [[1, 0, 2, 0]],
  }));
  ok(/assign \w+ = 4'd10;/.test(konst.source), '幅: 多ビット定数は 4\'d10 になる', konst.source);

  // 幅 1 は今までどおり (角括弧も 1'b も変わらない)
  const one = toVerilog(expandCircuit({
    nodes: [[1, 'const', 0, 0, 1], [2, 'out', 200, 0, 0, 'y']],
    wires: [[1, 0, 2, 0]],
  }));
  ok(!one.source.includes('['), '幅: 幅 1 なら [0:0] を書かない', one.source);
  ok(one.source.includes("1'b1"), '幅: 幅 1 の定数は 1\'b1 のまま', one.source);

  // 生成した Verilog を実際に走らせて値を確かめる
  const busSim = await WasmSimulator.create(compile(busPlan.source));
  let busBad = 0;
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      busSim.setInput('a', a).setInput('b', b).eval();
      if (Number(busSim.get('y')) !== (a & b)) busBad++;
    }
  }
  eqs(busBad, 0, '幅: 4 ビットの AND が全 256 通り正しい');

  // 4 ビットのトグル (メモリ + NOT の帰還)
  const toggleSim = await WasmSimulator.create(compile(toggle.source));
  toggleSim.reset();
  toggleSim.step();
  eq(toggleSim.get('q'), 15, '幅: 4 ビットのトグルは 1 クロックで F');
  toggleSim.step();
  eq(toggleSim.get('q'), 0, '幅: もう 1 クロックで 0 に戻る');

  // ---- 幅を混ぜる部品 (ビット取り出し / 連接) と算術・比較・選択 ----
  const build = async (label, data, checks) => {
    const p = toVerilog(expandCircuit(data));
    eqs(p.widthErrors.length, 0, `${label}: 幅エラーなし`, p.widthErrors.join(','));
    const s = await WasmSimulator.create(compile(p.source));
    let bad = null;
    for (const [set, want] of checks) {
      for (const [k, v] of Object.entries(set)) s.setInput(k, v);
      s.eval();
      for (const [k, v] of Object.entries(want)) {
        if (Number(s.get(k)) !== v && !bad) {
          bad = `${JSON.stringify(set)} → ${k}=${s.get(k)} (期待 ${v})`;
        }
      }
    }
    ok(!bad, `${label}: 値が正しい`, bad ?? '');
    return p;
  };

  // ビット取り出しは添字を value に持つ。幅で丸めてはいけない (幅 1 扱いで潰れる)
  const bitP = await build('ビット取り出し', {
    nodes: [[1, 'in', 0, 0, 0, 'a', null, 4], [2, 'bit', 200, 0, 2], [3, 'out', 400, 0, 0, 'y']],
    wires: [[1, 0, 2, 0], [2, 0, 3, 0]],
  }, [[{ a: 4 }, { y: 1 }], [{ a: 11 }, { y: 0 }], [{ a: 15 }, { y: 1 }]]);
  ok(bitP.source.includes('= a[2];'), 'ビット取り出し: 1 ビットなら a[2] になる', bitP.source);

  // 幅を付けると範囲になる (w = 取り出すビット数、value = いちばん下)
  const sliceP = await build('部分選択', {
    nodes: [[1, 'in', 0, 0, 0, 'a', null, 8], [2, 'bit', 200, 0, 2, null, null, 4],
      [3, 'out', 400, 0, 0, 'y']],
    wires: [[1, 0, 2, 0], [2, 0, 3, 0]],
  }, [[{ a: 0b10110100 }, { y: 0b1101 }], [{ a: 255 }, { y: 15 }], [{ a: 0 }, { y: 0 }]]);
  ok(sliceP.source.includes('= a[5:2];'), '部分選択: a[5:2] になる', sliceP.source);
  ok(sliceP.source.includes('output [3:0] y'), '部分選択: 出力は取り出したビット数', sliceP.source);

  // 全 256 通り
  const sliceSim = await WasmSimulator.create(compile(sliceP.source));
  let sliceBad = 0;
  for (let a = 0; a < 256; a++) {
    sliceSim.setInput('a', a).eval();
    if (Number(sliceSim.get('y')) !== ((a >> 2) & 15)) sliceBad++;
  }
  eqs(sliceBad, 0, '部分選択: 8 ビットからの a[5:2] が全 256 通り正しい');

  // はみ出す範囲は弾く
  for (const [label, lo, w, srcW] of [
    ['下端がはみ出す', 4, 1, 4], ['上端がはみ出す', 5, 4, 8], ['幅がはみ出す', 0, 8, 4],
  ]) {
    const p = toVerilog(expandCircuit({
      nodes: [[1, 'in', 0, 0, 0, 'a', null, srcW], [2, 'bit', 200, 0, lo, null, null, w],
        [3, 'out', 400, 0, 0, 'y']],
      wires: [[1, 0, 2, 0], [2, 0, 3, 0]],
    }));
    ok(p.widthErrors.length > 0, `部分選択: ${label}範囲を弾く`, p.widthErrors.join(','));
  }
  eq(expandCircuit(packCircuit(expandCircuit({
    nodes: [[1, 'bit', 0, 0, 3]], wires: [],
  }))).nodes[0].value, 3, 'ビット取り出し: 添字が往復して残る');

  const catP = await build('連接', {
    nodes: [[1, 'in', 0, 0, 1, 'hi'], [2, 'in', 0, 100, 0, 'lo', null, 4],
      [3, 'cat', 200, 50], [4, 'out', 400, 50, 0, 'y']],
    wires: [[1, 0, 3, 0], [2, 0, 3, 1], [3, 0, 4, 0]],
  }, [[{ hi: 1, lo: 5 }, { y: 21 }], [{ hi: 0, lo: 15 }, { y: 15 }]]);
  ok(catP.source.includes('output [4:0]'), '連接: 幅が足し算になる (1 + 4 = 5)', catP.source);

  const twoIn = (t) => ({
    nodes: [[1, 'in', 0, 0, 0, 'a', null, 4], [2, 'in', 0, 100, 0, 'b', null, 4],
      [3, t, 200, 50], [4, 'out', 400, 50, 0, 'y']],
    wires: [[1, 0, 3, 0], [2, 0, 3, 1], [3, 0, 4, 0]],
  });
  await build('加算', twoIn('add'), [[{ a: 5, b: 3 }, { y: 8 }], [{ a: 15, b: 1 }, { y: 0 }]]);
  await build('減算', twoIn('sub'), [[{ a: 5, b: 3 }, { y: 2 }], [{ a: 3, b: 5 }, { y: 14 }]]);
  const eqP = await build('一致', twoIn('eq'), [[{ a: 5, b: 5 }, { y: 1 }], [{ a: 5, b: 4 }, { y: 0 }]]);
  ok(!eqP.source.includes('output [3:0] y'), '一致: 出力は 1 ビット', eqP.source);
  await build('小なり', twoIn('lt'), [[{ a: 3, b: 5 }, { y: 1 }], [{ a: 5, b: 3 }, { y: 0 }]]);
  await build('選択', {
    nodes: [[1, 'in', 0, 0, 0, 's'], [2, 'in', 0, 80, 0, 'a', null, 4],
      [3, 'in', 0, 160, 0, 'b', null, 4], [4, 'mux', 250, 80], [5, 'out', 450, 80, 0, 'y']],
    wires: [[1, 0, 4, 0], [2, 0, 4, 1], [3, 0, 4, 2], [4, 0, 5, 0]],
  }, [[{ s: 1, a: 9, b: 6 }, { y: 9 }], [{ s: 0, a: 9, b: 6 }, { y: 6 }]]);

  // 幅の規則を外れたものは未配線と同じく除外される
  const wrong = [
    ['ビット取り出しの添字が幅の外',
      { nodes: [[1, 'in', 0, 0, 0, 'a', null, 4], [2, 'bit', 200, 0, 7], [3, 'out', 400, 0, 0, 'y']],
        wires: [[1, 0, 2, 0], [2, 0, 3, 0]] }],
    ['一致の両辺の幅が違う',
      { nodes: [[1, 'in', 0, 0, 0, 'a', null, 4], [2, 'in', 0, 100, 0, 'b'],
        [3, 'eq', 200, 50], [4, 'out', 400, 50, 0, 'y']],
      wires: [[1, 0, 3, 0], [2, 0, 3, 1], [3, 0, 4, 0]] }],
    ['選択の選択信号が 1 ビットでない',
      { nodes: [[1, 'in', 0, 0, 0, 's', null, 2], [2, 'in', 0, 80, 0, 'a'],
        [3, 'in', 0, 160, 0, 'b'], [4, 'mux', 250, 80], [5, 'out', 450, 80, 0, 'y']],
      wires: [[1, 0, 4, 0], [2, 0, 4, 1], [3, 0, 4, 2], [4, 0, 5, 0]] }],
    ['連接で幅が上限を超える',
      { nodes: [[1, 'in', 0, 0, 0, 'a', null, 32], [2, 'in', 0, 100, 0, 'b', null, 32],
        [3, 'cat', 200, 50], [4, 'out', 400, 50, 0, 'y']],
      wires: [[1, 0, 3, 0], [2, 0, 3, 1], [3, 0, 4, 0]] }],
  ];
  for (const [label, data] of wrong) {
    const p = toVerilog(expandCircuit(data));
    ok(p.widthErrors.length > 0, `幅の規則: ${label} を弾く`, p.widthErrors.join(','));
  }

  // 幅を超える値は丸める / 範囲外の幅は 1 に落ちる
  const clamped = expandCircuit({
    nodes: [[1, 'in', 0, 0, 999, 'a', null, 4], [2, 'in', 0, 100, 1, 'b', null, 999],
      [3, 'in', 0, 200, 1, 'c', null, 0]],
    wires: [],
  });
  eq(clamped.nodes[0].value, 999 % 16, '幅: 幅に収まらない値は丸める');
  eq(clamped.nodes[1].w, 1, '幅: 大きすぎる幅は 1 に落ちる');
  eq(clamped.nodes[2].w, 1, '幅: 0 以下の幅も 1 に落ちる');

  // ---- .json ファイル経由の往復 ----
  // エディタが書き出す形は packCircuit に name を足しただけ。expandCircuit は
  // name を見ないので、リンクと .json が相互に行き来できる。
  for (const [name, c] of Object.entries(SAMPLE_CIRCUITS)) {
    const g = expandCircuit(c);
    const text = JSON.stringify({ name, ...packCircuit(g) });
    eqs(JSON.stringify(expandCircuit(JSON.parse(text))), JSON.stringify(g),
      `.json: ${name} がファイル経由で往復して一致する`);
  }
  // 余分なフィールドがあっても無視される
  const extra = expandCircuit(JSON.parse(JSON.stringify({
    name: 'x', note: 'これは無視される', version: 99,
    ...packCircuit(expandCircuit(SAMPLE_CIRCUITS['AND ゲート'])),
  })));
  eq(extra.nodes.length, expandCircuit(SAMPLE_CIRCUITS['AND ゲート']).nodes.length,
    '.json: 知らないフィールドは無視される');
  // 回路部品を含む回路もファイル経由で往復する (中身が入れ子で入っている)
  const withBlock = {
    nodes: [
      [1, 'in', 0, 0, 0, 'a'],
      [2, 'block', 100, 0, 0, 'part', { ref: 'and2', def: packCircuit(expandCircuit(SAMPLE_CIRCUITS['AND ゲート'])) }],
    ],
    wires: [],
  };
  const blockRound = expandCircuit(JSON.parse(JSON.stringify({ name: 'b', ...withBlock })));
  eqs(blockRound.nodes[1].type, 'block', '.json: 回路部品も往復する');
  ok(blockRound.nodes[1]._ports !== undefined, '.json: 回路部品の端子が復元される');

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
}

async function testConstants() {
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
  ['加算・減算', testArith],
  ['文脈依存幅', testContextWidth],
  ['畳み込み / CSE', testFoldCse],
  ['刈り取り', testPrune],
  ['比較器', testCompare],
  ['ALU (case の書き方)', testAlu],
  ['非 ANSI と多入力ゲート', testOnehot],
  ['リダクション', testReduce],
  ['論理演算子', testLogical],
  ['範囲判定', testWindow],
  ['シフト', testShift],
  ['シフト回路', testShifter],
  ['if / case', testIfCase],
  ['FSM (列検出)', testSeqDet],
  ['モジュール階層', testHierarchy],
  ['parameter', testParams],
  ['非同期リセット', testAsyncReset],
  ['カウンタ', testCounter8],
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
  ['メモリと回路グラフ', testBlockMemory],
  ['バレルシフタ', testBarrel],
  ['端子の名前', testPortNames],
  ['回路部品', testBlocks],
  ['保存形式', testSaveFormat],
  ['定数', testConstants],
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
