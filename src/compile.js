// パイプライン一式のエントリポイント。
//
//   Verilog ソース
//     → lex/parse   (AST)
//     → elaborate   (ネットリスト IR / bit-blast)
//     → schedule    (トポロジカルソート・組合せループ検出)
//     → buildLayout (線形メモリのスロット割り当て)
//     → emitWasm    (バイナリ)  / emitWat (デバッグ用テキスト)

import { parse } from './parser.js';
import { elaborate } from './elaborate.js';
import { schedule } from './schedule.js';
import { buildLayout } from './layout.js';
import { emitWasm } from './codegen.js';
import { emitWat } from './wat.js';
import { CompileError } from './errors.js';

export { CompileError };
export { WasmSimulator } from './sim.js';
export { RefSimulator } from './interp.js';
export { bits, LANES } from './signals.js';

/**
 * @param {string} src Verilog サブセットのソース
 * @param {{ top?: string, wat?: boolean }} [opts]
 */
export function compile(src, opts = {}) {
  const modules = parse(src);

  let mod;
  if (opts.top) {
    mod = modules.find((m) => m.name === opts.top);
    if (!mod) throw new CompileError(`module '${opts.top}' が見つからない`);
  } else {
    mod = modules[0];
    if (modules.length > 1) {
      // 階層は未対応なので、複数あるときは先頭を top として扱う旨を伝える
      mod.note = `${modules.length} 個の module が見つかったため先頭 '${mod.name}' を top として扱いました`;
    }
  }

  const netlist = elaborate(mod);
  const order = schedule(netlist);
  const layout = buildLayout(netlist);
  const bytes = emitWasm(netlist, order, layout);

  const result = {
    top: mod.name,
    netlist,
    order,
    layout,
    bytes,
    stats: {
      nets: netlist.nets.length,
      // gates は「生成コードに乗ったゲート数」= 刈り取り後。作ったけれど出力にも
      // レジスタにも届かなかったぶんは pruned に出す (schedule.js 参照)
      gates: order.length,
      pruned: netlist.gates.length - order.length,
      regs: netlist.regs.length,
      stateBytes: layout.byteSize,
      wasmBytes: bytes.length,
    },
    warnings: [...netlist.warnings, ...(mod.note ? [mod.note] : [])],
  };

  if (opts.wat !== false) result.wat = emitWat(netlist, order, layout);
  return result;
}

/** compile + instantiate をまとめたショートカット */
export async function build(src, opts) {
  const { WasmSimulator } = await import('./sim.js');
  const compiled = compile(src, opts);
  const sim = await WasmSimulator.create(compiled);
  return { compiled, sim };
}
