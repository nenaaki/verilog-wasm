#!/usr/bin/env node
// CLI: Verilog を WASM にコンパイルする / 波形を出す
//
//   node tools/vwc.js examples/lfsr8.v --wat
//   node tools/vwc.js examples/lfsr8.v -o lfsr8.wasm
//   node tools/vwc.js examples/shift8.v --run 8 --set din=1

import { readFileSync, writeFileSync } from 'node:fs';
import { compile, CompileError } from '../src/compile.js';
import { WasmSimulator } from '../src/sim.js';
import { bits } from '../src/signals.js';

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
  console.log(`使い方: node tools/vwc.js <file.v> [options]

  --wat            WAT テキストを表示
  --stats          統計のみ表示
  -o <file>        .wasm を書き出す
  --top <name>     トップモジュールを指定
  --run <n>        n クロック実行して波形を表示
  --set <sig>=<v>  入力 (または reg の初期値) を設定。複数指定可。値に x を混ぜた
                   ビット文字列も書ける (--xstate のとき。例: --set d=01x1)
  --xstate         x を値として扱う 4 値モード (未駆動と initial 無しのレジスタが x)
`);
  process.exit(argv.length === 0 ? 1 : 0);
}

const file = argv[0];
const flag = (n) => argv.includes(n);
const value = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const values = (n) => argv.map((a, i) => (a === n ? argv[i + 1] : null)).filter(Boolean);

try {
  const src = readFileSync(file, 'utf8');
  const compiled = compile(src, { top: value('--top'), xstate: flag('--xstate') });

  const s = compiled.stats;
  console.error(`${compiled.top}: nets=${s.nets} gates=${s.gates}`
    + (s.pruned ? `(+${s.pruned} 刈り取り)` : '')
    + ` regs=${s.regs} state=${s.stateBytes}B wasm=${s.wasmBytes}B`);
  for (const w of compiled.warnings) console.error(`warning: ${w}`);

  if (flag('--wat')) console.log(compiled.wat);

  const out = value('-o');
  if (out) {
    writeFileSync(out, compiled.bytes);
    console.error(`書き出し: ${out}`);
  }

  const cycles = value('--run');
  if (cycles !== undefined) {
    const sim = await WasmSimulator.create(compiled);
    for (const pair of values('--set')) {
      const [name, v] = pair.split('=');
      // x を混ぜたビット文字列はそのまま渡す (SignalAccess が振り分ける)
      sim.setInput(name, /[xX]/.test(v) ? v : BigInt(v));
    }

    sim.eval(); // 初期入力に対する組合せ出力を確定させる
    const cols = compiled.layout.signalTable.filter((t) => !t.isClock);
    const w = (t) => Math.max(t.name.length, t.width);
    console.log(['cyc'.padStart(4), ...cols.map((t) => t.name.padStart(w(t)))].join(' | '));
    console.log(['-'.repeat(4), ...cols.map((t) => '-'.repeat(w(t)))].join('-+-'));
    for (let i = 0; i <= Number(cycles); i++) {
      const row = cols.map((t) => sim.getBits(t.name).padStart(w(t)));
      console.log([String(i).padStart(4), ...row].join(' | '));
      if (i < Number(cycles)) sim.step();
    }
  }
} catch (e) {
  if (e instanceof CompileError) {
    console.error(`${file}: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
