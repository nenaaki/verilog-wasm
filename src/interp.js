// 参照実装: ネットリストをそのまま JS で評価する。
//
// WASM バックエンドと同じ API を持たせてあるので、両者を同じ入力で回して
// 出力を突き合わせる差分テストができる。コンパイラのバグは症状と原因が
// 離れた場所に出るため、この比較対象があるかどうかで開発効率が段違いになる。

import { SignalAccess, MASK64 } from './signals.js';

export class RefSimulator extends SignalAccess {
  constructor(compiled) {
    super(compiled.layout.signalTable);
    this.netlist = compiled.netlist;
    this.order = compiled.order;
    this.layout = compiled.layout;

    this.values = new Array(this.netlist.nets.length).fill(0n);
    // レジスタごとの次状態 (WASM 側の専用 next スロットに対応)
    this.next = new Array(this.netlist.regs.length).fill(0n);

    // オフセット → ネット ID の逆引き (SignalAccess はオフセットで話すため)
    this.netOfOffset = new Map();
    for (const [netId, off] of this.layout.slots) this.netOfOffset.set(off, netId);
  }

  readWord(offset) {
    return this.values[this.netOfOffset.get(offset)] & MASK64;
  }

  writeWord(offset, value) {
    this.values[this.netOfOffset.get(offset)] = BigInt(value) & MASK64;
  }

  reset() {
    this.values.fill(0n);
    this.next.fill(0n);
    return this;
  }

  /** 組合せ論理だけを評価する (クロックは打たない) */
  eval() {
    const { gates, regs } = this.netlist;
    const v = this.values;

    for (const gi of this.order) {
      const g = gates[gi];
      let r;
      switch (g.op) {
        case 'const': r = g.value ? MASK64 : 0n; break;
        case 'buf': r = v[g.in[0]]; break;
        case 'not': r = ~v[g.in[0]] & MASK64; break;
        case 'and': r = g.in.reduce((a, n) => a & v[n], MASK64); break;
        case 'or': r = g.in.reduce((a, n) => a | v[n], 0n); break;
        case 'xor': r = g.in.reduce((a, n, i) => (i === 0 ? v[n] : a ^ v[n]), 0n); break;
        case 'mux': {
          const [sel, a, b] = g.in;
          r = (v[a] & v[sel]) | (v[b] & (~v[sel] & MASK64));
          break;
        }
        default: throw new Error(`interp: 未知のゲート op '${g.op}'`);
      }
      v[g.out] = r & MASK64;
    }

    // 次状態は専用の場所に置き、Q はまだ変えない (同時代入)
    regs.forEach((rg, i) => { this.next[i] = v[rg.d]; });

    // 非同期リセットだけは Q をここで上書きする (クロックを待たない)。
    // 次状態を取り終えたあとに書くので、WASM 側 (local を先に読む) と同じ順になる。
    for (const rg of regs) {
      if (rg.qAsync != null && rg.qAsync !== rg.q) v[rg.q] = v[rg.qAsync];
    }
    return this;
  }

  /** クロックエッジ: 次状態を Q に一括転送する */
  commit() {
    const { regs } = this.netlist;
    regs.forEach((rg, i) => { this.values[rg.q] = this.next[i]; });
    return this;
  }

  /** 1 クロック。終了時に組合せ出力は確定済み (codegen.js の step と同じ) */
  step() {
    return this.eval().commit().eval();
  }

  run(n) {
    this.eval();
    for (let i = 0; i < n; i++) this.commit().eval();
    return this;
  }
}
