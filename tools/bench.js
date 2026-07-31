// スループット計測: 中規模設計 (32bit LFSR × 8 = 256 レジスタ) で
// WASM バックエンドと JS 参照実装を比較する。
//
//   node tools/bench.js

import { compile } from '../src/compile.js';
import { WasmSimulator } from '../src/sim.js';
import { RefSimulator } from '../src/interp.js';

let body = '';
const parts = [];
for (let k = 0; k < 8; k++) {
  body += `  reg [31:0] q${k};\n  wire fb${k};\n`;
  body += `  assign fb${k} = q${k}[31] ^ q${k}[21] ^ q${k}[1] ^ q${k}[0] ^ 1'b1;\n`;
  body += `  always @(posedge clk) q${k} <= {q${k}[30:0], fb${k}};\n`;
  parts.push(`q${k}`);
}
const src = `module big(input clk, output [31:0] y);\n${body}  assign y = ${parts.join(' ^ ')};\nendmodule`;

const compiled = compile(src);
console.log(`設計: gates=${compiled.stats.gates} regs=${compiled.stats.regs} `
  + `state=${compiled.stats.stateBytes}B wasm=${compiled.stats.wasmBytes}B`);

const wasm = await WasmSimulator.create(compiled);
const ref = new RefSimulator(compiled);

wasm.reset();
ref.reset();
let same = true;
for (let i = 0; i < 200; i++) {
  wasm.step();
  ref.step();
  if (wasm.get('y') !== ref.get('y')) { same = false; break; }
}
console.log(`WASM と参照実装の一致: ${same}`);

const N = 200_000;
const REF_N = 2_000;

wasm.reset().run(1000); // ウォームアップ
let t = process.hrtime.bigint();
wasm.run(N);
const wasmMs = Number(process.hrtime.bigint() - t) / 1e6;

ref.reset();
t = process.hrtime.bigint();
ref.run(REF_N);
const refMs = (Number(process.hrtime.bigint() - t) / 1e6) * (N / REF_N);

const gateEvals = N * compiled.stats.gates;
console.log(`WASM  : ${wasmMs.toFixed(0)} ms / ${N.toLocaleString()} クロック = ${(N / wasmMs).toFixed(0)} kclk/s`);
console.log(`        ${(gateEvals / wasmMs / 1e3).toFixed(1)} M gate-eval/s (1 レーン換算)`);
console.log(`        ${(gateEvals * 64 / wasmMs / 1e6).toFixed(2)} G gate-eval/s (64 レーン同時換算)`);
console.log(`参照JS : ${refMs.toFixed(0)} ms 相当 → WASM は約 ${(refMs / wasmMs).toFixed(0)} 倍速`);
