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
  blockPorts, checkName, decodeCircuit, decodeCircuitData, encodeCircuit, expandCircuit,
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

async function bothSims(src, top) {
  const compiled = compile(src, top ? { top } : undefined);
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

// ------------------------------------------------------------------ 乗除算
//
// 配列乗算器と復元法の割り算。加算器と同じく JS の算術と全数で突き合わせる。
async function testMulDiv() {
  const src = `module muldiv(
  input [3:0] a,
  input [3:0] b,
  output [7:0] mul,
  output [3:0] mulw,
  output [3:0] dv,
  output [3:0] md,
  output [7:0] sq,
  output [7:0] mix
);
  assign mul  = a * b;         // 8 ビット文脈なので桁あふれしない
  assign mulw = a * b;         // 4 ビットに切り詰められる
  assign dv   = a / b;
  assign md   = a % b;
  assign sq   = a * a;
  assign mix  = (a + b) * 2 - a / 2;
endmodule`;
  const { compiled, wasm, ref } = await bothSims(src);

  let bad = null;
  for (let a = 0; a < 16 && !bad; a++) {
    for (let b = 0; b < 16 && !bad; b++) {
      for (const sim of [wasm, ref]) sim.setInput('a', a).setInput('b', b).eval();
      // b が 0 のときは回路が出す値をそのまま仕様にしている
      // (Verilog は x だが、この処理系は x を値として持たない)
      const expect = {
        mul: (a * b) & 255,
        mulw: (a * b) & 15,
        dv: b === 0 ? 15 : Math.floor(a / b),
        md: b === 0 ? a : a % b,
        sq: (a * a) & 255,
        // 2 と 2 は非サイズリテラル = 32 ビットなので、式全体が 32 ビットで回る
        mix: ((a + b) * 2 - Math.floor(a / 2)) & 255,
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
  ok(!bad, '乗除算: 全 256 通りが JS の算術と一致', bad ?? '');

  for (const sim of [wasm, ref]) sim.setInput('a', 7).setInput('b', 5).eval();
  eq(wasm.get('mul'), 35, '乗算: 7 * 5 は 8 ビットで 35');
  eq(wasm.get('mulw'), 3, '乗算: 4 ビットに代入すると上位が落ちて 3');
  eq(wasm.get('dv'), 1, '除算: 7 / 5 は 1 (切り捨て)');
  eq(wasm.get('md'), 2, '剰余: 7 % 5 は 2');

  // 0 除算。x を持たないので、復元法の回路がそのまま出す値になる
  for (const sim of [wasm, ref]) sim.setInput('a', 9).setInput('b', 0).eval();
  eq(wasm.get('dv'), 15, '除算: 0 で割ると全ビット 1');
  eq(wasm.get('md'), 9, '剰余: 0 で割ると被除数がそのまま残る');
  eq(ref.get('dv'), 15, '除算: 参照実装も同じ');

  // 64 レーン同時。乗算器もビット単位なので、そのまま並列に効く
  wasm.reset();
  for (let lane = 0; lane < 64; lane++) {
    wasm.setInputLane('a', lane, lane & 15).setInputLane('b', lane, (lane >> 2) & 15);
  }
  wasm.eval();
  const lanes = wasm.getLanes('mul');
  let laneBad = 0;
  for (let lane = 0; lane < 64; lane++) {
    if (Number(lanes[lane]) !== ((lane & 15) * ((lane >> 2) & 15))) laneBad++;
  }
  ok(laneBad === 0, '乗除算: 64 レーンが独立に計算される', `${laneBad} レーン不一致`);

  eqs(compiled.stats.regs, 0, '乗除算: レジスタなし');

  // --- 定数側は畳まれる ---
  //
  // 非サイズリテラルは 32 ビットに広がるが、定数畳み込みが部分積と筆算の段を
  // 消すので、幅を書いた場合と同じ回路になる (README「サイズ無しリテラルの幅」)。
  const gates = (expr) => compile(
    `module g(input [7:0] a, input [7:0] b, output [7:0] p); assign p = ${expr}; endmodule`,
  ).stats.gates;

  eqs(gates("a * 4"), gates("a * 8'd4"), '乗算: 非サイズリテラルでも回路は増えない');
  eqs(gates("a / 3"), gates("a / 8'd3"), '除算: 非サイズリテラルでも回路は増えない');
  ok(gates('a * 4') < gates('a * 10'),
    '乗算: 2 の冪の定数倍はシフトになる', `${gates('a * 4')} vs ${gates('a * 10')}`);
  ok(gates('a * 4') < gates('a * b'),
    '乗算: 定数倍は信号どうしより小さい', `${gates('a * 4')} vs ${gates('a * b')}`);

  // --- examples/muldiv4.v ---
  const ex = await bothSims(example('muldiv4.v'));
  let exBad = null;
  for (let a = 0; a < 16 && !exBad; a++) {
    for (let b = 0; b < 16 && !exBad; b++) {
      for (const sim of [ex.wasm, ex.ref]) sim.setInput('a', a).setInput('b', b).eval();
      const expect = {
        prod: a * b,
        wrap: (a * b) & 15,
        quot: b === 0 ? 15 : Math.floor(a / b),
        rem: b === 0 ? a : a % b,
        half: a >> 1,
      };
      for (const [port, want] of Object.entries(expect)) {
        for (const sim of [ex.wasm, ex.ref]) {
          if (Number(sim.get(port)) !== want) {
            exBad = `${sim.constructor.name} ${port}: a=${a} b=${b} 期待 ${want} / 実際 ${sim.get(port)}`;
            break;
          }
        }
      }
    }
  }
  ok(!exBad, 'muldiv4.v: 全 256 通りが JS の算術と一致', exBad ?? '');

  // --- 回路エディタの乗算 / 除算 / 剰余の部品 ---
  //
  // 加減算と同じ 2 入力 1 出力の same 規則なので、生成される Verilog は 1 行。
  // 4 ビットのバスを 2 本入れて、全 256 通りを Verilog 側と突き合わせる。
  for (const [type, op] of [['mul', '*'], ['div', '/'], ['mod', '%']]) {
    const g = toVerilog({
      nodes: [
        { id: 1, type: 'in', name: 'x', w: 4 }, { id: 2, type: 'in', name: 'y', w: 4 },
        { id: 3, type }, { id: 4, type: 'out', name: 'z' },
      ],
      wires: [
        { from: { node: 1, port: 0 }, to: { node: 3, port: 0 } },
        { from: { node: 2, port: 0 }, to: { node: 3, port: 1 } },
        { from: { node: 3, port: 0 }, to: { node: 4, port: 0 } },
      ],
    });
    ok(g.source.includes(`x ${op} y`), `回路グラフ ${type}: assign に ${op} が出る`, g.source);
    const { wasm: gw, ref: gr } = await bothSims(g.source);
    let gBad = null;
    for (let x = 0; x < 16 && !gBad; x++) {
      for (let y = 0; y < 16 && !gBad; y++) {
        for (const sim of [gw, gr]) sim.setInput('x', x).setInput('y', y).eval();
        // 出力の幅は入力と同じ 4 ビット (あふれは捨てる)
        const want = { mul: (x * y) & 15, div: y === 0 ? 15 : Math.floor(x / y), mod: y === 0 ? x : x % y }[type];
        for (const sim of [gw, gr]) {
          if (Number(sim.get('z')) !== want) {
            gBad = `${sim.constructor.name} x=${x} y=${y} 期待 ${want} / 実際 ${sim.get('z')}`;
          }
        }
      }
    }
    ok(!gBad, `回路グラフ ${type}: 全 256 通りが一致`, gBad ?? '');
  }
}

// ------------------------------------------------------------- while / repeat
//
// どちらも elaborate 時に完全展開する。回路になった結果が
// 「同じことを for や並べ書きで書いたのと一致するか」で見る。
async function testLoops() {
  // ---- while: 添字を本体で進める ----
  const rev8 = (v) => { let r = 0; for (let i = 0; i < 8; i++) r |= ((v >> i) & 1) << (7 - i); return r; };
  const { wasm: ww, ref: wr, all: wAll } = await bothSims(`module w(input clk, input [7:0] d,
    output reg [7:0] q, output reg [7:0] acc);
    integer i;
    always @(posedge clk) begin
      i = 0;
      while (i < 8) begin
        q[i] <= d[7-i];          // ビット反転
        i = i + 1;
      end
      acc <= d;
      i = 0;
      while (i < 3) begin acc <= acc ^ 8'h0F; i = i + 1; end   // 後の代入が勝つ
    end
  endmodule`);
  let bad = null;
  for (let d = 0; d < 256 && !bad; d++) {
    for (const sim of wAll) {
      sim.setInput('d', d).step();
      if (Number(sim.get('q')) !== rev8(d)) {
        bad = `${sim.constructor.name} d=${d} q=${sim.get('q')} (期待 ${rev8(d)})`;
      }
    }
  }
  ok(!bad, 'while: ビット反転が全 256 通り正しい', bad ?? '');

  // for で書いたのとゲート数が一致する (展開の結果が同じ)
  const viaWhile = compile(`module m(input clk, input [7:0] d, output reg [7:0] q);
    integer i;
    always @(posedge clk) begin
      i = 0;
      while (i < 8) begin q[i] <= d[7-i]; i = i + 1; end
    end
  endmodule`);
  const viaFor = compile(`module m(input clk, input [7:0] d, output reg [7:0] q);
    integer i;
    always @(posedge clk) for (i = 0; i < 8; i = i + 1) q[i] <= d[7-i];
  endmodule`);
  eqs(viaWhile.stats.gates, viaFor.stats.gates, 'while: for で書いたのと同じゲート数');
  eqs(viaWhile.stats.nets, viaFor.stats.nets, 'while: ネット数も同じ');

  // 添字は 1 刻みでなくてもよい / 減らしてもよい
  const { wasm: sw } = await bothSims(`module s(input clk, input [7:0] d, output reg [7:0] q);
    integer i;
    always @(posedge clk) begin
      q <= 8'h00;
      i = 6;
      while (i >= 0) begin q[i] <= d[i]; i = i - 2; end    // 偶数ビットだけ通す
    end
  endmodule`);
  sw.setInput('d', 0xff).step();
  eq(sw.get('q'), 0x55, 'while: 添字を減らす向きにも回せる');

  // ---- repeat: 回数が定数 ----
  const { wasm: rw, ref: rr } = await bothSims(`module r(input clk, input [7:0] d,
    output reg [7:0] q, output reg [7:0] p);
    always @(posedge clk) begin
      q <= d;
      repeat (3) q <= q ^ 8'h0F;      // 同じビットに 3 回 → 最後が勝つ
      p <= 8'h01;
      repeat (0) p <= 8'hFF;          // 0 回なら何も起きない
    end
  endmodule`);
  for (const sim of [rw, rr]) {
    // ノンブロッキングなので、繰り返した 3 回の右辺はどれもエッジ前の q を読む。
    // 同じビットへの代入は後が勝つので、結果は「1 回だけ書いた」のと同じになる
    sim.setInput('d', 0xa5).step();          // q はエッジ前 0 → 0 ^ 0F
    eq(sim.get('q'), 0x0f, 'repeat: 右辺はエッジ前の q を読み、最後の代入が勝つ');
    sim.step();                              // q はエッジ前 0F → 0F ^ 0F
    eq(sim.get('q'), 0x00, 'repeat: 次のエッジでも同じ規則');
    eq(sim.get('p'), 1, 'repeat: 0 回は何も生まない');
  }
  const viaRepeat = compile(`module m(input clk, input [7:0] d, output reg [7:0] q);
    integer i;
    always @(posedge clk) begin q <= d; repeat (4) begin q <= q + 1; end end
  endmodule`);
  const viaFlat = compile(`module m(input clk, input [7:0] d, output reg [7:0] q);
    always @(posedge clk) begin q <= d; q <= q + 1; q <= q + 1; q <= q + 1; q <= q + 1; end
  endmodule`);
  eqs(viaRepeat.stats.gates, viaFlat.stats.gates, 'repeat: 並べ書きと同じゲート数');

  // ---- always @(*) と function の中でも動く ----
  const comb = await bothSims(`module c(input [7:0] d, output reg [3:0] ones, output reg [3:0] f4);
    integer k;
    function [3:0] count4(input [7:0] v);
      integer j;
      begin
        count4 = 4'h0;
        j = 0;
        repeat (4) begin count4 = count4 + v[j]; j = j + 1; end
      end
    endfunction
    always @(*) begin
      ones = 4'h0;
      k = 0;
      while (k < 8) begin ones = ones + d[k]; k = k + 1; end   // ブロッキングの積み上げ
      f4 = count4(d);
    end
  endmodule`);
  let cbad = null;
  for (let d = 0; d < 256 && !cbad; d++) {
    const ones = d.toString(2).split('').filter((x) => x === '1').length;
    const low4 = (d & 15).toString(2).split('').filter((x) => x === '1').length;
    for (const sim of comb.all) {
      sim.setInput('d', d).eval();
      if (Number(sim.get('ones')) !== ones || Number(sim.get('f4')) !== low4) {
        cbad = `${sim.constructor.name} d=${d} ones=${sim.get('ones')} f4=${sim.get('f4')}`;
      }
    }
  }
  ok(!cbad, 'while / repeat: always @(*) と function の中でも動く (全 256 通り)', cbad ?? '');

  // ---- examples/loops8.v ----
  const ex = await bothSims(example('loops8.v'));
  let ebad = null;
  for (let d = 0; d < 256 && !ebad; d++) {
    let even = 0;
    for (let i = 0; i <= 6; i += 2) even |= ((d >> i) & 1) << i;
    const ones = d.toString(2).split('').filter((x) => x === '1').length;
    for (const sim of ex.all) {
      sim.setInput('d', d).step();
      const want = { rev: rev8(d), even, ones };
      for (const [k, v] of Object.entries(want)) {
        if (Number(sim.get(k)) !== v && !ebad) {
          ebad = `${sim.constructor.name} d=${d} ${k}=${sim.get(k)} (期待 ${v})`;
        }
      }
    }
  }
  ok(!ebad, 'while / repeat: loops8.v の 3 出力が全 256 通り正しい', ebad ?? '');

  // ---- 入れ子の begin … end (ループの本体で書きがちな形) ----
  const { wasm: bw } = await bothSims(`module b(input clk, input [3:0] a, output reg [3:0] q);
    always @(posedge clk) begin begin q <= a; end end
  endmodule`);
  bw.setInput('a', 9).step();
  eq(bw.get('q'), 9, 'while / repeat: 入れ子の begin … end が通る');

  // ---- 入れ子 ----
  const nest = await bothSims(`module n(input clk, input [3:0] a, output reg [15:0] grid);
    integer i, j;
    always @(posedge clk) begin
      i = 0;
      while (i < 4) begin
        j = 0;
        repeat (4) begin
          grid[i*4+j] <= a[i] & a[j];
          j = j + 1;
        end
        i = i + 1;
      end
    end
  endmodule`);
  for (const sim of nest.all) {
    for (let a = 0; a < 16; a++) {
      sim.setInput('a', a).step();
      let want = 0;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) want |= (((a >> i) & (a >> j)) & 1) << (i * 4 + j);
      }
      eq(sim.get('grid'), want, `while / repeat: 入れ子が 2 次元に展開される (a=${a})`);
    }
  }
}

// ------------------------------------------------------------------ initial
//
// initial は「電源投入時のレジスタの値」として読む。値そのものより、
// **どこから始まっても同じ状態になる**ことが本題:
//   instantiate しただけ / reset() のあと / 生バイト列を他所で読んだとき
async function testInitial() {
  const src = `module seeded(input clk, output reg [7:0] q, output reg [3:0] r, output reg f);
    initial q = 8'hA5;
    initial r = 4'h3;
    initial f = 1'b1;
    always @(posedge clk) begin
      q <= q + 1;
      r <= r - 1;
      f <= ~f;
    end
  endmodule`;
  const { compiled, wasm, ref, all } = await bothSims(src);

  // 1. instantiate / new しただけで初期値から始まる (reset を呼ばずに)
  for (const sim of all) {
    eq(sim.get('q'), 0xa5, `initial: ${sim.constructor.name} は最初から初期値`);
    eq(sim.get('r'), 3, `initial: ${sim.constructor.name} の 2 本目`);
    eq(sim.get('f'), 1, `initial: ${sim.constructor.name} の 1 ビット`);
  }

  // 2. 回してから reset() で戻る
  for (const sim of all) {
    sim.run(5);
    eq(sim.get('q'), 0xaa, 'initial: 5 クロック回ると進む');
    sim.reset();
    eq(sim.get('q'), 0xa5, 'initial: reset() は 0 ではなく初期値に戻す');
    eq(sim.get('r'), 3, 'initial: reset() は全部戻す');
  }

  // 3. 生の .wasm を直に instantiate しても同じ ―― モジュールが初期状態を運ぶ。
  //    シミュレータのラッパを通さないので、他のホストから読んでも成り立つ性質
  const { instance } = await WebAssembly.instantiate(compiled.bytes, {});
  const mem = new BigInt64Array(instance.exports.memory.buffer);
  const qSig = compiled.layout.signalTable.find((s) => s.name === 'q');
  let raw = 0;
  qSig.offsets.forEach((off, b) => { if (mem[off >> 3] & 1n) raw |= 1 << b; });
  eqs(raw, 0xa5, 'initial: 生の .wasm を instantiate しただけで初期値が入っている');

  // 4. initial を書かなければバイト列は今までどおり (データセクションが付かない)
  const plain = compile(`module m(input clk, output reg [7:0] q);
    always @(posedge clk) q <= q + 1; endmodule`);
  const withInit = compile(`module m(input clk, output reg [7:0] q);
    initial q = 8'h00;
    always @(posedge clk) q <= q + 1; endmodule`);
  eqs(withInit.bytes.length, plain.bytes.length,
    'initial: 値が 0 ならデータセクションは付かない');
  eqs(withInit.layout.initWords.length, 0, 'initial: 0 のビットは初期状態に出さない');

  // 5. 階層と generate の中でも効く (完全修飾名でレジスタを引くため)
  const hier = await bothSims(`module cell #(parameter S = 1) (input clk, output reg [3:0] v);
    initial v = S;
    always @(posedge clk) v <= v + 1;
  endmodule
  module top(input clk, output [3:0] a, output [3:0] b, output [3:0] c);
    cell #(.S(4'h7)) u0 (.clk(clk), .v(a));
    genvar i;
    for (i = 0; i < 2; i = i + 1) begin : g
      if (i == 0) cell #(.S(i + 1)) u (.clk(clk), .v(b));
      else        cell #(.S(i + 1)) u (.clk(clk), .v(c));
    end
  endmodule`, 'top');
  for (const sim of hier.all) {
    // 子の Q は初期値を持っているが、top の出力ポートはその下流の組合せ配線なので
    // eval() を 1 回通すまで追いつかない (レジスタ下流の出力と同じ事情)
    sim.eval();
    eq(sim.get('a'), 7, 'initial: 子 module の中の initial が効く');
    eq(sim.get('b'), 1, 'initial: generate 0 段目の初期値');
    eq(sim.get('c'), 2, 'initial: generate 1 段目は別の値になる');
  }

  // 6. LFSR が種から周期 255 で回る (README の例が --set 無しで動くこと)
  const lfsr = await bothSims(example('lfsr8.v'));
  for (const sim of lfsr.all) {
    eq(sim.get('q'), 1, `initial: ${sim.constructor.name} の LFSR が種から始まる`);
    sim.run(255);
    eq(sim.get('q'), 1, `initial: ${sim.constructor.name} の LFSR は 255 で一周する`);
  }
  lfsr.wasm.reset();
  lfsr.wasm.run(254);
  ok(Number(lfsr.wasm.get('q')) !== 1, 'initial: 254 クロックでは戻らない',
    String(lfsr.wasm.get('q')));

  // 7. 部分代入でビットごとに置ける
  const part = await bothSims(`module p(input clk, output reg [7:0] q);
    initial q[3:0] = 4'hC;
    initial q[7:4] = 4'h3;
    always @(posedge clk) q <= q + 1;
  endmodule`);
  for (const sim of part.all) eq(sim.get('q'), 0x3c, 'initial: 部分代入でビットを分けて置ける');

  // 8. 非同期リセットの値とは別物 (initial は電源投入時、rst はいつでも)
  const rst = await bothSims(`module r(input clk, input rstn, output reg [3:0] q);
    initial q = 4'h9;
    always @(posedge clk or negedge rstn)
      if (!rstn) q <= 4'h0;
      else q <= q + 1;
  endmodule`);
  for (const sim of rst.all) {
    sim.setInput('rstn', 1);
    eq(sim.get('q'), 9, 'initial: リセットを当てるまでは initial の値');
    sim.setInput('rstn', 0).eval();
    eq(sim.get('q'), 0, 'initial: リセットを当てると rst の値になる');
    sim.reset();
    sim.setInput('rstn', 1);
    eq(sim.get('q'), 9, 'initial: reset() は initial の値に戻す');
  }
}

// ------------------------------------------------------------------ 階層参照
//
// 名前はもともと完全修飾名の平坦な Map で持っているので、解決側は既にできている。
// 見るところは「式のパーサが a[3] (ビット選択) と b[3].t (階層の添字) を
// 取り違えないか」と、添字が genvar でも正しく落ちるか。
async function testHierRef() {
  const chain = await bothSims(example('chain4.v'), 'chain4');
  let bad = null;
  for (let d = 0; d < 16 && !bad; d++) {
    // 段を素直にたどる: 0 段目は ^1、以降は ^2
    let v = d ^ 1;
    const stage = [v];
    for (let i = 1; i < 4; i++) { v ^= 2; stage.push(v); }
    for (const sim of chain.all) {
      sim.setInput('d', d).eval();
      const want = { chain: stage[3], probe: stage[1] };
      for (const [k, x] of Object.entries(want)) {
        if (Number(sim.get(k)) !== x && !bad) {
          bad = `${sim.constructor.name} d=${d} ${k}=${sim.get(k)} (期待 ${x})`;
        }
      }
    }
  }
  ok(!bad, '階層参照: chain4.v の 16 通りが一致 (genvar 添字と 2 段の階層)', bad ?? '');

  // ---- ビット選択と取り違えない ----
  const { wasm: mw } = await bothSims(`module s(output [3:0] q); assign q = 4'hA; endmodule
  module m(input [3:0] a, output y, output [1:0] z, output w);
    s u ();
    assign y = a[2];        // ビット選択
    assign z = a[2:1];      // 部分選択
    assign w = u.q[1];      // 階層参照 + ビット選択
  endmodule`, 'm');
  mw.setInput('a', 0b0110).eval();
  eq(mw.get('y'), 1, '階層参照: ふつうのビット選択は変わらない');
  eq(mw.get('z'), 3, '階層参照: 部分選択も変わらない');
  eq(mw.get('w'), 1, '階層参照: 階層参照のあとのビット選択も効く (A の 1 ビット目)');

  // ---- 階層参照で組んだのと、素直に書いたのが同じ回路になる ----
  const viaHier = compile(`module s(input d, output q); assign q = ~d; endmodule
  module m(input a, output y); s u (.d(a), .q()); assign y = u.q; endmodule`, 'm');
  const viaPort = compile(`module s(input d, output q); assign q = ~d; endmodule
  module m(input a, output y); s u (.d(a), .q(y)); endmodule`, 'm');
  eqs(viaHier.stats.gates, viaPort.stats.gates,
    '階層参照: ポートでつないだのと同じゲート数');

  // ---- 深さ 3 (module → module → 信号) ----
  const deep = await bothSims(`module inner(output [3:0] v); assign v = 4'h6; endmodule
  module mid(output [3:0] w); inner i0 (); assign w = i0.v; endmodule
  module m(output [3:0] y, output [3:0] z);
    mid m0 ();
    assign y = m0.w;
    assign z = m0.i0.v;      // 2 段またぐ
  endmodule`, 'm');
  for (const sim of deep.all) {
    sim.eval();
    eq(sim.get('y'), 6, '階層参照: 1 段');
    eq(sim.get('z'), 6, '階層参照: 2 段またいでも読める');
  }
}

// ------------------------------------------- 繰り返し連接 / 宣言と同時の代入
//
// どちらも「同じことを長く書いたのと一致するか」で見る。糖衣なので、
// 展開した先が手で書き並べたのと一字一句同じ回路になるはず。
async function testSugar() {
  // ---- 繰り返し連接 {n{x}} ----
  const { wasm: rw, ref: rr } = await bothSims(`module r #(parameter W = 8) (
    input a, input [3:0] d,
    output [7:0] rep, output [W-1:0] zext, output [7:0] sext,
    output [7:0] pair, output [7:0] nest, output [3:0] none
  );
    assign rep  = {8{a}};                  // 1 ビットを 8 本に広げる
    assign zext = {{(W-1){1'b0}}, a};      // ゼロ詰めの定番
    assign sext = {{4{d[3]}}, d};          // 符号拡張の定番
    assign pair = {2{d[1:0], 2'b10}};      // 中身が 2 個以上のとき
    assign nest = {2{{2{d[1:0]}}}};        // 入れ子
    assign none = {{0{a}}, d};             // 0 回。連接の中なら幅 0 が許される
  endmodule`);
  let bad = null;
  for (let d = 0; d < 16 && !bad; d++) {
    for (const a of [0, 1]) {
      const lo = d & 3;
      const want = {
        rep: a ? 255 : 0,
        zext: a,
        sext: ((d & 8 ? 0xf0 : 0) | d),
        pair: (lo << 6) | (2 << 4) | (lo << 2) | 2,
        nest: (lo << 6) | (lo << 4) | (lo << 2) | lo,
        none: d,
      };
      for (const sim of [rw, rr]) {
        sim.setInput('a', a).setInput('d', d).eval();
        for (const [k, v] of Object.entries(want)) {
          if (Number(sim.get(k)) !== v && !bad) {
            bad = `${sim.constructor.name} a=${a} d=${d} ${k}=${sim.get(k)} (期待 ${v})`;
          }
        }
      }
    }
  }
  ok(!bad, '繰り返し連接: 全 32 通りが手で並べたのと一致', bad ?? '');

  // 並べて書いたのとゲート数が一致する (展開が余計なものを作っていない)
  const rep = compile(`module g(input [3:0] d, output [15:0] y); assign y = {4{d}}; endmodule`);
  const flat = compile(`module g(input [3:0] d, output [15:0] y); assign y = {d, d, d, d}; endmodule`);
  eqs(rep.stats.gates, flat.stats.gates, '繰り返し連接: 並べて書いたのと同じゲート数');
  eqs(rep.stats.nets, flat.stats.nets, '繰り返し連接: ネット数も同じ');

  // 幅は「回数 × 中身の合計」で、連接と同じく自己決定 (文脈は中に入らない)
  const w = compile(`module g(input [3:0] d, output [31:0] y); assign y = {2{d}}; endmodule`);
  const sim = await WasmSimulator.create(w);
  sim.setInput('d', 15).eval();
  eq(sim.get('y'), 0xff, '繰り返し連接: 自己決定幅は 8 ビット (代入先に広げられない)');

  // ---- 宣言と同時の代入 ----
  const { wasm: dw, ref: dr } = await bothSims(`module d(input [3:0] a, input [3:0] b,
    output [3:0] y, output [4:0] s);
    wire [3:0] t = a & b, u = a | b;     // 1 行に 2 本
    wire [4:0] wide = a + b;             // 幅は左辺で決まる (文脈依存幅)
    assign y = t ^ u;
    assign s = wide;
  endmodule`);
  for (const sim of [dw, dr]) {
    sim.setInput('a', 9).setInput('b', 5).eval();
    eq(sim.get('y'), 12, '宣言の代入: 値が入る');
    eq(sim.get('s'), 14, '宣言の代入: 左辺の幅が右辺の文脈になる (桁上げが残る)');
  }
  const decl = compile(`module g(input [3:0] a, input [3:0] b, output [3:0] y);
    wire [3:0] t = a & b;
    assign y = t | b;
  endmodule`);
  const split = compile(`module g(input [3:0] a, input [3:0] b, output [3:0] y);
    wire [3:0] t;
    assign t = a & b;
    assign y = t | b;
  endmodule`);
  eqs(decl.stats.gates, split.stats.gates, '宣言の代入: assign に分けて書いたのと同じ回路');
}

// ------------------------------------------------------------- always @(*)
//
// 組合せ always。レジスタ用の always とは代入の意味 (ブロッキング) も、
// 未代入ビットの扱い (保持ではなくエラー) も違うので、両方を見る。
async function testCombAlways() {
  // ---- 値。alu_comb.v の全 8 演算 × 16 × 16 ----
  const alu = await bothSims(example('alu_comb.v'));
  let bad = null;
  for (let op = 0; op < 8 && !bad; op++) {
    for (let a = 0; a < 16 && !bad; a++) {
      for (let b = 0; b < 16 && !bad; b++) {
        const wide = [a + b, (a - b) & 31, a & b, a | b, a ^ b, (~a) & 15, a < b ? 1 : 0, 0][op];
        const want = { y: wide & 15, carry: (wide >> 4) & 1, zero: (wide & 15) === 0 ? 1 : 0 };
        for (const sim of alu.all) {
          sim.setInput('op', op).setInput('a', a).setInput('b', b).eval();
          for (const [k, v] of Object.entries(want)) {
            if (Number(sim.get(k)) !== v && !bad) {
              bad = `${sim.constructor.name} op=${op} a=${a} b=${b} ${k}=${sim.get(k)} (期待 ${v})`;
            }
          }
        }
      }
    }
  }
  ok(!bad, 'always @(*): alu_comb.v の全 8 演算 × 256 通りが一致', bad ?? '');
  eqs(compile(example('alu_comb.v')).stats.regs, 0,
    'always @(*): レジスタは 1 個も作られない');

  // ---- ブロッキング代入。後の文が前の結果を読む ----
  const { wasm: bw, ref: br } = await bothSims(`module b(input [3:0] a,
    output reg [3:0] y, output reg [3:0] z);
    always @(*) begin
      y = a + 1;
      z = y + 1;        // ← ここで読む y は 1 行上で決まった値
    end
  endmodule`);
  for (const sim of [bw, br]) {
    sim.setInput('a', 5).eval();
    eq(sim.get('y'), 6, 'always @(*): ブロッキングの 1 文目');
    eq(sim.get('z'), 7, 'always @(*): 2 文目は 1 文目の結果を読む');
  }

  // 同じ回路を assign で書くとゲート数が一致する (余計なものを作っていない)
  const viaAlways = compile(`module g(input [3:0] a, input [3:0] b, output reg [3:0] y);
    always @(*) y = (a & b) | (a ^ b); endmodule`);
  const viaAssign = compile(`module g(input [3:0] a, input [3:0] b, output [3:0] y);
    assign y = (a & b) | (a ^ b); endmodule`);
  eqs(viaAlways.stats.gates, viaAssign.stats.gates,
    'always @(*): assign で書いたのと同じゲート数');

  // ---- 分岐。既定値を先に置く定石が通る ----
  const { wasm: cw, ref: cr } = await bothSims(`module c(input [1:0] s, input [3:0] d,
    output reg [3:0] y, output reg hit);
    always @(*) begin
      y = 4'h0;                        // 既定値。これでラッチにならない
      hit = 1'b0;
      case (s)
        2'd1: begin y = d; hit = 1'b1; end
        2'd2: if (d[0]) begin y = ~d; hit = 1'b1; end
      endcase
    end
  endmodule`);
  for (const sim of [cw, cr]) {
    sim.setInput('s', 0).setInput('d', 9).eval();
    eq(sim.get('y'), 0, 'always @(*): 拾わない case は既定値');
    eq(sim.get('hit'), 0, 'always @(*): 既定値は分岐の外で決まる');
    sim.setInput('s', 1).eval();
    eq(sim.get('y'), 9, 'always @(*): case で上書きされる');
    eq(sim.get('hit'), 1, 'always @(*): 同じ枝の 2 個目の代入も効く');
    sim.setInput('s', 2).eval();
    eq(sim.get('y'), 6, 'always @(*): case の中の if も通る');
    sim.setInput('s', 2).setInput('d', 8).eval();
    eq(sim.get('y'), 0, 'always @(*): else の無い if は既定値のまま');
  }

  // ---- 感度リスト。全部並んでいれば @(*) と同じ回路になる ----
  const sens = compile(`module s(input a, input b, output reg y);
    always @(a or b) y = a & b; endmodule`);
  const star = compile(`module s(input a, input b, output reg y);
    always @(*) y = a & b; endmodule`);
  eqs(sens.stats.gates, star.stats.gates, 'always @(*): 感度リストを書いても同じ回路');
  const comma = compile(`module s(input a, input b, output reg y);
    always @(a, b) y = a & b; endmodule`);
  eqs(comma.stats.gates, star.stats.gates, 'always @(*): コンマ区切りでも同じ');
  const noParen = compile(`module s(input a, output reg y); always @* y = ~a; endmodule`);
  eqs(noParen.stats.regs, 0, 'always @(*): @* (括弧なし) も書ける');

  // ---- 階層と generate の中でも動く ----
  const hier = await bothSims(`module leaf(input [3:0] d, output reg [3:0] q);
    always @(*) q = d ^ 4'hF;
  endmodule
  module top(input [3:0] d, output [3:0] y, output reg [3:0] z);
    leaf u (.d(d), .q(y));
    genvar i;
    for (i = 0; i < 4; i = i + 1) begin : g
      always @(*) z[i] = d[3-i];
    end
  endmodule`);
  for (const sim of hier.all) {
    sim.setInput('d', 9).eval();
    eq(sim.get('y'), 6, 'always @(*): 子 module の中でも動く');
    eq(sim.get('z'), 9, 'always @(*): generate で展開しても動く (0b1001 は反転しても同じ)');
    sim.setInput('d', 12).eval();
    eq(sim.get('z'), 3, 'always @(*): generate 展開のビット並べ替え');
  }
}

// ------------------------------------------------------------------ generate
//
// generate は「どの項目を作るか」を elaborate 時に決める。展開の結果が正しいこと
// (値) と、展開の仕方が正しいこと (スコープ・ゲート数) の両方を見る。
async function testGenerate() {
  // ---- for-generate: 段ごとに wire を持つ桁上げ伝播加算器 ----
  const rip = await bothSims(example('ripple8.v'));
  let bad = null;
  for (let t = 0; t < 200 && !bad; t++) {
    const a = (t * 37) & 255;
    const b = (t * 91) & 255;
    const cin = t & 1;
    for (const sim of rip.all) {
      sim.setInput('a', a).setInput('b', b).setInput('cin', cin).eval();
      const total = a + b + cin;
      if (Number(sim.get('sum')) !== (total & 255) || Number(sim.get('cout')) !== (total >> 8)) {
        bad = `${sim.constructor.name} ${a}+${b}+${cin}: sum=${sim.get('sum')} cout=${sim.get('cout')}`;
      }
    }
  }
  ok(!bad, 'generate: ripple8.v が 8 ビット加算と桁上げで一致', bad ?? '');

  // 手で書き並べたのとゲート数が一致すること (展開が余分な回路を作っていない)
  const genAdd = compile(example('ripple8.v'));
  // 同じ構造 (段のあいだの c も含めて) を手で書き並べる
  const byHand = compile(`module h(input [1:0] a, input [1:0] b, input cin,
    output [1:0] sum, output cout);
    wire [2:0] c;
    wire p0, g0, p1, g1;
    assign c[0] = cin;
    assign cout = c[2];
    assign p0 = a[0] ^ b[0];
    assign g0 = a[0] & b[0];
    assign sum[0] = p0 ^ c[0];
    assign c[1] = g0 | (p0 & c[0]);
    assign p1 = a[1] ^ b[1];
    assign g1 = a[1] & b[1];
    assign sum[1] = p1 ^ c[1];
    assign c[2] = g1 | (p1 & c[1]);
  endmodule`);
  const gen2bit = compile(example('ripple8.v').replace('parameter W = 8', 'parameter W = 2'));
  eqs(gen2bit.stats.gates, byHand.stats.gates,
    'generate: 展開した回路が手で書き並べたのと同じゲート数');
  ok(genAdd.stats.gates > gen2bit.stats.gates,
    'generate: W を増やすと段が増える', `${gen2bit.stats.gates} → ${genAdd.stats.gates}`);

  // ---- if / case-generate と、generate キーワードを省いた形 ----
  const pick = (mode, n) => `module g #(parameter MODE = ${mode}, parameter N = ${n})
    (input [3:0] d, output [3:0] y0, output [3:0] y1);
    generate
      if (MODE == 0) begin : m
        assign y0 = d;
      end else begin : m
        assign y0 = ~d;
      end
    endgenerate
    case (N)                        // generate / endgenerate は省ける
      1, 2:    assign y1 = d + 1;
      3:       assign y1 = d + 3;
      default: assign y1 = 4'h0;
    endcase
  endmodule`;
  for (const [mode, n, wy0, wy1] of [[0, 1, 9, 10], [1, 2, 6, 10], [1, 3, 6, 12], [1, 9, 6, 0]]) {
    const { wasm: gw, ref: gr } = await bothSims(pick(mode, n));
    for (const sim of [gw, gr]) {
      sim.setInput('d', 9).eval();
      eq(sim.get('y0'), wy0, `generate: if で MODE=${mode} の枝が選ばれる`);
      eq(sim.get('y1'), wy1, `generate: case で N=${n} の枝が選ばれる`);
    }
  }

  // 選ばれなかった枝の回路は作られない。刈り取りで消えるのではなく、そもそも作らない
  // (刈り取りなら stats.pruned に出るので、そこも見る)
  const plain = compile(`module g(input [3:0] d, output [3:0] y); assign y = d; endmodule`);
  const off = compile(`module g(input [3:0] d, output [3:0] y);
    if (0) begin : on assign y = d * d; end else begin : on assign y = d; end
  endmodule`);
  eqs(off.stats.gates, plain.stats.gates, 'generate: 通らない枝の乗算器は作られない');
  eqs(off.stats.pruned, plain.stats.pruned, 'generate: 刈り取りで消したのではない');

  // ---- スコープ ----
  const scoped = await bothSims(`module s #(parameter W = 4) (
    input [W-1:0] a, output [W-1:0] shadow, output [W-1:0] outer, output [15:0] grid);
    wire [W-1:0] t;
    assign t = a;
    genvar i, j;
    for (i = 0; i < W; i = i + 1) begin : s1
      wire t;                              // 内側の t (1 ビット) が勝つ
      assign t = a[i];
      assign shadow[i] = t;
    end
    for (i = 0; i < W; i = i + 1) begin : s2
      assign outer[i] = t[W-1-i] ^ (W == 4);   // 外の t と parameter が見える
    end
    for (i = 0; i < 4; i = i + 1) begin : r   // 入れ子。添字は両方とも定数式
      for (j = 0; j < 4; j = j + 1) begin : c
        assign grid[i*4+j] = a[i] & a[j];
      end
    end
  endmodule`);
  for (const sim of scoped.all) {
    for (let a = 0; a < 16; a++) {
      sim.setInput('a', a).eval();
      let grid = 0;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) grid |= (((a >> i) & (a >> j)) & 1) << (i * 4 + j);
      }
      let outer = 0;
      for (let i = 0; i < 4; i++) outer |= (((a >> (3 - i)) & 1) ^ 1) << i;
      eq(sim.get('shadow'), a, `generate: 内側の宣言が勝つ (a=${a})`);
      eq(sim.get('outer'), outer, `generate: 外の信号と parameter が見える (a=${a})`);
      eq(sim.get('grid'), grid, `generate: 入れ子の for が 2 次元に展開される (a=${a})`);
    }
  }

  // 展開した名前は完全修飾名になる (ラベル[添字].名前)
  const named = compile(`module n(input a, output y);
    genvar i;
    for (i = 0; i < 2; i = i + 1) begin : blk
      wire w;
      assign w = a;
    end
    assign y = 1'b0;
  endmodule`);
  const netNames = named.netlist.nets.map((x) => x.name);
  ok(netNames.includes('blk[0].w') && netNames.includes('blk[1].w'),
    'generate: 段ごとの名前が blk[0].w / blk[1].w になる',
    netNames.filter((x) => x.includes('blk')).join(','));

  // ---- 階層の中の generate。同じ module を違うパラメータで 2 個 ----
  const hier = await bothSims(`module popcnt #(parameter W = 4) (input [W-1:0] d, output [W-1:0] acc);
    wire [W*W-1:0] s;
    genvar i;
    for (i = 0; i < W; i = i + 1) begin : p
      if (i == 0) assign s[W-1:0] = d[0];
      else        assign s[W*i+W-1 : W*i] = s[W*i-1 : W*i-W] + d[i];
    end
    assign acc = s[W*W-1 : W*W-W];
  endmodule
  module top(input [7:0] d, output [3:0] n4, output [7:0] n8);
    popcnt #(.W(4)) a (.d(d[3:0]), .acc(n4));
    popcnt #(.W(8)) b (.d(d),      .acc(n8));
  endmodule`);
  let hbad = null;
  for (let d = 0; d < 256 && !hbad; d++) {
    const ones = (v) => v.toString(2).split('').filter((x) => x === '1').length;
    for (const sim of hier.all) {
      sim.setInput('d', d).eval();
      if (Number(sim.get('n8')) !== ones(d) || Number(sim.get('n4')) !== ones(d & 15)) {
        hbad = `${sim.constructor.name} d=${d}: n4=${sim.get('n4')} n8=${sim.get('n8')}`;
      }
    }
  }
  ok(!hbad, 'generate: 子 module の中の generate がパラメータごとに展開される', hbad ?? '');

  // ---- 0 回の for は何も生まない ----
  const bare = compile(`module e(input a, output y); assign y = 1'b0; endmodule`);
  const empty = compile(`module e(input a, output y);
    genvar i;
    for (i = 0; i < 0; i = i + 1) begin : g assign y = a; end
    assign y = 1'b0;
  endmodule`);
  eqs(empty.stats.gates, bare.stats.gates, 'generate: 1 度も回らない for は項目を作らない');
  eqs(empty.netlist.signals.size, bare.netlist.signals.size,
    'generate: 1 度も回らない for は信号も作らない');
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

// ------------------------------------------------------------------ signed
//
// 符号は幅と同じ 2 段階 (下から決めて上から降ろす) で決まる。効くのは 4 箇所
// ―― 幅を広げるときの符号拡張、比較、除算・剰余、`>>>` ―― なので、その 4 つと
// 「片方でも符号なしなら式全体が符号なし」を全通りで確かめる。
async function testSigned() {
  const toS4 = (v) => (v >= 8 ? v - 16 : v);
  const neg4 = (v) => (-v) & 15;

  // --- 符号拡張と、符号が混ざったときの伝わり方 ---
  const ext = `module sx(input signed [3:0] a, input [3:0] u,
    output signed [7:0] sa, output [7:0] toU, output [7:0] mixed,
    output [7:0] viaSigned, output [7:0] viaUnsigned,
    output [7:0] partSel, output [7:0] cat, output [7:0] plusU);
    assign sa          = a;            // signed なので符号拡張
    assign toU         = a;            // 左辺が符号なしでも右辺の符号で決まる
    assign mixed       = a + 4'b0;     // 4'b0 が符号なし → 式全体が符号なし
    assign viaSigned   = $signed(u);   // 符号なしを signed として読み直す
    assign viaUnsigned = $unsigned(a); // signed を符号なしとして読み直す
    assign partSel     = a[3:0];       // 部分選択は常に符号なし
    assign cat         = {a};          // 連接も常に符号なし
    assign plusU       = a + u;        // 片方が符号なし → 両方ゼロ拡張して足す
  endmodule`;
  const { all: exts } = await bothSims(ext);
  let bad = null;
  for (let a = 0; a < 16 && !bad; a++) {
    for (let u = 0; u < 16 && !bad; u++) {
      const s = toS4(a);
      const want = {
        sa: s & 255,
        toU: s & 255,
        mixed: a,
        viaSigned: toS4(u) & 255,
        viaUnsigned: a,
        partSel: a,
        cat: a,
        plusU: (a + u) & 255,
      };
      for (const sim of exts) {
        sim.setInput('a', a).setInput('u', u).eval();
        for (const [port, w] of Object.entries(want)) {
          if (Number(sim.get(port)) !== w && !bad) {
            bad = `${sim.constructor.name} ${port}: a=${s} u=${u} 期待 ${w} / 実際 ${sim.get(port)}`;
          }
        }
      }
    }
  }
  ok(!bad, 'signed: 符号拡張と符号の伝わり方が全通りで一致', bad ?? '');

  // --- 比較・除算・シフト。符号を見る 4 箇所を全通りで ---
  const ops = `module so(input signed [3:0] a, input signed [3:0] b, input [3:0] u,
    output slt, output sle, output sgt, output sge, output ult,
    output signed [3:0] sdiv, output signed [3:0] smod, output [3:0] udiv,
    output signed [3:0] asr1, output signed [3:0] asrv,
    output [3:0] lsr1, output signed [3:0] asl, output signed [7:0] wide);
    assign slt  = a < b;
    assign sle  = a <= b;
    assign sgt  = a > b;
    assign sge  = a >= b;
    assign ult  = a < u;      // 片方が符号なし → 符号なしの比較
    assign sdiv = a / b;
    assign smod = a % b;      // 剰余の符号は被除数に従う
    assign udiv = a / u;      // 片方が符号なし → 符号なしの除算
    assign asr1 = a >>> 1;    // 算術右シフト (定数)
    assign asrv = a >>> u;    // 算術右シフト (バレルシフタ)
    assign lsr1 = u >>> 1;    // 符号なしの >>> は >> と同じ
    assign asl  = a <<< 1;    // <<< は << と同じ
    assign wide = a * b;      // 8 ビット文脈なので符号拡張してから掛ける
  endmodule`;
  const { all: opss } = await bothSims(ops);

  // 符号付きの割り算は「絶対値で割ってから符号を戻す」。0 で割ったときは
  // 符号なしの回路がそのまま出す値 (商は全ビット 1、剰余は被除数) を符号で戻す
  const sdivmod = (a4, b4) => {
    const sa = a4 >> 3;
    const sb = b4 >> 3;
    const na = sa ? neg4(a4) : a4;
    const nb = sb ? neg4(b4) : b4;
    const q = nb === 0 ? 15 : Math.floor(na / nb);
    const r = nb === 0 ? na : na % nb;
    return { q: (sa ^ sb) ? neg4(q) : q, r: sa ? neg4(r) : r };
  };

  bad = null;
  for (let a = 0; a < 16 && !bad; a++) {
    for (let b = 0; b < 16 && !bad; b++) {
      for (let u = 0; u < 16 && !bad; u++) {
        const sa = toS4(a);
        const sb = toS4(b);
        const { q, r } = sdivmod(a, b);
        const want = {
          slt: sa < sb ? 1 : 0,
          sle: sa <= sb ? 1 : 0,
          sgt: sa > sb ? 1 : 0,
          sge: sa >= sb ? 1 : 0,
          ult: a < u ? 1 : 0,
          sdiv: q,
          smod: r,
          udiv: u === 0 ? 15 : Math.floor(a / u),
          asr1: (sa >> 1) & 15,
          asrv: u >= 4 ? (sa < 0 ? 15 : 0) : (sa >> u) & 15,
          lsr1: u >> 1,
          asl: (a << 1) & 15,
          wide: (sa * sb) & 255,
        };
        for (const sim of opss) {
          sim.setInput('a', a).setInput('b', b).setInput('u', u).eval();
          for (const [port, w] of Object.entries(want)) {
            if (Number(sim.get(port)) !== w && !bad) {
              bad = `${sim.constructor.name} ${port}: a=${sa} b=${sb} u=${u}`
                + ` 期待 ${w} / 実際 ${sim.get(port)}`;
            }
          }
        }
      }
    }
  }
  ok(!bad, 'signed: 比較・除算・算術シフトが全通りで一致', bad ?? '');

  // --- リテラルと parameter の符号 ---
  // 比較は「外の文脈は受け取らないが、両辺だけで文脈を作る」ので、リテラルの
  // 符号がそのまま観測できる。文脈幅が配られる位置だと、どちらでも同じ幅まで
  // 広げてから計算するので差が出ない (`wire [39:0] y = -3;` は両方 2^40-3)。
  const lits = `module sl(output [7:0] p5, output [7:0] m1, output [7:0] neg3,
    output [7:0] unsignedLit, output decSigned, output basedUnsigned,
    output [39:0] wideParam);
    localparam NEG = -3;
    assign p5             = 4'sd5;    // 5
    assign m1             = 4'shF;    // -1 → 8 ビットで 255
    assign neg3           = -4'sd3;   // -3 → 253
    assign unsignedLit    = 4'hF;     // 符号なしなので 15 のまま
    assign decSigned      = -1 < 0;   // 10 進リテラルは signed → 真
    assign basedUnsigned  = -1 < 'd0; // 'd0 が符号なし → 符号なしの比較で偽
    assign wideParam      = NEG;      // parameter は 32 ビットの signed
  endmodule`;
  const { all: litss } = await bothSims(lits);
  for (const sim of litss) {
    const kind = sim.constructor.name;
    sim.eval();
    eq(sim.get('p5'), 5, `${kind} signed: 4'sd5 は 5`);
    eq(sim.get('m1'), 255, `${kind} signed: 4'shF は符号拡張されて 255`);
    eq(sim.get('neg3'), 253, `${kind} signed: -4'sd3 は 253`);
    eq(sim.get('unsignedLit'), 15, `${kind} signed: 4'hF は符号なしなので 15`);
    eq(sim.get('decSigned'), 1, `${kind} signed: 10 進リテラルは signed なので -1 < 0`);
    eq(sim.get('basedUnsigned'), 0, `${kind} signed: 基数付きリテラルは符号なし`);
    eq(sim.get('wideParam'), (1n << 40n) - 3n, `${kind} signed: parameter は 32 ビットの signed`);
  }

  // --- always / case / function ---
  const seq = `module sq(input clk, input signed [3:0] a,
    output reg signed [7:0] acc, output reg [7:0] pick);
    always @(posedge clk) acc <= acc + a;   // 4 ビットを符号拡張して足し込む
    always @(*) begin
      case (a)
        -4'sd1: pick = 8'hAA;
        4'sd2:  pick = 8'hBB;
        default: pick = 8'hCC;
      endcase
    end
  endmodule`;
  const { all: seqs } = await bothSims(seq);
  for (const sim of seqs) {
    const kind = sim.constructor.name;
    sim.reset().setInput('a', neg4(3)).step().step();
    eq(sim.get('acc'), 250, `${kind} signed: -3 を 2 回足すと -6`);
    sim.setInput('a', neg4(1)).eval();
    eq(sim.get('pick'), 0xAA, `${kind} signed: case のラベル -4'sd1 に当たる`);
    sim.setInput('a', 2).eval();
    eq(sim.get('pick'), 0xBB, `${kind} signed: case のラベル 4'sd2 に当たる`);
  }

  const fn = `module sf(input signed [3:0] a, output [7:0] y, output [7:0] z);
    function signed [3:0] dbl(input signed [3:0] x);
      dbl = x + x;
    endfunction
    function [3:0] udbl(input signed [3:0] x);
      udbl = x + x;
    endfunction
    assign y = dbl(a);    // 戻り値が signed → 符号拡張
    assign z = udbl(a);   // 戻り値が符号なし → ゼロ拡張
  endmodule`;
  const { all: fns } = await bothSims(fn);
  for (const sim of fns) {
    const kind = sim.constructor.name;
    sim.setInput('a', neg4(3)).eval();
    eq(sim.get('y'), 250, `${kind} signed: function の signed な戻り値は符号拡張される`);
    eq(sim.get('z'), 10, `${kind} signed: 符号なしの戻り値はゼロ拡張される`);
  }

  // --- 符号なしなら回路は 1 ゲートも変わらない ---
  const shrA = compile('module m(input [7:0] a, input [2:0] s, output [7:0] y); assign y = a >>> s; endmodule');
  const shrL = compile('module m(input [7:0] a, input [2:0] s, output [7:0] y); assign y = a >> s; endmodule');
  eqs(shrA.stats.gates, shrL.stats.gates,
    'signed: 符号なしの >>> は >> と同じ回路',
    `>>>=${shrA.stats.gates} >>=${shrL.stats.gates}`);
  const shlA = compile('module m(input signed [7:0] a, output signed [7:0] y); assign y = a <<< 3; endmodule');
  const shlL = compile('module m(input signed [7:0] a, output signed [7:0] y); assign y = a << 3; endmodule');
  eqs(shlA.stats.gates, shlL.stats.gates,
    'signed: signed でも <<< は << と同じ回路 (左シフトは常に 0 詰め)',
    `<<<=${shlA.stats.gates} <<=${shlL.stats.gates}`);
  const divU = compile('module m(input [7:0] a, input [7:0] b, output [7:0] y); wire [7:0] t = a; assign y = t / b; endmodule');
  const divUs = compile('module m(input [7:0] a, input [7:0] b, output [7:0] y); wire unsigned [7:0] t = a; assign y = t / b; endmodule');
  eqs(divU.stats.gates, divUs.stats.gates,
    'signed: unsigned と明示しても回路は同じ (既定が unsigned)',
    `既定=${divU.stats.gates} 明示=${divUs.stats.gates}`);
  const divS = compile('module m(input signed [7:0] a, input signed [7:0] b, output signed [7:0] y); assign y = a / b; endmodule');
  ok(divS.stats.gates > divU.stats.gates,
    'signed: 符号付きの除算は符号を戻すぶんだけ大きい',
    `符号付き=${divS.stats.gates} 符号なし=${divU.stats.gates}`);
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

// ------------------------------------------------------------------ casez
// casez はラベルに書いた z / ? の桁を比較から外す。式の側は 2 値しか無いので、
// 「ラベルの don't care」だけを見れば Verilog と同じ結果になる。
async function testCasez() {
  // 優先順位エンコーダ。casez の代表的な使いどころ
  const pri = await bothSims(`module pri(input clk, input [3:0] req, output reg [2:0] grant);
  always @(posedge clk)
    casez (req)
      4'b1???: grant <= 3'd3;
      4'b01??: grant <= 3'd2;
      4'b001?: grant <= 3'd1;
      4'b0001: grant <= 3'd0;
      default: grant <= 3'd7;
    endcase
endmodule`);
  const model = (req) => (req & 8 ? 3 : req & 4 ? 2 : req & 2 ? 1 : req & 1 ? 0 : 7);
  let bad = null;
  for (const sim of pri.all) {
    for (let req = 0; req < 16; req++) {
      sim.setInput('req', req).step();
      if (Number(sim.get('grant')) !== model(req) && !bad) {
        bad = `${sim.constructor.name} req=${req}: 期待 ${model(req)} / 実際 ${sim.get('grant')}`;
      }
    }
  }
  ok(!bad, 'casez: 優先順位エンコーダが全 16 通り正しい', bad ?? '');

  // 同じ表を case でラベルを並べて書いたものと突き合わせる。結果は同じで回路は小さい
  const labels = [];
  for (let r = 1; r < 16; r++) labels.push(`      4'd${r}: grant <= 3'd${model(r)};`);
  const plain = await bothSims(`module pri(input clk, input [3:0] req, output reg [2:0] grant);
  always @(posedge clk)
    case (req)
${labels.join('\n')}
      default: grant <= 3'd7;
    endcase
endmodule`);
  let mismatch = null;
  for (let req = 0; req < 16; req++) {
    plain.wasm.setInput('req', req).step();
    pri.wasm.setInput('req', req).step();
    if (String(plain.wasm.get('grant')) !== String(pri.wasm.get('grant')) && !mismatch) {
      mismatch = `req=${req}`;
    }
  }
  ok(!mismatch, 'casez: ラベルを 15 個並べた case と同じ結果', mismatch ?? '');
  ok(pri.compiled.stats.gates < plain.compiled.stats.gates,
    'casez: 比較する桁が減るので回路も小さい',
    `casez=${pri.compiled.stats.gates} case=${plain.compiled.stats.gates}`);

  // 16 進の z (1 桁 = 4 ビット)、全桁 z (常に一致)、部分 z の混在
  const mix = await bothSims(`module m(input clk, input [7:0] a, output reg [3:0] y);
  always @(posedge clk)
    casez (a)
      8'hz0:        y <= 4'd1;
      8'b1zzz_zzzz: y <= 4'd2;
      8'bzzzz_zzzz: y <= 4'd3;
    endcase
endmodule`);
  const want = (a) => ((a & 0x0f) === 0 ? 1 : (a & 0x80) ? 2 : 3);
  let mbad = null;
  for (const sim of mix.all) {
    for (const a of [0x00, 0x30, 0x81, 0x7f, 0xf0, 0xff, 0x01, 0x80]) {
      sim.setInput('a', a).step();
      if (Number(sim.get('y')) !== want(a) && !mbad) {
        mbad = `${sim.constructor.name} a=0x${a.toString(16)}: 期待 ${want(a)} / 実際 ${sim.get('y')}`;
      }
    }
  }
  ok(!mbad, 'casez: 16 進の z・全桁 z・混在が正しい', mbad ?? '');

  // 全桁 don't care のラベルは常に一致するので、その後ろの項目と default は死ぬ
  const allZ = compile(`module m(input clk, input [3:0] a, output reg [3:0] y);
  always @(posedge clk)
    casez (a)
      4'bzzzz: y <= 4'h5;
      4'b0000: y <= 4'h6;
      default: y <= 4'h7;
    endcase
endmodule`);
  const sim = await WasmSimulator.create(allZ);
  sim.setInput('a', 0).step();
  eq(sim.get('y'), 5, 'casez: 全桁 z は常に一致する (後ろの項目は届かない)');
  // 常に一致なら比較器も mux も残らない = 無条件代入と同じ回路になる
  const flat = compile(`module m(input clk, input [3:0] a, output reg [3:0] y);
  always @(posedge clk) y <= 4'h5;
endmodule`);
  eqs(allZ.stats.gates, flat.stats.gates,
    'casez: 常に一致なら無条件代入と同じゲート数');

  // don't care は幅を広げた側には広がらない (Verilog の規則)。上位は 0 として比較する
  const ext = await bothSims(`module m(input clk, input [7:0] a, output reg y);
  always @(posedge clk)
    casez (a)
      4'b1??? : y <= 1'b1;
      default : y <= 1'b0;
    endcase
endmodule`);
  let ebad = null;
  for (const sim2 of ext.all) {
    // 8 ビットに揃うと 4'b1??? は 8'b0000_1??? になる = 上位 4 ビットは 0 でなければ不一致
    for (const [a, w] of [[0x08, 1], [0x0f, 1], [0x18, 0], [0x80, 0], [0x07, 0]]) {
      sim2.setInput('a', a).step();
      if (Number(sim2.get('y')) !== w && !ebad) {
        ebad = `${sim2.constructor.name} a=0x${a.toString(16)}: 期待 ${w} / 実際 ${sim2.get('y')}`;
      }
    }
  }
  ok(!ebad, 'casez: don\'t care は幅を広げた上位には広がらない', ebad ?? '');

  // 複数ラベル・default 無しの保持も case と同じように通る
  const multi = await bothSims(`module m(input clk, input [3:0] a, output reg [3:0] y);
  always @(posedge clk)
    casez (a)
      4'b00?0, 4'b11?1: y <= 4'hA;
    endcase
endmodule`);
  let nbad = null;
  for (const sim3 of multi.all) {
    sim3.reset();
    const hit = (a) => (a & 0b1101) === 0b0000 || (a & 0b1101) === 0b1101;
    let last = 0;
    for (const a of [0, 1, 2, 5, 13, 15, 7]) {
      sim3.setInput('a', a).step();
      if (hit(a)) last = 0xa;
      if (Number(sim3.get('y')) !== last && !nbad) {
        nbad = `${sim3.constructor.name} a=${a}: 期待 ${last} / 実際 ${sim3.get('y')}`;
      }
    }
  }
  ok(!nbad, 'casez: 複数ラベルと default 無しの保持', nbad ?? '');

  // 8 入力の優先順位エンコーダを全 256 通り
  const p8 = await bothSims(example('priority8.v'));
  let pbad = null;
  for (const sim4 of p8.all) {
    for (let req = 0; req < 256; req++) {
      sim4.setInput('req', req).step();
      const wantSel = req === 0 ? 0 : 31 - Math.clz32(req);
      if ((Number(sim4.get('sel')) !== wantSel || Number(sim4.get('any')) !== (req ? 1 : 0)) && !pbad) {
        pbad = `${sim4.constructor.name} req=${req}: sel=${sim4.get('sel')} (期待 ${wantSel})`
          + ` any=${sim4.get('any')}`;
      }
    }
  }
  ok(!pbad, 'casez: priority8.v が全 256 通り正しい', pbad ?? '');
}

// --------------------------------------------------------------- function
// function は呼び出しごとにインライン展開する。中身は組合せ回路で、ローカル変数は
// レジスタではなく一時変数なので blocking 代入 (=) になる。
async function testFunction() {
  // 1 行の function / ローカル変数 / begin-end / if を並べて JS のモデルと比べる
  const basic = await bothSims(`module m(input [3:0] a, output y, output [7:0] z, output [3:0] w);
  function par(input [3:0] d);
    par = ^d;
  endfunction
  function [7:0] add1(input [7:0] v);
    reg [7:0] t;
    begin
      t = v + 1;
      add1 = t;
    end
  endfunction
  function [3:0] mx(input [3:0] p, input [3:0] q);
    if (p > q) mx = p;
    else       mx = q;
  endfunction
  assign y = par(a);
  assign z = add1({4'h0, a});
  assign w = mx(a, 4'd7);
endmodule`);
  let bad = null;
  for (const sim of basic.all) {
    for (let a = 0; a < 16; a++) {
      sim.setInput('a', a).eval();
      const par = [...a.toString(2)].reduce((s, b) => s ^ Number(b), 0);
      const want = { y: par, z: a + 1, w: Math.max(a, 7) };
      for (const [k, v] of Object.entries(want)) {
        if (Number(sim.get(k)) !== v && !bad) {
          bad = `${sim.constructor.name} a=${a} ${k}=${sim.get(k)} (期待 ${v})`;
        }
      }
    }
  }
  ok(!bad, 'function: 1 行 / ローカル変数 / if を全 16 通り', bad ?? '');

  // 入れ子の呼び出し・case・部分代入・always の中での呼び出し
  const nest = await bothSims(`module m(input clk, input [3:0] a, output reg [7:0] q, output [7:0] n);
  function [3:0] inc(input [3:0] v);
    inc = v + 1;
  endfunction
  function [7:0] dec4(input [1:0] s);
    begin
      dec4 = 8'h00;
      case (s)
        2'd0: dec4[3:0] = 4'h1;
        2'd1: dec4[3:0] = 4'h2;
        2'd2: dec4[7:4] = 4'h4;
        default: dec4 = 8'hFF;
      endcase
    end
  endfunction
  assign n = dec4(a[1:0]);
  always @(posedge clk) q <= {4'h0, inc(inc(a))};
endmodule`);
  let nbad = null;
  for (const sim of nest.all) {
    for (let a = 0; a < 16; a++) {
      sim.setInput('a', a).step();
      const s = a & 3;
      const wantN = s === 0 ? 0x01 : s === 1 ? 0x02 : s === 2 ? 0x40 : 0xFF;
      if ((Number(sim.get('q')) !== ((a + 2) & 15) || Number(sim.get('n')) !== wantN) && !nbad) {
        nbad = `${sim.constructor.name} a=${a} q=${sim.get('q')} n=${sim.get('n')}`;
      }
    }
  }
  ok(!nbad, 'function: 入れ子の呼び出し・case・部分代入・always の中', nbad ?? '');

  // インライン展開なので、式を直接書いた場合とゲート数が完全に一致する
  const pairs = [
    ['1 出力', `assign y = F(a);`, `assign y = a + 8'd3;`, 'output [7:0] y'],
    ['同じ引数で 2 回', `assign y = F(a); assign z = F(a);`,
      `assign y = a + 8'd3; assign z = a + 8'd3;`, 'output [7:0] y, output [7:0] z'],
    ['違う引数で 2 回', `assign y = F(a); assign z = F(b);`,
      `assign y = a + 8'd3; assign z = b + 8'd3;`, 'output [7:0] y, output [7:0] z'],
  ];
  for (const [label, withFn, direct, ports] of pairs) {
    const head = `module m(input [7:0] a, input [7:0] b, ${ports});`;
    const fn = compile(`${head}
  function [7:0] F(input [7:0] v); F = v + 8'd3; endfunction
  ${withFn}
endmodule`);
    const raw = compile(`${head}\n  ${direct}\nendmodule`);
    eqs(fn.stats.gates, raw.stats.gates,
      `function: ${label} — 式を直接書いたのと同じゲート数`);
  }

  // 引数と同じ名前の信号が外にあってもローカルが勝つ (Verilog のスコープ規則)
  const shadow = await bothSims(`module m(input [3:0] a, input [3:0] v, output [3:0] y);
  function [3:0] f(input [3:0] v);
    f = ~v;
  endfunction
  assign y = f(a);
endmodule`);
  for (const sim of shadow.all) {
    sim.setInput('a', 3).setInput('v', 12).eval();
    eq(sim.get('y'), 12, `${sim.constructor.name} function: 引数が外の同名信号より優先される`);
  }

  // グレイコード変換器。往復すると元に戻る / カウンタが 16 で巡回する
  const gray = await bothSims(example('gray4.v'));
  let gbad = null;
  for (const sim of gray.all) {
    for (let b = 0; b < 16; b++) {
      sim.setInput('bin', b).eval();
      const g = b ^ (b >> 1);
      const nx = ((b + 1) & 15) ^ (((b + 1) & 15) >> 1);
      const adj = [1, 2, 4, 8].includes(g ^ nx) ? 1 : 0;
      if ((Number(sim.get('gray')) !== g || Number(sim.get('back')) !== b
        || Number(sim.get('adjacent')) !== adj) && !gbad) {
        gbad = `${sim.constructor.name} bin=${b}: gray=${sim.get('gray')} back=${sim.get('back')}`;
      }
    }
  }
  ok(!gbad, 'function: gray4.v の変換が全 16 通り正しく、往復して元に戻る', gbad ?? '');

  const gsim = gray.wasm;
  gsim.reset();
  const seq = [];
  for (let i = 0; i < 17; i++) { gsim.step(); seq.push(Number(gsim.get('counted'))); }
  ok(seq.slice(1).every((v, i) => [1, 2, 4, 8].includes(v ^ seq[i])),
    'function: グレイカウンタは 1 クロックで 1 ビットしか変わらない', seq.join(','));
  eqs(seq[16], seq[0], 'function: グレイカウンタは 16 サイクルで巡回する');
}

// -------------------------------------------------------------------- for
// for は elaborate 時に完全展開する。ループ変数は integer で宣言し、値は parameter と
// 同じ表に入るので、本体の `q[i]` が定数式の添字としてそのまま解ける。
async function testForLoop() {
  const rev8 = (v) => { let r = 0; for (let i = 0; i < 8; i++) r |= ((v >> i) & 1) << (7 - i); return r; };

  // 反転・数え上げ・累積 OR・always の中の for を全 256 通り
  const ops = await bothSims(example('bitops8.v'));
  let bad = null;
  for (const sim of ops.all) {
    for (let d = 0; d < 256; d++) {
      sim.setInput('d', d).step();
      let ones = 0; let acc = 0; let pfx = 0;
      for (let k = 0; k < 8; k++) { ones += (d >> k) & 1; acc |= (d >> k) & 1; pfx |= acc << k; }
      const want = { rev: rev8(d), ones, pfx, latched: rev8(d) };
      for (const [k, v] of Object.entries(want)) {
        if (Number(sim.get(k)) !== v && !bad) {
          bad = `${sim.constructor.name} d=${d} ${k}=${sim.get(k)} (期待 ${v})`;
        }
      }
    }
  }
  ok(!bad, 'for: bitops8.v の 4 出力が全 256 通り正しい', bad ?? '');

  // 展開なので手で書き並べたのと同じ回路になる
  const loop = compile(`module m(input [7:0] d, output [7:0] y);
  function [7:0] f(input [7:0] v);
    integer k;
    begin f = 8'h00; for (k = 0; k < 8; k = k + 1) f[k] = v[7-k]; end
  endfunction
  assign y = f(d);
endmodule`);
  const hand = compile(`module m(input [7:0] d, output [7:0] y);
  assign y = {d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]};
endmodule`);
  eqs(loop.stats.gates, hand.stats.gates, 'for: 手で連接を書いたのと同じゲート数');

  // 入れ子・下降・刻み 2・parameter を境界に・添字の掛け算
  const mix = await bothSims(`module m #(parameter N = 6) (input [15:0] d,
                             output [15:0] t, output [3:0] ev, output [3:0] upto);
  integer i;
  function [15:0] transpose(input [15:0] v);
    integer a, b;
    begin
      transpose = 16'h0;
      for (a = 0; a < 4; a = a + 1)
        for (b = 0; b < 4; b = b + 1)
          transpose[a*4+b] = v[b*4+a];
    end
  endfunction
  function [3:0] evens(input [15:0] v);
    integer k;
    begin
      evens = 4'd0;
      for (k = 14; k >= 0; k = k - 2)
        evens = evens + {3'b000, v[k]};
    end
  endfunction
  function [3:0] first_n(input [15:0] v);
    integer k;
    begin
      first_n = 4'd0;
      for (k = 0; k < N; k = k + 1)
        first_n = first_n + {3'b000, v[k]};
    end
  endfunction
  assign t = transpose(d);
  assign ev = evens(d);
  assign upto = first_n(d);
endmodule`);
  let mbad = null;
  for (const sim of mix.all) {
    for (const d of [0x0000, 0xFFFF, 0x1234, 0xACE0, 0x8001, 0x5555, 0x000F]) {
      sim.setInput('d', d).eval();
      let tr = 0;
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) tr |= ((d >> (b * 4 + a)) & 1) << (a * 4 + b);
      }
      let ev = 0;
      for (let k = 14; k >= 0; k -= 2) ev += (d >> k) & 1;
      let up = 0;
      for (let k = 0; k < 6; k++) up += (d >> k) & 1;
      if ((Number(sim.get('t')) !== tr || Number(sim.get('ev')) !== ev
        || Number(sim.get('upto')) !== up) && !mbad) {
        mbad = `${sim.constructor.name} d=0x${d.toString(16)}: t=${sim.get('t')}/${tr}`
          + ` ev=${sim.get('ev')}/${ev} upto=${sim.get('upto')}/${up}`;
      }
    }
  }
  ok(!mbad, 'for: 入れ子・下降・刻み 2・parameter 境界・i*4+b の添字', mbad ?? '');

  // 1 度も回らない for は何も起きない (保持になる)
  const never = await bothSims(`module m(input clk, input [7:0] d, output reg [7:0] q);
  integer i;
  always @(posedge clk) begin
    q <= 8'hAA;
    for (i = 0; i < 0; i = i + 1) q[i] <= d[i];
  end
endmodule`);
  for (const sim of never.all) {
    sim.reset().setInput('d', 0xff).step();
    eq(sim.get('q'), 0xaa, `${sim.constructor.name} for: 0 回のループは何も生まない`);
  }

  // ループ変数は外側の同名を壊さない (ループの前後で退避・復帰する)
  const shadow = compile(`module m(input [7:0] d, output [7:0] y, output [7:0] z);
  function [7:0] f(input [7:0] v);
    integer i;
    begin f = 8'h00; for (i = 0; i < 8; i = i + 1) f[i] = v[7-i]; end
  endfunction
  function [7:0] g(input [7:0] v);
    integer i;
    begin g = 8'h00; for (i = 0; i < 4; i = i + 1) g[i] = v[i]; end
  endfunction
  assign y = f(d);
  assign z = g(f(d));
endmodule`);
  const ss = await WasmSimulator.create(shadow);
  ss.setInput('d', 0b1000_0001).eval();
  eq(ss.get('y'), 0b1000_0001, 'for: 入れ子の呼び出しでループ変数が混ざらない (y)');
  eq(ss.get('z'), 0b0000_0001, 'for: 入れ子の呼び出しでループ変数が混ざらない (z)');

  // 定数式の * / % は計算できる。優先順位も Verilog どおり
  const konst = compile(`module m(output [7:0] a, output [7:0] b, output [7:0] c);
  localparam K1 = 2 + 3 * 4;
  localparam K2 = 17 / 5;
  localparam K3 = 17 % 5;
  assign a = K1;
  assign b = K2;
  assign c = K3;
endmodule`);
  const ks = await WasmSimulator.create(konst);
  ks.eval();
  eq(ks.get('a'), 14, 'for: 定数式の * は + より強く結合する (2 + 3 * 4 = 14)');
  eq(ks.get('b'), 3, 'for: 定数式の / は切り捨て (17 / 5 = 3)');
  eq(ks.get('c'), 2, 'for: 定数式の % (17 % 5 = 2)');
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
      /'=' は integer にだけ書ける \('q' はレジスタなので <= を使う\)/],
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
    ['定数式の 0 除算',
      `module m(output [7:0] y); localparam K = 3 / 0; assign y = K; endmodule`,
      /定数式で 0 除算/],
    ['=== は未対応',
      `module m(input [3:0] a, output y); assign y = a === 4'h3; endmodule`,
      /=== は未対応/],
    // signed は通るようになったが、parameter は 32 ビットの signed 固定なので
    // 幅も符号も書かせない
    ['parameter の signed 指定は未対応',
      `module m(output y); parameter signed P = 1; assign y = 1'b0; endmodule`,
      /parameter の signed 指定は未対応/],
    ['parameter の unsigned 指定も未対応',
      `module m(output y); localparam unsigned P = 1; assign y = 1'b0; endmodule`,
      /parameter の unsigned 指定は未対応/],
    ['システム関数は名前を出して断る',
      `module m(output [7:0] y); assign y = $clog2(8); endmodule`,
      /\$clog2 は未対応 \(システム関数/],
    // initial — レジスタの電源投入時の値としてだけ受ける
    ['initial の対象がレジスタでない',
      `module m(output reg y); initial y = 1'b0; endmodule`,
      /'y' に初期値を書いたが、レジスタではない/],
    ['initial の対象が組合せの reg',
      `module m(input a, output reg y); initial y = 1'b0; always @(*) y = ~a; endmodule`,
      /'y' に初期値を書いたが、レジスタではない/],
    ['initial の右辺が信号',
      `module m(input clk, input d, output reg q);
       initial q = d; always @(posedge clk) q <= d; endmodule`,
      /initial の右辺は定数でなければならない/],
    ['initial の中の if',
      `module m(input clk, output reg q);
       initial if (1) q = 1'b1; always @(posedge clk) q <= ~q; endmodule`,
      /initial の中に書けるのは定数の代入だけ/],
    ['initial でノンブロッキング代入',
      `module m(input clk, output reg q);
       initial q <= 1'b1; always @(posedge clk) q <= ~q; endmodule`,
      /initial の中はブロッキング代入 = を使う/],
    ['initial が同じビットに違う値',
      `module m(input clk, output reg [3:0] q);
       initial q = 4'h1;
       initial q = 4'h2;
       always @(posedge clk) q <= q + 1;
      endmodule`,
      /違う初期値を 2 回置いている/],
    // generate まわり。展開できないもの・書き忘れを名指しで断る
    ['generate の for に genvar が要る',
      `module m(output y); for (i=0;i<2;i=i+1) begin: g assign y = 1'b0; end endmodule`,
      /'i' は genvar で宣言されていない/],
    ['generate の for にラベルが要る',
      `module m(output y); genvar i; for (i=0;i<2;i=i+1) assign y = 1'b0; endmodule`,
      /generate の for にはラベルが要る/],
    ['generate の条件は定数式',
      `module m(input a, output y); genvar i; for (i=0;i<a;i=i+1) begin: g assign y=1'b0; end endmodule`,
      /'a' は定数式に使えない/],
    ['generate は入れ子にできない',
      `module m(output y); generate generate assign y=1'b0; endgenerate endgenerate endmodule`,
      /generate は入れ子にできない/],
    ['generate の中の localparam',
      `module m(output y); generate localparam K=1; assign y=1'b0; endgenerate endmodule`,
      /generate の中の localparam は未対応/],
    ['generate の中の function',
      `module m(output y); generate function f(input a); f=a; endfunction assign y=1'b0; endgenerate endmodule`,
      /generate の中の function は未対応/],
    ['generate の中の casez',
      `module m(output y); generate casez (1'b1) 1'b1: assign y=1'b0; endcase endgenerate endmodule`,
      /generate の中では case だけ使える/],
    ['endgenerate の書き忘れ',
      `module m(output y); generate assign y = 1'b0; endmodule`,
      /'endgenerate' が見つからない/],
    ['generate ブロックの end の書き忘れ',
      `module m(output y); genvar i; generate for(i=0;i<1;i=i+1) begin: g assign y=1'b0; endgenerate endmodule`,
      /generate ブロックの 'end' が見つからない/],
    ['generate の for が終わらない',
      `module m(output y); genvar i; for (i=0;i>=0;i=i+1) begin: g wire t; assign t=1'b0; end assign y=1'b0; endmodule`,
      /generate の for が 4096 回を超えた/],
    ['genvar に幅は書けない',
      `module m(output y); genvar [3:0] i; assign y=1'b0; endmodule`,
      /genvar に幅は書けない/],
    // 階層参照
    ['階層参照が展開より前',
      `module s(output q); assign q=1'b0; endmodule
       module m(output y); assign y = u.q; s u(); endmodule`,
      /インスタンスや generate ブロックより後ろに書く必要がある/],
    ['階層参照の名前が無い',
      `module s(output q); assign q=1'b0; endmodule
       module m(output y); s u(); assign y = u.nope; endmodule`,
      /'u' の中にその名前は無い/],
    ['階層参照を定数式に使う',
      `module s(output q); assign q=1'b0; endmodule
       module m(output [7:0] y); s u(); localparam K = u.q; assign y = K; endmodule`,
      /階層参照は定数式に使えない/],
    // 繰り返し連接 / 宣言と同時の代入
    ['連接にサイズ無しリテラル',
      `module m(input [3:0] a, output [7:0] y); assign y = {a, 1}; endmodule`,
      /連接の中のリテラル '1' には幅が要る/],
    ['繰り返し連接にサイズ無しリテラル',
      `module m(output [7:0] y); assign y = {4{3}}; endmodule`,
      /繰り返し連接の中のリテラル '3' には幅が要る/],
    ['繰り返し連接の回数が負',
      `module m(input a, output [7:0] y); assign y = {-1{a}}; endmodule`,
      /繰り返し連接の回数が負/],
    ['繰り返し連接の回数が多すぎる',
      `module m(input a, output [7:0] y); assign y = {99999{a}}; endmodule`,
      /繰り返し連接の回数が多すぎる/],
    ['繰り返し連接の回数が定数でない',
      `module m(input [2:0] n, input a, output [7:0] y); assign y = {n{a}}; endmodule`,
      /'n' は定数式に使えない/],
    ['reg の宣言に初期値',
      `module m(output reg y); reg [3:0] t = 4'h0; always @(*) y = t[0]; endmodule`,
      /reg 't' の宣言に初期値は書けない \(initial は未対応\)/],
    ['宣言の代入と assign の多重ドライブ',
      `module m(input a, output y); wire t = a; assign t = ~a; assign y = t; endmodule`,
      /t が多重にドライブされている \(宣言の代入 と assign 文\)/],
    // always @(*) — ラッチになる書き方と、代入の取り違え
    ['always @(*) で else が無い',
      `module m(input c, input d, output reg y); always @(*) if (c) y = d; endmodule`,
      /'y' に、代入されない経路がある \(ラッチになる\)/],
    ['always @(*) で default が無い',
      `module m(input [1:0] s, output reg y);
       always @(*) case (s) 2'd0: y=1'b1; 2'd1: y=1'b0; endcase endmodule`,
      /代入されない経路がある/],
    ['always @(*) で代入前に読む',
      `module m(input a, output reg y, output reg z); always @(*) begin z = y; y = a; end endmodule`,
      /'z' が 'y' を代入より前に読んでいる/],
    ['always @(*) の感度リストが足りない',
      `module m(input a, input b, output reg y); always @(a) y = a & b; endmodule`,
      /感度リストに b が足りない/],
    ['always @(*) の代入先が wire',
      `module m(input a, output y); always @(*) y = ~a; endmodule`,
      /代入先 'y' は reg で宣言する/],
    ['always @(*) でノンブロッキング代入',
      `module m(input a, output reg y); always @(*) y <= ~a; endmodule`,
      /always @\(\*\) の中はブロッキング代入 = を使う/],
    ['always @(posedge) でブロッキング代入',
      `module m(input clk, input a, output reg y); always @(posedge clk) y = a; endmodule`,
      /always @\(posedge …\) の中の '=' は integer にだけ書ける/],
    ['always @(*) の中に代入が無い',
      `module m(input a, output reg y); always @(*) begin end assign y = a; endmodule`,
      /always @\(\*\) の中に代入が無い/],
    ['always_comb は未対応',
      `module m(input a, output reg y); always_comb y = ~a; endmodule`,
      /'always_comb' は未対応/],
    // function — 書き間違えやすい所を名指しで断る
    ['無い function を呼んだら断る',
      `module m(input a, output y); assign y = f(a); endmodule`,
      /'f' という function は無い/],
    ['引数の数が合わない',
      `module m(input a, output y);
       function g(input p, input q); g = p & q; endfunction
       assign y = g(a); endmodule`,
      /g の引数は 2 個/],
    ['戻り値を代入していない',
      `module m(input a, output y);
       function g(input p); reg t; t = p; endfunction
       assign y = g(a); endmodule`,
      /戻り値 \(g への代入\) がどこにも無い/],
    ['function の中の <= は断る',
      `module m(input a, output y);
       function g(input p); g <= p; endfunction
       assign y = g(a); endmodule`,
      /function の中はブロッキング代入 = を使う/],
    ['function の引数は input だけ',
      `module m(input a, output y);
       function g(output p); g = 1'b0; endfunction
       assign y = g(a); endmodule`,
      /function の引数は input だけ/],
    ['引数が無い function は断る',
      `module m(input a, output y);
       function g(); g = 1'b0; endfunction
       assign y = g(a); endmodule`,
      /function には引数が 1 つ以上必要/],
    ['旧形式の引数宣言は断る',
      `module m(input a, output y);
       function g; input p; g = p; endfunction
       assign y = g(a); endmodule`,
      /引数を括弧の中に input で書く/],
    ['再帰は深さで止める',
      `module m(input [3:0] a, output y);
       function g(input [3:0] p); g = g(p); endfunction
       assign y = g(a); endmodule`,
      /呼び出しが深すぎる \(再帰は未対応\)/],
    ['function の中の未宣言の名前',
      `module m(input a, output y);
       function g(input p); begin t = p; g = t; end endfunction
       assign y = g(a); endmodule`,
      /'t' は function の中で宣言されていない/],
    ['定数式では function を呼べない',
      `module m(output [3:0] y);
       function [3:0] g(input [3:0] p); g = p; endfunction
       localparam W = g(4'd2);
       assign y = W; endmodule`,
      /定数式では function \(g\) を呼べない/],
    ['信号と function の名前がぶつかる',
      `module m(input a, output y);
       wire g;
       function g(input p); g = p; endfunction
       assign y = a; endmodule`,
      /信号と function で名前がぶつかっている/],
    ['function の二重定義',
      `module m(input a, output y);
       function g(input p); g = p; endfunction
       function g(input p); g = ~p; endfunction
       assign y = g(a); endmodule`,
      /二重に定義されている/],
    ['endfunction 忘れ',
      `module m(input a, output y);
       function g(input p); g = p;
       assign y = g(a); endmodule`,
      /'endfunction' が見つからない/],
    // for — 定数で終わることを保証できないものは断る
    ['integer で宣言していないループ変数',
      `module m(input clk, input [7:0] d, output reg [7:0] q);
       always @(posedge clk) for (i = 0; i < 8; i = i + 1) q[i] <= d[i]; endmodule`,
      /'i' は integer で宣言されていない/],
    ['for の更新式が別の変数',
      `module m(input clk, input [7:0] d, output reg [7:0] q);
       integer i, j;
       always @(posedge clk) for (i = 0; i < 8; j = j + 1) q[i] <= d[i]; endmodule`,
      /初期化と同じ変数でなければならない/],
    ['終わらない for は打ち切る',
      `module m(input clk, input [7:0] d, output reg [7:0] q);
       integer i;
       always @(posedge clk) for (i = 0; i < 8; i = i + 0) q[0] <= d[0]; endmodule`,
      /for の繰り返しが 4096 回を超えた/],
    ['for の条件に信号は書けない',
      `module m(input clk, input [7:0] d, output reg [7:0] q);
       integer i;
       always @(posedge clk) for (i = 0; i < d; i = i + 1) q[i] <= d[i]; endmodule`,
      /'d' は定数式に使えない/],
    // while / repeat — 展開できない形を断る
    ['while の条件が定数でない',
      `module m(input clk, input a, output reg y);
       always @(posedge clk) while (a) y <= 1'b0; endmodule`,
      /'a' は定数式に使えない/],
    ['while が終わらない',
      `module m(input clk, output reg y);
       integer i;
       always @(posedge clk) begin i = 0; while (i < 8) y <= 1'b0; end endmodule`,
      /while の繰り返しが 4096 回を超えた/],
    ['repeat の回数が定数でない',
      `module m(input clk, input [2:0] n, output reg y);
       always @(posedge clk) repeat (n) y <= 1'b0; endmodule`,
      /'n' は定数式に使えない/],
    ['repeat の回数が負',
      `module m(input clk, output reg y); always @(posedge clk) repeat (-1) y <= 1'b0; endmodule`,
      /repeat の回数が負/],
    ['repeat の回数が多すぎる',
      `module m(input clk, output reg y); always @(posedge clk) repeat (99999) y <= 1'b0; endmodule`,
      /repeat の回数が多すぎる/],
    ['文の begin にラベル',
      `module m(input clk, output reg q); always @(posedge clk) begin : b q <= 1'b0; end endmodule`,
      /文の begin にラベルは書けない/],
    ['forever は未対応',
      `module m(input clk, output reg y); always @(posedge clk) forever y <= 1'b0; endmodule`,
      /forever は未対応 \(繰り返しは回数が定数に決まるものだけ\)/],
    ['integer にビット選択',
      `module m(input clk, output reg y);
       integer i;
       always @(posedge clk) begin i[0] = 1; y <= 1'b0; end endmodule`,
      /integer 'i' にビット選択は書けない/],
    ['integer に幅は書けない',
      `module m(output y); integer [3:0] i; assign y = 1'b0; endmodule`,
      /integer に幅は書けない/],
    ['integer は信号として使えない',
      `module m(output y); integer i; assign y = i; endmodule`,
      /'i' は integer なので信号として使えない/],
    ['ループの添字が宣言範囲の外',
      `module m(input clk, input [7:0] d, output reg [7:0] q);
       integer i;
       always @(posedge clk) for (i = 0; i < 9; i = i + 1) q[i] <= d[i]; endmodule`,
      /q\[8\] は宣言範囲 \[7:0\] の外/],
    ['信号と integer の二重宣言',
      `module m(output y); wire i; integer i; assign y = 1'b0; endmodule`,
      /信号と integer で二重に宣言されている/],
    ['task はまだ未対応',
      `module m(input clk, input a, output reg y);
       task t(input p, output q); q = ~p; endtask
       always @(posedge clk) t(a, y); endmodule`,
      /'task' は未対応/],
    ['casex は未対応',
      `module m(input clk, input [1:0] s, output reg q);
       always @(posedge clk) casex (s) 2'b0?: q <= 1'b1; endcase endmodule`,
      /casex は未対応/],
    // z / ? は casez のラベルでだけ意味がある。他の場所で黙って 0 にすると
    // 回路が静かに変わるので断る
    ['z を式の中に書いたら断る',
      `module m(output [3:0] y); assign y = 4'b1?01; endmodule`,
      /casez のラベルでしか使えない/],
    ['casez でない case のラベルの z は断る',
      `module m(input clk, input [3:0] a, output reg y);
       always @(posedge clk) case (a) 4'b1???: y <= 1'b1; default: y <= 1'b0; endcase endmodule`,
      /casez のラベルでしか使えない/],
    ['parameter の z も断る',
      `module m #(parameter W = 4'bz1) (output y); assign y = 1'b0; endmodule`,
      /casez のラベルでしか使えない/],
    ['x は値として断る',
      `module m(output [3:0] y); assign y = 4'bx1; endmodule`,
      /x は未対応/],
    ["10 進の z は断る",
      `module m(output [3:0] y); assign y = 4'dz; endmodule`,
      /10 進のリテラルでは z \/ \? は使えない/],
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
      /'=' は integer にだけ書ける/],
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
  let inSub = false;         // 子モジュールの本体を組み立てている間だけ true

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
    if (r < 0.37) return `(~${expr(depth - 1)})`;
    if (r < 0.4) {
      // 乗除算。回路が他より一桁大きいので、右辺は葉に留めて深追いしない
      const md = ['*', '/', '%'][Math.floor(rng() * 3)];
      return `(${expr(depth - 1)} ${md} ${expr(0)})`;
    }
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
    if (r < 0.96) return `(${expr(depth - 1)} ? ${expr(depth - 1)} : ${expr(depth - 1)})`;
    // 生成した function をインライン展開に通す。中身は if / case / ローカル変数入り。
    // 子モジュールには宣言していないので、そちらを組み立てている間は出さない
    if (r < 0.98 && !inSub) return `rndf(${expr(depth - 1)}, ${expr(depth - 1)})`;
    // 繰り返し連接も混ぜる。回数は 1〜4 の定数
    if (rng() < 0.35) return `{${1 + Math.floor(rng() * 4)}{${expr(depth - 1)}}}`;
    return `{${expr(depth - 1)}, ${expr(depth - 1)}}`;
  };

  // 式から呼べる function を 1 本置く。ローカル変数・部分代入・if / case を
  // まとめて通したいので、中身は少し込み入った形にしてある
  lines.push(`  function [7:0] rndf(input [7:0] p, input [7:0] q);
    reg [7:0] t;
    integer k;
    begin
      t = p ^ q;
      if (t[0]) t[7:4] = q[3:0];
      // for の展開も差分テストに通す (ビット並べ替え + 累積)
      for (k = 0; k < 4; k = k + 1)
        t[k] = t[k] ^ p[7-k];
      case (t[2:1])
        2'd0: rndf = t + p;
        2'd1: rndf = t - q;
        2'd2: rndf = {t[3:0], q[7:4]};
        default: rndf = t;
      endcase
    end
  endfunction`);

  // generate で 1 ビットずつ組み立てる wire を 1 本。展開された項目がふつうの
  // assign とまったく同じ経路を通ることを差分テストに通す。入力だけから作るので
  // プールに入れても組合せループにはならない。
  const gop = pick(['^', '&', '|']);
  lines.push('  genvar gi;');
  lines.push('  wire [7:0] wg;');
  lines.push('  for (gi = 0; gi < 8; gi = gi + 1) begin : gblk');
  lines.push('    wire t;');
  lines.push(`    assign t = a[gi] ${gop} b[7-gi];`);
  // if-generate で偶数ビットと奇数ビットの作り方を変える (枝の選択も差分に通す)
  lines.push('    if (gi % 2 == 0) begin : ev');
  lines.push('      assign wg[gi] = c[gi] ? t : ~t;');
  lines.push('    end else begin : od');
  lines.push('      assign wg[gi] = t & c[gi];');
  lines.push('    end');
  lines.push('  end');
  pool.push('wg');

  // 組合せ always を 1 本。ブロッキング代入と「既定値 → 分岐で上書き」を差分に通す。
  // 読むのは入力だけなので、pool に入れても組合せループにはならない
  const cop = pick(['&', '|', '^']);
  lines.unshift('  reg [7:0] rc, rct;');
  lines.push('  always @(*) begin');
  lines.push(`    rct = a ${cop} b;`);
  lines.push('    rc = rct ^ c;');            // 1 行上の結果を読む (ブロッキング)
  lines.push('    if (c[0]) rc = rct;');       // 既定値を置いてあるのでラッチにならない
  lines.push("    else if (c[1]) rc[3:0] = 4'hF;");
  lines.push('  end');
  lines.push('  assign rout5 = rc;');
  pool.push('rc');

  for (let i = 0; i < nWires; i++) {
    // 半分は宣言と同時に代入する (assign に分けたのと同じ回路になるはず)
    if (rng() < 0.5) lines.push(`  wire [7:0] w${i} = ${expr(3)};`);
    else { lines.push(`  wire [7:0] w${i};`); lines.push(`  assign w${i} = ${expr(3)};`); }
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
  lines.unshift('  integer li;');   // while の添字
  const stmt = (depth) => {
    const r = rng();
    if (depth <= 0 || r < 0.4) return `r2 <= ${expr(2)};`;
    // repeat と while も混ぜる。while は添字を本体で進める形にしないと終わらない
    if (r < 0.44) return `repeat (${1 + Math.floor(rng() * 3)}) begin ${stmt(depth - 1)} end`;
    if (r < 0.48) {
      // 呼び出し側が begin … end で囲むので、2 文並べて返してよい
      const n = 1 + Math.floor(rng() * 3);
      return `li = 0; while (li < ${n}) begin ${stmt(depth - 1)} li = li + 1; end`;
    }
    if (r < 0.7) {
      const then = `begin ${stmt(depth - 1)} end`;
      const els = rng() < 0.5 ? ` else begin ${stmt(depth - 1)} end` : '';
      return `if (${expr(2)}) ${then}${els}`;
    }
    // 半分は casez にして、ラベルの一部を don't care にする。式の側は 2 値なので
    // 「その桁を比較しない」だけの違いになり、両実装で同じ結果になるはず
    if (rng() < 0.5) {
      const arms = [`2'b0?: begin ${stmt(depth - 1)} end`, `2'b1?: begin ${stmt(depth - 1)} end`];
      if (rng() < 0.5) arms.push(`default: begin ${stmt(depth - 1)} end`);
      return `casez (${expr(1)}) ${arms.join(' ')} endcase`;
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
  inSub = true;
  const subBody = expr(2);
  inSub = false;
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
  output [7:0] rout4,
  output [7:0] rout5
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
    'if': 0, 'case': 0, 'casez': 0, 'function': 0, '+ / -': 0, '* / %': 0, 'generate': 0,
    'always @(*)': 0, '{n{x}}': 0, 'wire t = 式': 0, 'repeat': 0, 'while': 0,
    '比較': 0, 'シフト': 0, '論理': 0,
    '非同期リセット': 0, '階層': 0, 'parameter': 0, 'リダクション': 0,
  };

  for (let d = 0; d < 25 && !mismatch; d++) {
    const src = randomDesign(rng, 6);
    if (/\bif \(/.test(src)) seen['if']++;
    if (/\bcase \(/.test(src)) seen['case']++;
    if (/\bcasez \(/.test(src)) seen['casez']++;
    if (/\brndf\(/.test(src)) seen['function']++;
    if (/[-+] /.test(src)) seen['+ / -']++;
    if (/[*/%] /.test(src)) seen['* / %']++;
    if (/begin : gblk/.test(src)) seen['generate']++;
    if (src.includes('always @(*)')) seen['always @(*)']++;
    if (/\{\d+\{/.test(src)) seen['{n{x}}']++;
    if (/wire \[7:0\] w\d+ =/.test(src)) seen['wire t = 式']++;
    if (src.includes('repeat (')) seen['repeat']++;
    if (src.includes('while (li')) seen['while']++;
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
      for (const port of ['y', 'rout', 'rout2', 'rout3', 'rout4', 'rout5']) {
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
    // decodeCircuitData は圧縮形式のまま返す。エディタはサンプルや .json と同じ入口に
    // 流し込むのでこちらを使う (展開済みを渡すと二重展開になって開けない)
    eqs(JSON.stringify(expandCircuit(decodeCircuitData(encodeCircuit(g)))), JSON.stringify(g),
      `保存形式: ${name} がリンクから圧縮形式のまま戻せる`);
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
  eq(insOf(expandCircuit({ nodes: [[1, 'cat', 0, 0]], wires: [] }).nodes[0]), 2,
    '連接: 本数を書いていない古い保存は 2 入力のまま');

  // 入力の本数は w の枠で決める。1 本の連接は無いので下限は 2
  eq(insOf(expandCircuit({ nodes: [[1, 'cat', 0, 0, 0, null, null, 4]], wires: [] }).nodes[0]), 4,
    '連接: 本数を 4 にすると入力端子が 4 本になる');
  eq(insOf(expandCircuit({ nodes: [[1, 'cat', 0, 0, 0, null, null, 1]], wires: [] }).nodes[0]), 2,
    '連接: 本数 1 は 2 に上がる');
  eq(insOf(expandCircuit({ nodes: [[1, 'cat', 0, 0, 0, null, null, 99]], wires: [] }).nodes[0]), 2,
    '連接: 範囲外の本数は 2 に落ちる');
  eq(expandCircuit(packCircuit(expandCircuit({
    nodes: [[1, 'cat', 0, 0, 0, null, null, 5]], wires: [],
  }))).nodes[0].w, 5, '連接: 本数が往復して残る');

  // 4 本を束ねる。上の端子が上位ビットになる
  const cat4 = await build('4 入力の連接', {
    nodes: [[1, 'in', 0, 0, 1, 'a'], [2, 'in', 0, 60, 0, 'b'],
      [3, 'in', 0, 120, 0, 'c', null, 2], [4, 'in', 0, 180, 0, 'd', null, 4],
      [5, 'cat', 220, 60, 0, null, null, 4], [6, 'out', 430, 90, 0, 'y']],
    wires: [[1, 0, 5, 0], [2, 0, 5, 1], [3, 0, 5, 2], [4, 0, 5, 3], [5, 0, 6, 0]],
  }, [
    [{ a: 1, b: 0, c: 0, d: 0 }, { y: 0x80 }],   // 1 + 1 + 2 + 4 = 8 ビット
    [{ a: 0, b: 1, c: 0, d: 0 }, { y: 0x40 }],
    [{ a: 0, b: 0, c: 3, d: 0 }, { y: 0x30 }],
    [{ a: 0, b: 0, c: 0, d: 15 }, { y: 0x0F }],
    [{ a: 1, b: 1, c: 2, d: 10 }, { y: 0xEA }],
  ]);
  ok(cat4.source.includes('{a, b, c, d}'), '連接: 4 本が 1 個の {} になる', cat4.source);
  ok(cat4.source.includes('output [7:0] y'), '連接: 出力は 4 本の合計 (8 ビット)', cat4.source);

  // 1 ビットを 8 本束ねてバスにする — 2 入力しか無かった頃は 7 個つないでいた
  const cat8 = await build('8 入力の連接', {
    nodes: [...Array.from({ length: 8 }, (_, i) => [i + 1, 'in', 0, i * 40, 0, `p${i}`]),
      [9, 'cat', 220, 140, 0, null, null, 8], [10, 'out', 430, 140, 0, 'y']],
    wires: [...Array.from({ length: 8 }, (_, i) => [i + 1, 0, 9, i]), [9, 0, 10, 0]],
  }, [
    [{ p0: 1, p1: 0, p2: 1, p3: 0, p4: 1, p5: 0, p6: 1, p7: 0 }, { y: 0xAA }],
    [{ p0: 0, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 1 }, { y: 0x7F }],
  ]);
  ok(cat8.source.includes('output [7:0] y'), '連接: 1 ビット 8 本で 8 ビットになる', cat8.source);

  // 途中の 1 本が未配線だと幅が決まらない。未配線の部品と同じ扱いで落ちる
  const catHole = toVerilog(expandCircuit({
    nodes: [[1, 'in', 0, 0, 0, 'a'], [2, 'in', 0, 60, 0, 'b'],
      [3, 'cat', 220, 30, 0, null, null, 3], [4, 'out', 430, 30, 0, 'y']],
    wires: [[1, 0, 3, 0], [2, 0, 3, 2], [3, 0, 4, 0]],
  }));
  ok(!catHole.source.includes('{'), '連接: 1 本でも未配線なら回路に出ない', catHole.source);

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
  ['signed', testSigned],
  ['畳み込み / CSE', testFoldCse],
  ['刈り取り', testPrune],
  ['乗除算', testMulDiv],
  ['generate', testGenerate],
  ['always @(*)', testCombAlways],
  ['繰り返し連接 / 宣言の代入', testSugar],
  ['階層参照', testHierRef],
  ['initial', testInitial],
  ['while / repeat', testLoops],
  ['比較器', testCompare],
  ['ALU (case の書き方)', testAlu],
  ['非 ANSI と多入力ゲート', testOnehot],
  ['リダクション', testReduce],
  ['論理演算子', testLogical],
  ['範囲判定', testWindow],
  ['シフト', testShift],
  ['シフト回路', testShifter],
  ['if / case', testIfCase],
  ['casez', testCasez],
  ['function', testFunction],
  ['for', testForLoop],
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
