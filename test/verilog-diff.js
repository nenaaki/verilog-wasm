// 本物の Verilog シミュレータとの差分テスト。node test/verilog-diff.js
//
// **これまでの物差しは全部「自分の理解」の中にあった。** WASM と参照実装は同じ
// ネットリストを見ているし、演算子を突き合わせる JS のモデルもこちらが書いたもの。
// つまり Verilog の意味論を読み違えていたら、揃って間違ったまま緑になる。
//
// そこで Icarus Verilog に同じソースを食わせて出力を突き合わせる。**4 値
// (--xstate) でだけ意味がある** ―― 2 値では x が出ないので、Verilog が x を返す
// 場面（0 除算・算術に x が混ざったとき）を比べようがない。
//
// 実際にこれで見つかったずれ:
//   casex が式の側の x を don't care にしていなかった
//   0 除算が x にならなかった (2 値の「回路が出す値」を引きずっていた)
//   算術・大小比較・シフト量の x が、ビットごとにしか広がっていなかった
//
// iverilog が無い環境ではスキップして正常終了する (test/ui.js の Chrome と同じ)。
//
//   IVERILOG=/path/to/iverilog node test/verilog-diff.js

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compile, RefSimulator } from '../src/compile.js';
import { makeRng, randomDesign } from './random-design.js';

// ------------------------------------------------------ iverilog を探す
const CANDIDATES = [
  process.env.IVERILOG,
  'C:/iverilog/bin/iverilog.exe',
  'C:/Program Files/iverilog/bin/iverilog.exe',
  '/usr/bin/iverilog',
  '/usr/local/bin/iverilog',
  '/opt/homebrew/bin/iverilog',
].filter(Boolean);

const iverilog = CANDIDATES.find((p) => existsSync(p));
if (!iverilog) {
  console.log('skip Verilog 差分テスト (iverilog が見つからない)');
  console.log('     IVERILOG=/path/to/iverilog node test/verilog-diff.js で場所を指定できます');
  console.log('     Windows なら winget install Icarus.Verilog');
  process.exit(0);
}
const vvp = iverilog.replace(/iverilog(\.exe)?$/, 'vvp$1');

