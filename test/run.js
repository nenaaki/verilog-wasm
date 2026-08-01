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
  assign wide  = a - b;        // 左辺が広くても計算幅は max(右辺)+1 のまま
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
        wide: (a - b) & 31,     // 8 ビットに広げるのは計算の後。下の固定テスト参照
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

  // 幅の割り切りが見える所を固定しておく。
  // 計算幅は「代入先の幅」ではなく「右辺の max(幅)+1」で決まるので、左辺が
  // それより広いと本物の Verilog と結果が変わる (文脈依存幅は実装していない)。
  // 3 - 5 は 8 ビット文脈なら 251 になるが、ここでは 5 ビットで計算した 30 を
  // ゼロ拡張して 30 になる。意図した挙動なのでテストで固定する。
  for (const sim of [wasm, ref]) sim.setInput('a', 3).setInput('b', 5).eval();
  eq(wasm.get('wide'), 30, '減算: 左辺が広くても計算幅は max(右辺)+1');
  eq(ref.get('wide'), 30, '減算: 参照実装も同じ幅規則');

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
        prec3: ((a + 1) & 31) <= b ? 1 : 0,
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
  // --- 定数シフト。並べ替えだけなのでゲートは増えないはず ---
  const plain = compile('module m(input [7:0] a, output [7:0] y); assign y = a; endmodule');
  const shifted = compile('module m(input [7:0] a, output [7:0] y); assign y = a << 3; endmodule');
  eqs(shifted.stats.gates, plain.stats.gates,
    '定数シフト: ゲートが増えない (配線の付け替えだけ)',
    `素通し=${plain.stats.gates} シフト=${shifted.stats.gates}`);

  const src = `module sh(
  input [3:0] a,
  input [2:0] amt,
  input [3:0] wideAmt,
  output [3:0] l1, output [3:0] l2, output [3:0] r1, output [3:0] r2,
  output [7:0] noGrow, output [3:0] l9, output [3:0] r9,
  output [7:0] concatPack,
  output [3:0] vl, output [3:0] vr,
  output [3:0] vlWide, output [3:0] vrWide,
  output [7:0] prec1, output prec2, output [7:0] prec3
);
  assign l1 = a << 1;
  assign l2 = a << 2;
  assign r1 = a >> 1;
  assign r2 = a >> 2;
  assign noGrow = a << 3;              // 4 ビットのまま計算 → 押し出されたビットは戻らない
  assign l9 = a << 9;                  // 全部押し出される
  assign r9 = a >> 9;
  assign concatPack = {a, 4'h0} | a;   // ニブル詰めは連接で書く
  assign vl = a << amt;                // バレルシフタ
  assign vr = a >> amt;
  assign vlWide = a << wideAmt;        // シフト量が幅より大きくなり得る
  assign vrWide = a >> wideAmt;
  assign prec1 = a + 1 << 2;           // 算術が先 → (a+1) << 2
  assign prec2 = a << 1 < amt;         // シフトが先 → (a<<1) < amt
  assign prec3 = a << 1 + 1;           // 算術が先 → a << (1+1)
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
          noGrow: (a << 3) & 15,     // 4 ビットで計算されるので押し出されたぶんは消える
          l9: 0,
          r9: 0,
          concatPack: ((a << 4) | a) & 255,
          vl: (a << amt) & 15,
          vr: (a >> amt) & 15,
          vlWide: (a << wideAmt) & 15,
          vrWide: wideAmt >= 4 ? 0 : (a >> wideAmt) & 15,
          prec1: ((a + 1) << 2) & 31,   // a+1 が 5 ビットなので 5 ビットでシフトされる
          prec2: ((a << 1) & 15) < amt ? 1 : 0,
          prec3: (a << 2) & 15,
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

  // 幅は左オペランドのまま。リテラルでも定数式でも信号でも同じ規則になる
  for (const sim of [wasm, ref]) {
    sim.setInput('a', 5).setInput('amt', 2).setInput('wideAmt', 2).eval();
  }
  eq(wasm.get('l2'), 4, 'シフト: 5 << 2 は 4 ビットで 4 (リテラル量)');
  eq(wasm.get('prec3'), 4, 'シフト: 5 << (1+1) も同じ 4 (定数式の量)');
  eq(wasm.get('vlWide'), 4, 'シフト: 5 << amt も同じ 4 (信号の量)');
  eq(wasm.get('noGrow'), 8, 'シフト: 広い左辺でも押し出されたビットは戻らない (5<<3 が 4 ビットで 8)');
  eq(wasm.get('concatPack'), 0x55, 'シフト: ニブル詰めは連接 {a, 4\'h0} で書ける');

  // バレルシフタの段数。8 ビットを 3 ビット量でずらすと 8×3 = 24 個の mux
  const barrel = compile('module m(input [7:0] a, input [2:0] s, output [7:0] y); assign y = a << s; endmodule');
  eqs(barrel.stats.gates - plain.stats.gates, 24,
    'シフト: 8 ビット × 3 ビット量のバレルシフタは mux 24 個', `差分=${barrel.stats.gates - plain.stats.gates}`);

  // シフト量が幅を超え得るビットは、段を積まずに 1 段のマスクにまとめる
  const wide = compile('module m(input [7:0] a, input [7:0] s, output [7:0] y); assign y = a << s; endmodule');
  eqs(wide.stats.gates - plain.stats.gates, 36,
    'シフト: 8 ビット量でも 24 + (or 4 + mux 8) で済む', `差分=${wide.stats.gates - plain.stats.gates}`);

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
    ['negedge は未対応',
      `module m(input clk, a, output reg q); always @(negedge clk) q <= a; endmodule`,
      /negedge/],
    ['ブロッキング代入の誤用',
      `module m(input clk, a, output reg q); always @(posedge clk) q = a; endmodule`,
      /ノンブロッキング/],
    ['モジュール階層は未対応',
      `module m(input a, output y); sub u0(y, a); endmodule`,
      /未対応/],
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
    ['リダクション演算子は未対応',
      `module m(input [3:0] a, output y); assign y = &a; endmodule`,
      /式が必要/],
    ['リダクション ^ も未対応',
      `module m(input [3:0] a, output y); assign y = ^a; endmodule`,
      /式が必要/],
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
    if (r < 0.79) return `(${expr(depth - 1)} + ${expr(depth - 1)})`;
    if (r < 0.84) return `(${expr(depth - 1)} - ${expr(depth - 1)})`;
    if (r < 0.86) return `(-${expr(depth - 1)})`;
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

  lines.push(`  assign y = ${expr(3)};`);

  return `module rnd(
  input clk,
  input [7:0] a,
  input [7:0] b,
  input [7:0] c,
  output [7:0] y,
  output [7:0] rout,
  output [7:0] rout2
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
  const seen = { 'if': 0, 'case': 0, '+ / -': 0, '比較': 0, 'シフト': 0, '論理': 0 };

  for (let d = 0; d < 25 && !mismatch; d++) {
    const src = randomDesign(rng, 6);
    if (/\bif \(/.test(src)) seen['if']++;
    if (/\bcase \(/.test(src)) seen['case']++;
    if (/[-+] /.test(src)) seen['+ / -']++;
    if (/(==|!=|<=|>=|< |> )/.test(src)) seen['比較']++;
    if (/(<<|>>)/.test(src)) seen['シフト']++;
    if (/(&&|\|\||\(!)/.test(src)) seen['論理']++;
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
      for (const port of ['y', 'rout', 'rout2']) {
        if (wasm.get(port) !== ref.get(port)) {
          mismatch = `${port}: wasm=${wasm.get(port)} ref=${ref.get(port)} (a=${a} b=${b} c=${c} t=${t})\n${src}`;
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
  ['比較器', testCompare],
  ['論理演算子', testLogical],
  ['範囲判定', testWindow],
  ['シフト', testShift],
  ['シフト回路', testShifter],
  ['if / case', testIfCase],
  ['FSM (列検出)', testSeqDet],
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
