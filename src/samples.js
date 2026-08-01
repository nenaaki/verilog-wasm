// GUI エディタのサンプル回路。examples/*.v の回路グラフ版で、中身は保存形式そのもの。
//
//   nodes: [[id, type, x, y, 入力の初期値, 端子名, 付加情報], …]
//   wires: [[出力ノード, 端子, 入力ノード, 端子], …]
//
// 端子名を省くと自動名 (入力 a,b,… / 出力 y0,y1,… / それ以外 n<id>) になる。
// expect / seq / loop はテスト (test/run.js) が使う期待値で、エディタは見ない。
//
// 変換ロジック (src/schematic.js) から分けてあるのは、これがデータだから。
// 大きいものは手で座標を並べるより組み立てたほうが読めるので、関数で作っている。

import { expandCircuit, packCircuit } from './schematic.js';

/** 半加算器。回路部品のサンプルからも中身として使うので独立させてある */
const HALF_ADDER = {
  nodes: [
    [1, 'in', 40, 90, 1], [2, 'in', 40, 260, 1],
    [3, 'xor', 300, 90], [4, 'and', 300, 260],
    [5, 'out', 560, 90, 0, 'sum'], [6, 'out', 560, 260, 0, 'carry'],
  ],
  wires: [[1, 0, 3, 0], [2, 0, 3, 1], [1, 0, 4, 0], [2, 0, 4, 1], [3, 0, 5, 0], [4, 0, 6, 0]],
  expect: { sum: [0, 1, 1, 0], carry: [0, 0, 0, 1] },
};

/**
 * GUI エディタのサンプル回路。examples/*.v の回路グラフ版。
 * 圧縮形式: nodes は [id, type, x, y, 入力の初期値, 端子名], wires は [出力ノード, 端子, 入力ノード, 端子]。
 * 端子名は省略すると自動名 (入力 a,b,… / 出力 y0,y1,… / それ以外 n<id>) になる。
 */