const dir = mkdtempSync(join(tmpdir(), 'vwasm-ivdiff-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 掴まれている */ } });

let passed = 0;
const failures = [];
const ok = (cond, label, detail = '') =>
  (cond ? passed++ : failures.push(`${label}${detail ? ` — ${detail}` : ''}`));

/**
 * module のソースと入力ベクタを受け取り、iverilog の出力を「行 → 列」で返す。
 * 観測するのは module の output だけ。テストベンチはここで組み立てる。
 */
function runIverilog(name, src, ports, inputs, vectors) {
  const decl = ports.map((p) => `wire ${p.w > 1 ? `[${p.w - 1}:0] ` : ''}${p.name};`).join(' ');
  const regs = inputs.map((i) => `reg [${i.w - 1}:0] ${i.name};`).join(' ');
  const conn = [...inputs, ...ports].map((p) => p.name).join(', ');
  const fmt = ports.map(() => ' %b').join('');
  const args = ports.map((p) => p.name).join(', ');
  const lines = vectors.map((v) => {
    const set = inputs.map((i, k) => `${i.name}=${i.w}'b${v[k]};`).join(' ');
    return `    ${set} #1 $display("${v.join(' ')}${fmt}", ${args});`;
  }).join('\n');

  const tb = `${src}
module tb;
  ${regs}
  ${decl}
  ${name} u(${conn});
  initial begin
${lines}
  end
endmodule`;
  const vsrc = join(dir, `${name}.v`);
  const vout = join(dir, `${name}.vvp`);
  writeFileSync(vsrc, tb);
  execFileSync(iverilog, ['-o', vout, vsrc], { stdio: 'pipe' });
  return execFileSync(vvp, [vout], { encoding: 'utf8' }).trim().split('\n')
    .map((l) => l.trim().split(/\s+/));
}

/** 同じソース・同じベクタを自前の 4 値評価に通して、iverilog と 1 件ずつ比べる */
function compare(label, name, src, ports, inputs, vectors) {
  let rows;
  try {
    rows = runIverilog(name, src, ports, inputs, vectors);
  } catch (e) {
    failures.push(`${label}: iverilog が失敗した — ${String(e.stderr ?? e.message).slice(0, 200)}`);
    return;
  }
  const sim = new RefSimulator(compile(src, { wat: false, xstate: true }));
  const bad = [];
  let n = 0;
  for (const cols of rows) {
    inputs.forEach((i, k) => sim.setInput(i.name, cols[k]));
    sim.eval();
    ports.forEach((p, k) => {
      n++;
      const want = cols[inputs.length + k];
      const got = sim.getBits(p.name);
      if (want !== got && bad.length < 3) {
        bad.push(`${p.name}(${cols.slice(0, inputs.length).join(' ')}): iverilog=${want} 自前=${got}`);
      }
    });
  }
  ok(bad.length === 0, `${label} (${n} 件)`, bad.join(' | '));
}

// 入力に使うビットパターン。x を混ぜたものを厚めに入れる
const PATS = ['0000', '0001', '0011', '0101', '1010', '1111', '001x', 'x001', '1x01', 'xxxx', '0x0x', '1xxx'];
const PAIRS = [];
for (const a of PATS) for (const b of PATS) PAIRS.push([a, b]);

// ============================================================ 演算子の全表
//
// **どの演算子が「ビットごと」でどれが「まとめて x」なのかが要点。**
// Verilog はここを演算子ごとに決めていて、読んだだけでは取り違える。
const OPS = [
  ['add', 'a + b', 4], ['sub', 'a - b', 4], ['mul', 'a * b', 4],
  ['div', 'a / b', 4], ['mod', 'a % b', 4], ['neg', '-a', 4],
  ['band', 'a & b', 4], ['bor', 'a | b', 4], ['bxor', 'a ^ b', 4],
  ['bxnor', 'a ~^ b', 4], ['bnot', '~a', 4],
  ['lt', 'a < b', 1], ['le', 'a <= b', 1], ['gt', 'a > b', 1], ['ge', 'a >= b', 1],
  ['eq', 'a == b', 1], ['ne', 'a != b', 1], ['ceq', 'a === b', 1], ['cne', 'a !== b', 1],
  ['redand', '&a', 1], ['redor', '|a', 1], ['redxor', '^a', 1],
  ['redn', '~&a', 1], ['rednor', '~|a', 1],
  // **反転するリダクションは幅の広い文脈にも置く。** 1 ビットの文脈だと
  // 「1 トークンか、`~` と `&` に割れたか」の違いが出ない (割れると `~` が
  // 文脈幅を受け取って 8 ビットの反転になる)。実際にここが壊れていた
  ['nand4', '~&a', 4], ['nor4', '~|a', 4], ['xnor4', '~^a', 4],
  ['norshift', '(~|a) << 1', 4], ['norcat', '{2\'b0, ~|a}', 4],
  ['lnot', '!a', 1], ['land', 'a && b', 1], ['lor', 'a || b', 1],
  ['cat', '{a[1:0], b[1:0]}', 4], ['rep', '{2{a[1:0]}}', 4], ['part', 'a[2:1]', 2],
  ['shl', 'a << b[1:0]', 4], ['shr', 'a >> b[1:0]', 4],
  ['shlk', 'a << 1', 4], ['shrk', 'a >> 1', 4],
  ['tern', 'a[0] ? a : b', 4], ['sel', 'b[0] ? 4\'h5 : a', 4],
];
{
  const ports = OPS.map(([n, , w]) => ({ name: n, w }));
  const src = `module ops(input [3:0] a, input [3:0] b, ${
    ports.map((p) => `output ${p.w > 1 ? `[${p.w - 1}:0] ` : ''}${p.name}`).join(', ')});
${OPS.map(([n, e]) => `  assign ${n} = ${e};`).join('\n')}
endmodule`;
  compare('演算子の全表', 'ops', src, ports, [{ name: 'a', w: 4 }, { name: 'b', w: 4 }], PAIRS);
}

// ============================================================ signed
{
  const SOPS = [
    ['sadd', 'sa + sb', 8], ['sdiv', 'sa / sb', 4], ['smod', 'sa % sb', 4],
    ['slt', 'sa < sb', 1], ['sge', 'sa >= sb', 1],
    ['sasr', 'sa >>> 1', 4], ['sasrv', 'sa >>> b[1:0]', 4],
    ['sext', 'sa', 8], ['uext', '$unsigned(sa)', 8], ['smix', 'sa + b', 8],
  ];
  const ports = SOPS.map(([n, , w]) => ({ name: n, w }));
  const src = `module sops(input [3:0] a, input [3:0] b, ${
    ports.map((p) => `output signed ${p.w > 1 ? `[${p.w - 1}:0] ` : ''}${p.name}`).join(', ')});
  wire signed [3:0] sa = a;
  wire signed [3:0] sb = b;
${SOPS.map(([n, e]) => `  assign ${n} = ${e};`).join('\n')}
endmodule`;
  compare('signed', 'sops', src, ports, [{ name: 'a', w: 4 }, { name: 'b', w: 4 }], PAIRS);
}

// ============================================================ case / casez / casex
//
// case は「そっくり同じか」、casez は z / ?、casex は x も比較から外す。
// **casex は式の側の x も don't care** ―― ここは実際にずれていた所。
{
  const src = `module cases(input [3:0] a, input [3:0] b, output reg [3:0] cc,
  output reg [3:0] cz, output reg [3:0] cx, output reg [3:0] cmul);
  always @(*) case (a)
    4'b0001: cc = 4'h1; 4'b0010: cc = 4'h2; 4'bxx11: cc = 4'h3; default: cc = 4'h0;
  endcase
  always @(*) casez (a)
    4'b1???: cz = 4'h1; 4'b01??: cz = 4'h2; 4'b001?: cz = 4'h3; default: cz = 4'h0;
  endcase
  always @(*) casex (a)
    4'b1xxx: cx = 4'h1; 4'b01xx: cx = 4'h2; 4'b001x: cx = 4'h3; default: cx = 4'h0;
  endcase
  always @(*) case (a)
    4'b0001, 4'b0010: cmul = 4'h5; default: cmul = b;
  endcase
endmodule`;
  const ports = ['cc', 'cz', 'cx', 'cmul'].map((n) => ({ name: n, w: 4 }));
  compare('case / casez / casex', 'cases', src, ports,
    [{ name: 'a', w: 4 }, { name: 'b', w: 4 }], PAIRS);
}

// ============================================================ if / 多段の式
{
  const src = `module mix(input [3:0] a, input [3:0] b, output reg [3:0] y, output [3:0] z,
  output [3:0] f);
  always @(*) begin
    y = 4'h0;
    if (a[3]) y = a + b;
    else if (a[2]) y = a - b;
    else if (|b) y = a & b;
  end
  assign z = ((a + b) ^ (a - b)) | (a[1] ? {a[1:0], b[1:0]} : ~b);
  function [3:0] g(input [3:0] p, input [3:0] q);
    reg [3:0] t;
    begin t = p ^ q; if (t[0]) t = t + 4'h1; g = t; end
  endfunction
  assign f = g(a, b);
endmodule`;
  const ports = ['y', 'z', 'f'].map((n) => ({ name: n, w: 4 }));
  compare('if / 多段の式 / function', 'mix', src, ports,
    [{ name: 'a', w: 4 }, { name: 'b', w: 4 }], PAIRS);
}

// ============================================================ 順序回路
//
// レジスタを通した x の伝わり方と、`initial` の有無で電源投入時が変わることを見る。
// **`initial` を書かないレジスタは両方とも x から始まる**ので、そこも揃うはず。
function compareSeq(label, name, src, ports, inputs, vectors) {
  const decl = ports.map((p) => `wire ${p.w > 1 ? `[${p.w - 1}:0] ` : ''}${p.name};`).join(' ');
  const regs = inputs.map((i) => `reg [${i.w - 1}:0] ${i.name};`).join(' ');
  const conn = ['clk', ...inputs.map((i) => i.name), ...ports.map((p) => p.name)].join(', ');
  const fmt = ports.map(() => ' %b').join('');
  const args = ports.map((p) => p.name).join(', ');
  // 入力を置く → #1 → 立ち上げる → #1 で表示 → 下げる、を 1 サイクルとする
  const body = vectors.map((v) => {
    const set = inputs.map((i, k) => `${i.name}=${i.w}'b${v[k]};`).join(' ');
    return `    ${set} #1 clk=1; #1 $display("${v.join(' ')}${fmt}", ${args}); clk=0; #1;`;
  }).join('\n');
  const tb = `${src}
module tb;
  reg clk;
  ${regs}
  ${decl}
  ${name} u(${conn});
  initial begin
    clk = 0;
${body}
  end
endmodule`;
  const vsrc = join(dir, `${name}.v`);
  const vout = join(dir, `${name}.vvp`);
  writeFileSync(vsrc, tb);
  let rows;
  try {
    execFileSync(iverilog, ['-o', vout, vsrc], { stdio: 'pipe' });
    rows = execFileSync(vvp, [vout], { encoding: 'utf8' }).trim().split('\n')
      .map((l) => l.trim().split(/\s+/));
  } catch (e) {
    failures.push(`${label}: iverilog が失敗した — ${String(e.stderr ?? e.message).slice(0, 200)}`);
    return;
  }

  const sim = new RefSimulator(compile(src, { wat: false, xstate: true }));
  sim.reset();
  const bad = [];
  let n = 0;
  for (const cols of rows) {
    inputs.forEach((i, k) => sim.setInput(i.name, cols[k]));
    sim.step();
    ports.forEach((p, k) => {
      n++;
      const want = cols[inputs.length + k];
      const got = sim.getBits(p.name);
      if (want !== got && bad.length < 3) {
        bad.push(`${p.name}(${cols.slice(0, inputs.length).join(' ')}): iverilog=${want} 自前=${got}`);
      }
    });
  }
  ok(bad.length === 0, `${label} (${n} 件)`, bad.join(' | '));
}

{
  const src = `module seq(input clk, input [3:0] d, input [3:0] e,
  output reg [3:0] free, output reg [3:0] seeded, output reg [3:0] acc,
  output reg [3:0] branch, output reg [3:0] held);
  initial seeded = 4'h5;
  always @(posedge clk) begin
    free   <= d;
    seeded <= seeded + 4'h1;
    acc    <= acc ^ d;
    if (d[0]) branch <= e; else branch <= d;
    case (d[1:0]) 2'b00: held <= 4'h0; 2'b01: held <= e; endcase
  end
endmodule`;
  const ports = ['free', 'seeded', 'acc', 'branch', 'held'].map((n) => ({ name: n, w: 4 }));
  // サイクルをまたいで x が混ざるように、確実な値と x を交互に入れる
  const vecs = [];
  for (const d of PATS) for (const e of ['0011', '1x01', 'xxxx']) vecs.push([d, e]);
  compareSeq('順序回路 (レジスタ・x の保持)', 'seq', src, ports,
    [{ name: 'd', w: 4 }, { name: 'e', w: 4 }], vecs);
}

// ============================================================ ランダム回路
//
// **ここまでは「こちらが思いついた式」を並べていた。** それだと列挙から漏れたものが
// そのまま残るので、[ランダム生成器](random-design.js)が出すものをそのまま流す。
// 生成器は `generate`・階層・`for` / `while` / `repeat`・`function`・`casez` / `casex`・
// `signed`・非同期リセット・`x` 混じりのリテラルを混ぜるので、**こちらが列挙しなかった
// 組み合わせまで網に入る**。
//
// 1 サイクルを 2 点で見る:
//   A … 入力を置いて落ち着かせた所 (組合せ + 非同期リセット)  ← eval()
//   B … クロックを 1 発打った所     (レジスタ)               ← step()
{
  const rng = makeRng(20260818);
  const IN = [{ name: 'a', w: 8 }, { name: 'b', w: 8 }, { name: 'c', w: 8 }, { name: 'rst', w: 1 }];
  const OUT = ['y', 'rout', 'rout2', 'rout3', 'rout4', 'rout5'].map((n) => ({ name: n, w: 8 }));
  // データには x を混ぜるが、**リセット線だけは 0 / 1 に固定する**。
  // Verilog の `posedge rst` は x への遷移でも発火するので、rst を x にすると
  // 「エッジで発火する Verilog」と「rst が真のあいだ上書きするこちら」の
  // モデルの差が出る (README「クロックを待たない、を cycle-based でどう表すか」)。
  // 実際の RTL がリセット線を x にすることは無いので、そこは測る対象から外す。
  const pat = (w, allowX = true) => [...Array(w)]
    .map(() => (allowX && rng() < 0.25 ? 'x' : String(Math.floor(rng() * 2)))).join('');

  let designs = 0;
  const bad = [];
  let checked = 0;

  for (let d = 0; d < 8; d++) {
    const src = randomDesign(rng, 5, { xstate: true });
    const vectors = [...Array(6)].map(() => IN.map((i) => pat(i.w, i.name !== 'rst')));

    const fmt = OUT.map(() => ' %b').join('');
    const args = OUT.map((p) => p.name).join(', ');
    const body = vectors.map((v) => {
      const set = IN.map((i, k) => `${i.name}=${i.w}'b${v[k]};`).join(' ');
      return `    ${set} #1 $display("A ${v.join(' ')}${fmt}", ${args});\n`
        + `    clk=1; #1 $display("B ${v.join(' ')}${fmt}", ${args}); clk=0; #1;`;
    }).join('\n');
    const tb = `${src}
module tb;
  reg clk; ${IN.map((i) => `reg [${i.w - 1}:0] ${i.name};`).join(' ')}
  ${OUT.map((p) => `wire [${p.w - 1}:0] ${p.name};`).join(' ')}
  rnd u(clk, rst, a, b, c, ${OUT.map((p) => p.name).join(', ')});
  initial begin
    clk = 0;
${body}
  end
endmodule`;
    const vsrc = join(dir, `rnd${d}.v`);
    const vout = join(dir, `rnd${d}.vvp`);
    writeFileSync(vsrc, tb);
    let rows;
    try {
      execFileSync(iverilog, ['-o', vout, vsrc], { stdio: 'pipe' });
      rows = execFileSync(vvp, [vout], { encoding: 'utf8' }).trim().split('\n')
        .map((l) => l.trim().split(/\s+/));
    } catch (e) {
      failures.push(`ランダム回路 ${d}: iverilog が失敗した — ${String(e.stderr ?? e.message).slice(0, 300)}\n${src}`);
      continue;
    }
    designs++;

    const sim = new RefSimulator(compile(src, { wat: false, xstate: true }));
    sim.reset();
    for (const cols of rows) {
      const [phase, ...rest] = cols;
      IN.forEach((i, k) => sim.setInput(i.name, rest[k]));
      // A で eval を 2 回呼ぶのは**非同期リセットの決まり**。`eval` は末尾で Q を
      // 書くので、その回の組合せ論理は先頭で読んだ古い Q を使っている。
      // 下流の組合せ出力まで追いつかせるには もう 1 回要る (README「クロックを
      // 待たない、を cycle-based でどう表すか」)。step() は末尾に eval があるので不要。
      if (phase === 'A') sim.eval().eval(); else sim.step();
      OUT.forEach((p, k) => {
        checked++;
        const want = rest[IN.length + k];
        const got = sim.getBits(p.name);
        if (want !== got && bad.length < 2) {
          bad.push(`回路 ${d} ${phase} ${p.name}: iverilog=${want} 自前=${got}`
            + ` (${IN.map((i, j) => `${i.name}=${rest[j]}`).join(' ')})\n${src}`);
        }
      });
    }
  }
  ok(designs === 8, 'ランダム回路: 8 個すべて iverilog が受け付けた', `通ったのは ${designs} 個`);
  ok(bad.length === 0, `ランダム回路 (${designs} 個 × 6 ベクタ × 2 点 = ${checked} 件)`, bad.join('\n---\n'));
}

// ------------------------------------------------------------------ 結果
console.log(`${passed} 件成功, ${failures.length} 件失敗`);
for (const f of failures) console.log(`  × ${f}`);
process.exit(failures.length ? 1 : 0);
