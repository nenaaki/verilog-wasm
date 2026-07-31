// シミュレータ共通の信号アクセス層。
//
// 1 ネット = 1 個の i64 = 64 レーン。1 レーンが 1 個の独立したテストベクタ。
// 素朴に使う場合は setInput() が全 64 レーンに同じ値をブロードキャストするので、
// レーンの存在を意識せずに普通のシミュレータとして扱える。

export const LANES = 64;
export const MASK64 = (1n << 64n) - 1n;
const ALL_ONES = MASK64;

export class SignalAccess {
  constructor(signalTable) {
    this.signalTable = signalTable;
    this.byName = new Map(signalTable.map((s) => [s.name, s]));
  }

  /** @returns {bigint} 64 ビット符号なし */
  readWord(_offset) { throw new Error('未実装'); }
  writeWord(_offset, _value) { throw new Error('未実装'); }

  _sig(name) {
    const s = this.byName.get(name);
    if (!s) throw new Error(`信号 '${name}' は存在しない (観測可能: ${[...this.byName.keys()].join(', ')})`);
    return s;
  }

  /** 全 64 レーンに同じ値を書く */
  setInput(name, value) {
    const s = this._sig(name);
    const v = BigInt(value);
    s.offsets.forEach((off, b) => {
      if (off === null) return;
      this.writeWord(off, (v >> BigInt(b)) & 1n ? ALL_ONES : 0n);
    });
    return this;
  }

  /** 特定レーンだけ書き換える (並列スイープ用) */
  setInputLane(name, lane, value) {
    const s = this._sig(name);
    const v = BigInt(value);
    const bit = 1n << BigInt(lane);
    s.offsets.forEach((off, b) => {
      if (off === null) return;
      const cur = this.readWord(off);
      const on = ((v >> BigInt(b)) & 1n) === 1n;
      this.writeWord(off, (on ? cur | bit : cur & (MASK64 ^ bit)) & MASK64);
    });
    return this;
  }

  /** @returns {bigint} 指定レーンの信号値 */
  get(name, lane = 0) {
    const s = this._sig(name);
    const sh = BigInt(lane);
    let out = 0n;
    s.offsets.forEach((off, b) => {
      if (off === null) return;
      out |= ((this.readWord(off) >> sh) & 1n) << BigInt(b);
    });
    return out;
  }

  /** @returns {bigint[]} 64 レーン分の信号値 */
  getLanes(name) {
    return Array.from({ length: LANES }, (_, l) => this.get(name, l));
  }

  /** 観測可能な全信号のレーン 0 の値 */
  snapshot(lane = 0) {
    const out = {};
    for (const s of this.signalTable) out[s.name] = this.get(s.name, lane);
    return out;
  }
}

/** ポートの値を "0011" のようなビット文字列にする (デバッグ表示用) */
export function bits(value, width) {
  return BigInt(value).toString(2).padStart(width, '0').slice(-width);
}
