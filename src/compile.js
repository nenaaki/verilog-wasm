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
 * @param {{ top?: string, wat?: boolean, xstate?: boolean }} [opts]
 *   xstate: x を値として扱う 4 値モード。既定は 2 値 (README「x を値として扱う」)
 */
export function compile(src, opts = {}) {
  const modules = parse(src);

  let mod;
  if (opts.top) {
    mod = modules.find((m) => m.name === opts.top);
    if (!mod) throw new CompileError(`module '${opts.top}' が見つからない`);
  } else {
    // 誰にもインスタンス化されていない module を top とみなす。これで
    // 「部品を先に、top を後に」書いたファイルでも --top なしで通る。
    const used = new Set();
    for (const m of modules) {
      for (const item of m.items) if (item.type === 'inst') used.add(item.module);
    }
    const roots = modules.filter((m) => !used.has(m.name));
    mod = roots[0] ?? modules[0];
    if (roots.length > 1) {
      mod.note = `top になりうる module が ${roots.length} 個あるため先頭の '${mod.name}' を選びました`
        + ` (--top で指定できます)`;
    }
  }

  const netlist = elaborate(mod, modules, { xstate: opts.xstate });
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
