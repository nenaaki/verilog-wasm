// 参照実装: ネットリストをそのまま JS で評価する。
//
// WASM バックエンドと同じ API を持たせてあるので、両者を同じ入力で回して
// 出力を突き合わせる差分テストができる。コンパイラのバグは症状と原因が
// 離れた場所に出るため、この比較対象があるかどうかで開発効率が段違いになる。

import { SignalAccess, MASK64 } from './signals.js';
import { evalGate } from './fourstate.js';

export class RefSimulator extends SignalAccess {
  constructor(compiled) {
    super(compiled.layout.signalTable, !!compiled.layout.xstate, compiled.layout.clocks ?? [],
      !!compiled.layout.zstate);
    this.netlist = compiled.netlist;
    this.order = compiled.order;
    this.layout = compiled.layout;

    this.values = new Array(this.netlist.nets.length).fill(0n);
    // 4 値のときの「不定の面」。2 値では触らない (src/fourstate.js の符号化)
    this.unknown = new Array(this.netlist.nets.length).fill(0n);
    // 高インピーダンスの面。トライステートを含む回路だけが使う
    this.hiz = new Array(this.netlist.nets.length).fill(0n);
    // レジスタごとの次状態 (WASM 側の専用 next スロットに対応)
    this.next = new Array(this.netlist.regs.length).fill(0n);
    this.nextX = new Array(this.netlist.regs.length).fill(0n);
    this.nextZ = new Array(this.netlist.regs.length).fill(0n);

    // オフセット → ネット ID の逆引き (SignalAccess はオフセットで話すため)。
    // 4 値では 8 バイト後ろが不定の面、その 8 バイト後ろが z の面
    this.netOfOffset = new Map();
    this.xOfOffset = new Map();
    this.zOfOffset = new Map();
    for (const [netId, off] of this.layout.slots) {
      this.netOfOffset.set(off, netId);
      if (this.xstate) this.xOfOffset.set(off + 8, netId);
      if (this.zstate) this.zOfOffset.set(off + 16, netId);
    }

    // WASM 側はデータセグメントで初期状態が入るので、こちらも同じ所から始める
    this.reset();
  }

  readWord(offset) {
    if (this.zOfOffset.has(offset)) return this.hiz[this.zOfOffset.get(offset)] & MASK64;
    if (this.xOfOffset.has(offset)) return this.unknown[this.xOfOffset.get(offset)] & MASK64;
    return this.values[this.netOfOffset.get(offset)] & MASK64;
  }

  writeWord(offset, value) {
    const v = BigInt(value) & MASK64;
    if (this.zOfOffset.has(offset)) this.hiz[this.zOfOffset.get(offset)] = v;
    else if (this.xOfOffset.has(offset)) this.unknown[this.xOfOffset.get(offset)] = v;
    else this.values[this.netOfOffset.get(offset)] = v;
  }

  /** 全状態を電源投入時に戻す (initial を書いていなければゼロクリア) */
  reset() {
    this.values.fill(0n);
    this.unknown.fill(0n);
    this.hiz.fill(0n);
    this.next.fill(0n);
    this.nextX.fill(0n);
    this.nextZ.fill(0n);
    for (const [off, v] of this.layout.initWords) this.writeWord(off, v);
    return this;
  }

  /** 組合せ論理だけを評価する (クロックは打たない) */
  eval() {
    return this.xstate ? this._eval4() : this._eval2();
  }

  /**
   * 4 値の評価。式は src/fourstate.js に 1 箇所だけ書いてあり、WASM 側も
   * 同じものをなぞる。**2 つが食い違っていないことはランダム差分テストが見る。**
   */
  _eval4() {
    const { gates, regs } = this.netlist;
    const v = this.values;
    const u = this.unknown;
    const z = this.hiz;
    const planeOf = (n) => ({ v: v[n], u: u[n], z: z[n] });

    for (const gi of this.order) {
      const g = gates[gi];
      const r = evalGate(g.op, g.in.map(planeOf), g.value);
      v[g.out] = r.v & MASK64;
      u[g.out] = r.u & MASK64;
      z[g.out] = r.z & MASK64;
    }

    regs.forEach((rg, i) => {
      this.next[i] = v[rg.d];
      this.nextX[i] = u[rg.d];
      this.nextZ[i] = z[rg.d];
    });
    for (const rg of regs) {
      if (rg.qAsync != null && rg.qAsync !== rg.q) {
        v[rg.q] = v[rg.qAsync]; u[rg.q] = u[rg.qAsync]; z[rg.q] = z[rg.qAsync];
      }
    }
    return this;
  }

  _eval2() {
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

  /**
   * クロックエッジ: そのドメインの次状態を Q に一括転送する。
   * **叩くのは 1 ドメインだけ** ―― 別のクロックのレジスタは動かない。
   */
  commit(clock) {
    const d = this.clockIndex(clock);
    const { regs } = this.netlist;
    regs.forEach((rg, i) => {
      if (rg.domain !== d) return;
      this.values[rg.q] = this.next[i];
      if (this.xstate) this.unknown[rg.q] = this.nextX[i];
      if (this.zstate) this.hiz[rg.q] = this.nextZ[i];
    });
    return this;
  }

  /** 1 クロック。終了時に組合せ出力は確定済み (codegen.js の step と同じ) */
  step(clock) {
    return this.eval().commit(clock).eval();
  }

  run(n, clock) {
    this.eval();
    for (let i = 0; i < n; i++) this.commit(clock).eval();
    return this;
  }
}