export const SAMPLE_CIRCUITS = {
  'AND ゲート': {
    nodes: [[1, 'in', 40, 90, 1], [2, 'in', 40, 200, 0], [3, 'and', 300, 145], [4, 'out', 560, 145]],
    wires: [[1, 0, 3, 0], [2, 0, 3, 1], [3, 0, 4, 0]],
    expect: { y0: [0, 0, 0, 1] },
  },
  '半加算器 (sum / carry)': HALF_ADDER,
  'NAND 4 個で XOR': {
    nodes: [
      [1, 'in', 30, 100, 1], [2, 'in', 30, 300, 0],
      [3, 'nand', 210, 200], [4, 'nand', 400, 90], [5, 'nand', 400, 310],
      [6, 'nand', 590, 200], [7, 'out', 780, 200, 0, 'y'],
    ],
    wires: [
      [1, 0, 3, 0], [2, 0, 3, 1],
      [1, 0, 4, 0], [3, 0, 4, 1],
      [3, 0, 5, 0], [2, 0, 5, 1],
      [4, 0, 6, 0], [5, 0, 6, 1],
      [6, 0, 7, 0],
    ],
    expect: { y: [0, 1, 1, 0] },
  },
  '多数決 (3 入力のうち 2 つ以上が 1)': {
    nodes: [
      [1, 'in', 30, 60, 1], [2, 'in', 30, 200, 1], [3, 'in', 30, 340, 0],
      [4, 'and', 220, 80], [5, 'and', 220, 230], [6, 'and', 220, 370],
      [7, 'or', 430, 150], [8, 'or', 620, 240], [9, 'out', 800, 240, 0, 'y'],
    ],
    wires: [
      [1, 0, 4, 0], [2, 0, 4, 1],
      [2, 0, 5, 0], [3, 0, 5, 1],
      [1, 0, 6, 0], [3, 0, 6, 1],
      [4, 0, 7, 0], [5, 0, 7, 1],
      [7, 0, 8, 0], [6, 0, 8, 1],
      [8, 0, 9, 0],
    ],
    expect: { y: [0, 0, 0, 1, 0, 1, 1, 1] },
  },
  'クロックで反転する 1 ビットメモリ': {
    nodes: [
      [1, 'dff', 330, 180, 0, 'q'], [2, 'not', 530, 180], [3, 'out', 700, 180, 0, 'out'],
    ],
    // Q を反転して自分の D に戻す。1 クロックごとに 0 → 1 → 0 …
    wires: [[1, 0, 2, 0], [2, 0, 1, 0], [1, 0, 3, 0]],
    seq: [
      { expect: { out: 0 } },
      { clock: 1, expect: { out: 1 } },
      { clock: 1, expect: { out: 0 } },
      { clock: 1, expect: { out: 1 } },
      { clock: 7, expect: { out: 0 } },
    ],
  },
  '書き込みイネーブル付き 1 ビットメモリ': {
    nodes: [
      [1, 'in', 20, 60, 1, 'd'], [2, 'in', 20, 300, 1, 'en'],
      [3, 'not', 170, 380],
      [4, 'and', 320, 60], [5, 'and', 320, 300],     // d & en  /  Q & ~en
      [6, 'or', 470, 170], [7, 'dff', 620, 170, 0, 'mem'], [8, 'out', 790, 170, 0, 'q'],
    ],
    // en=1 なら d を取り込み、en=0 なら今の値を保持する (2:1 マルチプレクサ)
    wires: [
      [2, 0, 3, 0],
      [1, 0, 4, 0], [2, 0, 4, 1],
      [7, 0, 5, 0], [3, 0, 5, 1],
      [4, 0, 6, 0], [5, 0, 6, 1],
      [6, 0, 7, 0], [7, 0, 8, 0],
    ],
    seq: [
      { set: { d: 1, en: 1 }, expect: { q: 0 } },               // クロック前は 0
      { clock: 1, expect: { q: 1 } },                           // 許可ありで 1 を書く
      { set: { d: 0, en: 0 }, clock: 3, expect: { q: 1 } },     // 許可なしなので保持
      { set: { en: 1 }, clock: 1, expect: { q: 0 } },           // 許可ありで 0 を書く
      { set: { d: 1, en: 0 }, clock: 5, expect: { q: 0 } },     // また保持
    ],
  },
  '組合せループ (エラーになる例)': {
    nodes: [[1, 'in', 60, 200, 1], [2, 'and', 300, 200], [3, 'not', 520, 200]],
    wires: [[1, 0, 2, 0], [3, 0, 2, 1], [2, 0, 3, 0]],
    loop: true,
  },
  '4 ビットバレルシフタ (論理左シフト)': barrelShifter4(),
  '全加算器 (半加算器を部品にして 2 個)': fullAdderFromBlocks(),
};

/**
 * 半加算器を「回路部品」として 2 個置いて全加算器にしたサンプル。
 * 部品の中身は参照ではなく埋め込みなので、これ 1 つで完結している。
 */
function fullAdderFromBlocks() {
  const def = packCircuit(expandCircuit(HALF_ADDER));
  return {
    nodes: [
      [1, 'in', 20, 40, 1, 'a'], [2, 'in', 20, 130, 1, 'b'], [3, 'in', 20, 330, 1, 'cin'],
      [10, 'block', 170, 30, 0, null, { ref: '半加算器', def }],
      [11, 'block', 170, 200, 0, null, { ref: '半加算器', def }],
      [20, 'or', 420, 330],
      [30, 'out', 620, 210, 0, 'sum'], [31, 'out', 620, 340, 0, 'cout'],
    ],
    wires: [
      [1, 0, 10, 0], [2, 0, 10, 1],        // a, b → 1 段目
      [10, 0, 11, 0], [3, 0, 11, 1],       // 1 段目の sum と cin → 2 段目
      [11, 0, 30, 0],                      // 2 段目の sum が答え
      [10, 1, 20, 0], [11, 1, 20, 1],      // 桁上がり 2 本を OR
      [20, 0, 31, 0],
    ],
    expect: {
      sum:  [0, 1, 1, 0, 1, 0, 0, 1],
      cout: [0, 0, 0, 1, 0, 1, 1, 1],
    },
  };
}

