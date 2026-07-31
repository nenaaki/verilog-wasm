// 線形メモリ上のレイアウト。
//
// 1 ネット = 1 個の i64 スロット (8 バイト)。i64 の 64 ビットは
// 「64 個の独立したテストベクタのレーン」として使う (ビットスライス方式)。
// これにより 64 パターンを 1 回の step() で同時にシミュレートできる。
//
// スロットを持つのは永続状態と観測対象だけ:
//   - 入力ポートのビット   (ホストが書く)
//   - 出力ポートのビット   (ホストが読む)
//   - レジスタの Q        (クロック間で保持される状態)
//   - レジスタの次状態     (eval → commit の受け渡し用。レジスタごとに専用)
// 内部の組合せ配線は WASM の local に置き、メモリを経由しない。
//
// 次状態スロットを「D ネットごと」ではなく「レジスタごとに専用」で確保するのが重要。
// D ネットが他のレジスタの Q ネットと同一になる場合 (`a <= b; b <= a;` のスワップ) に
// スロットを共有すると、commit が逐次代入になって値が壊れる。

export function buildLayout(netlist) {
  const { signals, regs } = netlist;
  const slots = new Map();
  let offset = 0;

  const assign = (netId) => {
    if (!slots.has(netId)) {
      slots.set(netId, offset);
      offset += 8;
    }
  };

  const ports = [];
  for (const s of signals.values()) {
    if (s.dir === 'input' || s.dir === 'output') {
      s.bits.forEach(assign);
      ports.push(s);
    }
  }
  for (const r of regs) assign(r.q);

  // レジスタごとの専用 next スロット (エイリアスさせない)
  const regNext = regs.map(() => {
    const off = offset;
    offset += 8;
    return off;
  });

  // 出力ポートのうちレジスタ Q でもあるネットは、レジスタ側の書き戻しに任せる
  const regQ = new Set(regs.map((r) => r.q));
  const outputNets = [];
  for (const s of signals.values()) {
    if (s.dir !== 'output') continue;
    for (const n of s.bits) if (!regQ.has(n)) outputNets.push(n);
  }

  const inputNets = [];
  for (const s of signals.values()) {
    if (s.dir === 'input') inputNets.push(...s.bits);
  }

  return {
    slots,
    regNext,
    byteSize: offset,
    pages: Math.max(1, Math.ceil(offset / 65536)),
    inputNets,
    outputNets,
    regQ,
    /** 外部に見せる信号表 */
    signalTable: [...signals.values()]
      .filter((s) => s.dir === 'input' || s.dir === 'output' || s.kind === 'reg')
      .map((s) => ({
        name: s.name,
        dir: s.dir ?? 'internal',
        kind: s.kind,
        msb: s.msb,
        lsb: s.lsb,
        width: s.width,
        isClock: !!s.isClock,
        offsets: s.bits.map((n) => slots.get(n) ?? null),
      })),
  };
}
