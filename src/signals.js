// シミュレータ共通の信号アクセス層。
//
// 1 ネット = 1 個の i64 = 64 レーン。1 レーンが 1 個の独立したテストベクタ。
// 素朴に使う場合は setInput() が全 64 レーンに同じ値をブロードキャストするので、
// レーンの存在を意識せずに普通のシミュレータとして扱える。

export const LANES = 64;
export const MASK64 = (1n << 64n) - 1n;
const ALL_ONES = MASK64;

export class SignalAccess {
  constructor(signalTable, xstate = false, clocks = []) {
    this.signalTable = signalTable;
    this.xstate = xstate;
    /** クロックドメインの名前。posedge はクロック信号名、negedge は `~clk` */
    this.clocks = clocks;
    this.byName = new Map(signalTable.map((s) => [s.name, s]));
  }

  /**
   * `step()` / `commit()` / `run()` に渡すクロックの解決。
   *
   * **ドメインが 1 つなら名前は要らない**（これまでの `step()` がそのまま動く）。
   * 2 つ以上あるときは、どれを叩くのか処理系の側では決めようがないので指定を求める
   * ―― 時間を持たないモデルなので「どちらのエッジが先か」という答えが無い。
   */
  clockIndex(clock) {
    if (clock === undefined || clock === null) {
      if (this.clocks.length <= 1) return 0;
      throw new Error(`クロックが ${this.clocks.length} 本あるので、どれを叩くか指定してください`
        + ` (${this.clocks.join(' / ')})`);
    }
    if (typeof clock === 'number') {
      if (clock >= 0 && clock < this.clocks.length) return clock;
      throw new Error(`クロック番号 ${clock} は範囲外 (0〜${this.clocks.length - 1})`);
    }
    const i = this.clocks.indexOf(clock);
    if (i < 0) throw new Error(`クロック '${clock}' は無い (${this.clocks.join(' / ') || 'クロック無し'})`);
    return i;
  }

  /**
   * 不定の面のオフセット。4 値のときは値の面の 8 バイト後ろに置いてある
   * (src/fourstate.js の符号化)。2 値なら不定の面そのものが無い。
   */
  _xOffset(off) { return this.xstate ? off + 8 : null; }

  /** @returns {bigint} 64 ビット符号なし */
  readWord(_offset) { throw new Error('未実装'); }
  writeWord(_offset, _value) { throw new Error('未実装'); }

  _sig(name) {
    const s = this.byName.get(name);
    if (!s) throw new Error(`信号 '${name}' は存在しない (観測可能: ${[...this.byName.keys()].join(', ')})`);
    return s;
  }

  /**
   * 全 64 レーンに同じ値を書く。
   *
   * **文字列は MSB 先頭のビット列**（`"0110"` / `"01x0"`）、数値と BigInt はそのままの値。
   * 10 進で渡したいときは数値を使う ―― 文字列かどうかで進数が変わるほうが、
   * 「x が入っているかどうか」で変わるより間違えにくい。
   */
  setInput(name, value) {
    const s = this._sig(name);
    if (typeof value === 'string') return this._setBitString(s, value);
    const v = BigInt(value);
    s.offsets.forEach((off, b) => {
      if (off === null) return;
      this.writeWord(off, (v >> BigInt(b)) & 1n ? ALL_ONES : 0n);
      if (this.xstate) this.writeWord(off + 8, 0n);
    });
    return this;
  }

  /** `"0110"` / `"01x0"` のような MSB 先頭のビット文字列を書く */
  _setBitString(s, text) {
    const clean = text.trim().replace(/_/g, '');
    if (!/^[01xX]*$/.test(clean)) {
      throw new Error(`入力のビット列に使えるのは 0 / 1 / x だけ ('${text}')。`
        + '10 進で渡すなら数値か BigInt を使う');
    }
    if (!this.xstate && /x/i.test(clean)) {
      throw new Error(`x を入力に書けるのは 4 値 (xstate) のときだけ ('${text}')`);
    }
    const chars = [...clean].reverse();                // LSB 先頭に並べ替える
    s.offsets.forEach((off, b) => {
      if (off === null) return;
      const c = chars[b] ?? '0';
      const isX = c === 'x' || c === 'X';
      this.writeWord(off, c === '1' ? ALL_ONES : 0n);
      if (this.xstate) this.writeWord(off + 8, isX ? ALL_ONES : 0n);
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
      // 4 値では「そのレーンだけ確実な値にする」ので、不定の面はこのレーンだけ落とす
      if (this.xstate) this.writeWord(off + 8, this.readWord(off + 8) & (MASK64 ^ bit));
    });
    return this;
  }

  /**
   * @returns {bigint} 指定レーンの信号値。**x のビットは 0 として読める**
   * (どのビットが x かは getX / getBits で見る)
   */
  get(name, lane = 0) {
    const s = this._sig(name);
    const sh = BigInt(lane);
    const xs = this.xstate;
    let out = 0n;
    s.offsets.forEach((off, b) => {
      if (off === null) return;
      const v = (this.readWord(off) >> sh) & 1n;
      const u = xs ? (this.readWord(off + 8) >> sh) & 1n : 0n;
      out |= (v & ~u & 1n) << BigInt(b);
    });
    return out;
  }

  /** @returns {bigint} x になっているビットに 1 が立ったマスク (2 値なら常に 0) */
  getX(name, lane = 0) {
    const s = this._sig(name);
    if (!this.xstate) return 0n;
    const sh = BigInt(lane);
    let out = 0n;
    s.offsets.forEach((off, b) => {
      if (off === null) return;
      out |= ((this.readWord(off + 8) >> sh) & 1n) << BigInt(b);
    });
    return out;
  }

  /** @returns {string} `"01x0"` のような MSB 先頭のビット文字列 */
  getBits(name, lane = 0) {
    const s = this._sig(name);
    const v = this.get(name, lane);
    const u = this.getX(name, lane);
    let out = '';
    for (let b = s.width - 1; b >= 0; b--) {
      const i = BigInt(b);
      out += (u >> i) & 1n ? 'x' : String((v >> i) & 1n);
    }
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