/**
 * 4 ビットのバレルシフタ。2:1 マルチプレクサの 2 段（1 ビットぶん / 2 ビットぶん）で
 * 任意のシフト量を 1 パスで作る、というのがバレルシフタの要点。
 *
 *   入力 d0..d3 = データ / s0,s1 = シフト量  →  出力 y0..y3 = 左に (s1,s0) ビットシフト
 *
 * 押し出された桁は捨て、空いた桁には定数 0 の部品を入れる（論理左シフト）。
 * 手で座標を並べるには大きすぎるので組み立てて返す。27 ゲート・6 入力・4 出力。
 */
function barrelShifter4() {
  const nodes = [];
  const wires = [];
  let id = 0;
  const add = (type, x, y, value, name) => { nodes.push([++id, type, x, y, value, name]); return id; };
  const wire = (from, to, port) => { wires.push([from, 0, to, port]); };

  const COL = { in: 12, not: 100, and1: 222, or1: 332, and2: 452, or2: 562, out: 680 };
  const ROW8 = (i) => 8 + i * 61;      // 8 個並べる列 (AND)
  const ROW4 = (i) => 40 + i * 122;    // 4 個並べる列 (OR・出力)

  /** sel=0 なら lo、sel=1 なら hi を通す 2:1 マルチプレクサ */
  const mux = (lo, hi, sel, notSel, xAnd, xOr, i) => {
    const g0 = add('and', xAnd, ROW8(i * 2));
    const g1 = add('and', xAnd, ROW8(i * 2 + 1));
    const g2 = add('or', xOr, ROW4(i));
    wire(lo, g0, 0); wire(notSel, g0, 1);
    wire(hi, g1, 0); wire(sel, g1, 1);
    wire(g0, g2, 0); wire(g1, g2, 1);
    return g2;
  };

  // データ 4 ビットとシフト量 2 ビット。初期値は 1101 を 2 ビットシフトした状態
  const d = [1, 0, 1, 1].map((v, i) => add('in', COL.in, 8 + i * 78, v, `d${i}`));
  const zero = add('const', COL.in, 320, 0);         // シフトで空いた桁に入れる 0
  const s0 = add('in', COL.in, 378, 0, 's0');
  const s1 = add('in', COL.in, 436, 1, 's1');
  const nS0 = add('not', COL.not, 378);
  const nS1 = add('not', COL.not, 436);
  wire(s0, nS0, 0);
  wire(s1, nS1, 0);

  // 1 段目: s0=1 で 1 ビット / 2 段目: s1=1 で 2 ビット。はみ出す側は 0 を入れる
  const t = [0, 1, 2, 3].map((i) => mux(d[i], i >= 1 ? d[i - 1] : zero, s0, nS0, COL.and1, COL.or1, i));
  const y = [0, 1, 2, 3].map((i) => mux(t[i], i >= 2 ? t[i - 2] : zero, s1, nS1, COL.and2, COL.or2, i));
  for (let i = 0; i < 4; i++) wire(y[i], add('out', COL.out, ROW4(i), 0, `y${i}`), 0);

  // 期待値: データを (s1,s0) ビット左にシフトしたもの (4 ビットに収まらない桁は消える)
  const expect = { y0: [], y1: [], y2: [], y3: [] };
  for (let pat = 0; pat < 64; pat++) {
    const shifted = ((pat & 15) << ((pat >> 4) & 3)) & 15;
    for (let i = 0; i < 4; i++) expect[`y${i}`].push((shifted >> i) & 1);
  }
  return { nodes, wires, expect };
}
