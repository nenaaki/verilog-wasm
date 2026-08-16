// 生成した WASM モジュールを動かすシミュレータ。ブラウザ / Node 共通。

import { SignalAccess, MASK64 } from './signals.js';

export class WasmSimulator extends SignalAccess {
  constructor(compiled, instance) {
    super(compiled.layout.signalTable, !!compiled.layout.xstate, compiled.layout.clocks ?? []);
    this.compiled = compiled;
    this.instance = instance;
    this.exports = instance.exports;
    this.mem = new BigInt64Array(this.exports.memory.buffer);
  }

  static async create(compiled) {
    const { instance } = await WebAssembly.instantiate(compiled.bytes, {});
    return new WasmSimulator(compiled, instance);
  }

  readWord(offset) {
    return BigInt.asUintN(64, this.mem[offset >> 3]);
  }

  writeWord(offset, value) {
    this.mem[offset >> 3] = BigInt.asIntN(64, BigInt(value) & MASK64);
  }

  /** 全状態を電源投入時に戻す (initial を書いていなければゼロクリア) */
  reset() {
    this.mem.fill(0n, 0, this.compiled.layout.byteSize >> 3);
    for (const [off, v] of this.compiled.layout.initWords) this.writeWord(off, v);
    return this;
  }

  /** 組合せ論理だけを評価する (クロックは打たない) */
  eval() {
    this.exports.eval();
    return this;
  }

  /** クロックエッジ: そのドメインの次状態を Q に一括転送する */
  commit(clock) {
    this.exports.commit(this.clockIndex(clock));
    return this;
  }

  step(clock) {
    this.exports.step(this.clockIndex(clock));
    return this;
  }

  run(n, clock) {
    this.exports.run(this.clockIndex(clock), n);
    return this;
  }
}
