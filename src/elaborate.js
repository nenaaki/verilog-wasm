// AST → ネットリスト IR
//
// すべての信号を 1 ビット単位のネットに展開する (bit-blast)。
// 以降の工程 (スケジューリング / コード生成) はビット幅を一切意識しない。
//
// ネットリスト IR:
//   nets   : [{ name }]                      … 1 ネット = 1 ビット
//   gates  : [{ op, out, in:[netId], value }] … op: const|buf|not|and|or|xor|mux
//   regs   : [{ q, d, line }]                 … posedge clk の D フリップフロップ
//   signals: Map<name, { dir, kind, msb, lsb, width, bits:[netId] }>
//
// 幅の解決は Verilog の文脈依存幅に従う。2 段階に分かれていて、
// selfWidth() が 1 段目 (下から自己決定幅を求める)、evalExpr(e, ctx) が 2 段目
// (上から文脈幅を配り、文脈依存の演算子は max(自己決定幅, 文脈幅) で計算する)。
// 詳しくは selfWidth() の上のコメントと README「幅の規則」を参照。
//
// Verilog と違うのはサイズ無し整数リテラルの幅だけ。LRM は 32 ビットだが、
// ここでは値が収まる最小幅にしている (32 ビットにすると q + 1 が 32 ビット
// 加算器になり、定数畳み込みも刈り取りも無いので死んだ論理がそのまま残る)。

import { CompileError } from './errors.js';
import { GATE_PRIMITIVES } from './parser.js';

export function elaborate(mod) {
  const nets = [];
  const gates = [];
  const regs = [];
  const signals = new Map();
  const drivers = new Map(); // netId -> 駆動元の説明 (多重ドライブ検出用)

  const newNet = (name) => {
    nets.push({ name });
    return nets.length - 1;
  };

  const CONST0 = newNet('$const0');
  const CONST1 = newNet('$const1');
  gates.push({ op: 'const', value: 0, out: CONST0, in: [] });
  gates.push({ op: 'const', value: 1, out: CONST1, in: [] });
  drivers.set(CONST0, '定数');
  drivers.set(CONST1, '定数');

  const setDriver = (netId, what, line) => {
    const prev = drivers.get(netId);
    if (prev) {
      throw new CompileError(`${nets[netId].name} が多重にドライブされている (${prev} と ${what})`, line);
    }
    drivers.set(netId, what);
  };

  const newGate = (op, ins, tag) => {
    const out = newNet(`$${op}${gates.length}${tag ? `_${tag}` : ''}`);
    gates.push({ op, out, in: ins });
    drivers.set(out, 'ゲート');
    return out;
  };

  // ---- 宣言 --------------------------------------------------------------
  function declare(name, { dir, kind, range }, line) {
    let s = signals.get(name);
    if (!s) {
      const msb = range ? range.msb : 0;
      const lsb = range ? range.lsb : 0;
      if (msb < lsb) throw new CompileError(`降順ビット範囲 [${msb}:${lsb}] は未対応`, line);
      const width = msb - lsb + 1;
      const bits = [];
      for (let b = 0; b < width; b++) {
        bits.push(newNet(width > 1 ? `${name}[${b + lsb}]` : name));
      }
      s = { name, dir: dir ?? null, kind: kind ?? 'wire', msb, lsb, width, bits };
      signals.set(name, s);
    } else {
      if (range && (range.msb !== s.msb || range.lsb !== s.lsb)) {
        throw new CompileError(`${name} のビット範囲が宣言間で矛盾している`, line);
      }
      if (dir) s.dir = dir;
      if (kind) s.kind = kind;
    }
    return s;
  }

  const lookup = (name, line) => {
    const s = signals.get(name);
    if (!s) throw new CompileError(`未宣言の信号 '${name}'`, line);
    return s;
  };

  // 先に全宣言を処理して、前方参照 (assign が後続の wire 宣言を参照する等) を許す
  for (const item of mod.items) {
    if (item.type === 'decl') {
      for (const n of item.names) declare(n, item, item.line);
    }
  }
  for (const pname of mod.portOrder) {
    if (!signals.has(pname)) {
      throw new CompileError(`ポート '${pname}' の方向が宣言されていない`, mod.line);
    }
  }
  // input のネットは外部から与えられるので「駆動済み」とみなす
  for (const s of signals.values()) {
    if (s.dir === 'input') s.bits.forEach((n) => drivers.set(n, '入力ポート'));
  }

  // ---- 式の評価 (→ LSB 先頭のネット配列) ------------------------------------
  function resize(bits, width) {
    if (bits.length === width) return bits;
    if (bits.length > width) return bits.slice(0, width);
    return [...bits, ...Array(width - bits.length).fill(CONST0)];
  }

  function refBits(node) {
    const s = lookup(node.name, node.line);
    if (!node.range) return s.bits;
    const { msb, lsb } = node.range;
    if (msb < lsb) throw new CompileError(`降順の部分選択 [${msb}:${lsb}] は未対応`, node.line);
    const out = [];
    for (let i = lsb; i <= msb; i++) {
      const pos = i - s.lsb;
      if (pos < 0 || pos >= s.width) {
        throw new CompileError(`${s.name}[${i}] は宣言範囲 [${s.msb}:${s.lsb}] の外`, node.line);
      }
      out.push(s.bits[pos]);
    }
    return out;
  }

  /**
   * 桁上げ伝播加算器。a と b は同じ長さの LSB 先頭のネット配列。
   * 全加算器 1 段は sum = a^b^cin / cout = (a&b) | (cin & (a^b))。
   * 最上位段の桁上げ出力は作らない (使わないゲートを残すと、そのまま
   * コード生成まで運ばれてしまう。schedule に未使用ゲートの刈り取りはない)。
   */
  function addBits(a, b, cin) {
    let carry = cin;
    const out = [];
    for (let i = 0; i < a.length; i++) {
      const axb = newGate('xor', [a[i], b[i]]);
      out.push(newGate('xor', [axb, carry]));
      if (i + 1 < a.length) {
        carry = newGate('or', [newGate('and', [a[i], b[i]]), newGate('and', [carry, axb])]);
      }
    }
    return out;
  }

  /**
   * a + b / a - b。両辺は呼び出し側で実効幅に揃えてある (文脈依存幅を配った結果)。
   * その幅で計算して桁上げ出力は捨てる — これが Verilog の意味論そのもので、
   * 桁上げを残したければ代入先を 1 ビット広くする、という形になる。
   * 減算は b を反転して桁上げ入力 1、つまり 2 の補数で足す。
   */
  function addSub(a, b, op) {
    const bb = op === '+' ? b : b.map((n) => newGate('not', [n]));
    return addBits(a, bb, op === '+' ? CONST0 : CONST1);
  }

  /**
   * a == b / a != b。差分ビットを OR リダクションして 1 ビットにする。
   * XNOR の AND リダクションでも同じだが、こちらは基本ゲートだけで済む。
   */
  function equalBits(a, b, op) {
    const w = Math.max(a.length, b.length);
    const aa = resize(a, w);
    const bb = resize(b, w);
    let diff = newGate('xor', [aa[0], bb[0]]);
    for (let i = 1; i < w; i++) diff = newGate('or', [diff, newGate('xor', [aa[i], bb[i]])]);
    return op === '==' ? [newGate('not', [diff])] : [diff];
  }

  /**
   * a - b の桁上げ出力だけを作る。1 なら a >= b、0 なら a < b (符号なし)。
   * 和は使わないので作らない。減算なので b を反転し、桁上げ入力は 1。
   * 最下段は桁上げ入力が定数 1 に決まっているので (a&b)|(1&(a^b)) = a|b に縮む。
   */
  function geCarry(a, b) {
    const w = Math.max(a.length, b.length);
    const aa = resize(a, w);
    const nb = resize(b, w).map((n) => newGate('not', [n]));
    let carry = newGate('or', [aa[0], nb[0]]);
    for (let i = 1; i < w; i++) {
      const axb = newGate('xor', [aa[i], nb[i]]);
      carry = newGate('or', [newGate('and', [aa[i], nb[i]]), newGate('and', [carry, axb])]);
    }
    return carry;
  }

  // a >= b が桁上げ出力そのもの。残り 3 つは辺の入れ替えと反転で作る。
  const CMP = {
    '>=': { swap: false, invert: false },
    '<': { swap: false, invert: true },    // ~(a >= b)
    '<=': { swap: true, invert: false },   // b >= a
    '>': { swap: true, invert: true },     // ~(b >= a)
  };

  /** 関係演算子。結果は Verilog と同じく 1 ビット */
  function compareBits(a, b, op) {
    const { swap, invert } = CMP[op];
    const ge = swap ? geCarry(b, a) : geCarry(a, b);
    return invert ? [newGate('not', [ge])] : [ge];
  }

  /**
   * 幅を変えずに sh ビットずらす。ネットを並べ替えるだけでゲートは 1 個も増えない
   * (空いた所には CONST0 のネット ID をそのまま並べる)。
   *
   * 結果の幅を左オペランドのままにするのは Verilog のシフトの自己決定幅と同じ。
   * 広げてしまうと、比較のオペランドになったときに押し出されたビットが生き残って
   * 結果が変わる (4 ビットの 8 << 1 は Verilog では 0、広げると 16)。
   * 代入先の幅は見ないので、左辺が広いと押し出されたビットは戻ってこない。
   * これは + / - と同じ割り切り (README の「幅の規則」にまとめてある)。
   * 幅を増やしたいときは連接を使う: {hi, 4'h0} は hi << 4 と違って幅が曖昧にならない。
   */
  function shiftFixed(bits, sh, op) {
    const w = bits.length;
    if (sh >= w) return Array(w).fill(CONST0);   // 全部押し出される (巨大なリテラル対策も兼ねる)
    if (op === '>>') return resize(bits.slice(sh), w);
    return [...Array(sh).fill(CONST0), ...bits.slice(0, w - sh)];
  }

  /**
   * シフト量が信号のときのシフト (バレルシフタ)。シフト量の各ビットについて
   * 「2^j ずらすかどうか」を mux で選ぶ log 段構成。
   *
   * 2^j が幅以上になるビットは、立っていたら結果が全 0 になるだけなので、段を
   * 積まずにまとめて 1 段のマスクにする。
   */
  function barrelShift(a, amt, op) {
    const w = a.length;
    let cur = a;
    const overflow = [];

    for (let j = 0; j < amt.length; j++) {
      const sh = 2 ** j;
      if (sh >= w) { overflow.push(amt[j]); continue; }
      const shifted = shiftFixed(cur, sh, op);
      cur = cur.map((n, i) => newGate('mux', [amt[j], shifted[i], n]));
    }

    if (overflow.length > 0) {
      let big = overflow[0];
      for (let k = 1; k < overflow.length; k++) big = newGate('or', [big, overflow[k]]);
      cur = cur.map((n) => newGate('mux', [big, CONST0, n]));
    }
    return cur;
  }

  function reduceOr(bits, line) {
    if (bits.length === 0) return CONST0;
    let acc = bits[0];
    for (let i = 1; i < bits.length; i++) acc = newGate('or', [acc, bits[i]]);
    return acc;
  }

  // ---- 自己決定幅 (文脈依存幅の 1 段目) --------------------------------------
  //
  // Verilog は式の幅を 2 段階で決める:
  //   1. 下から「自己決定幅」を求める            … ここ
  //   2. 上から文脈幅を配り、文脈依存の演算子は max(自己決定幅, 文脈幅) で計算する
  //
  // 演算子は「文脈を受け取るもの」と「受け取らないもの」に分かれる:
  //   受け取る … ~ & | ^ + - (単項も)、?: の値側、シフトの左オペランド
  //   受け取らない … 比較・論理演算 (結果 1 ビット)、連接、ビット選択、
  //                  シフト量、?: の条件
  //
  // ゲートは作らないので、同じノードを何度尋ねても副作用は無い。ノードごとに
  // 結果をキャッシュして、深い式で何度も辿らないようにしてある。
  const selfWidthCache = new Map();

  function selfWidth(e) {
    const hit = selfWidthCache.get(e);
    if (hit !== undefined) return hit;
    const w = computeSelfWidth(e);
    selfWidthCache.set(e, w);
    return w;
  }

  function computeSelfWidth(e) {
    switch (e.type) {
      case 'num':
        return e.width;
      case 'ref':
        return refBits(e).length;        // refBits は純粋 (既存のネット ID を返すだけ)
      case 'un':
        return e.op === '!' ? 1 : selfWidth(e.a);
      case 'bin':
        if (e.op === '&&' || e.op === '||') return 1;
        if (e.op === '==' || e.op === '!=' || CMP[e.op]) return 1;
        if (e.op === '<<' || e.op === '>>') return selfWidth(e.a);
        return Math.max(selfWidth(e.a), selfWidth(e.b));
      case 'tern':
        return Math.max(selfWidth(e.a), selfWidth(e.b));
      case 'concat':
        return e.parts.reduce((sum, p) => sum + selfWidth(p), 0);
      default:
        throw new CompileError(`未知の式ノード '${e.type}'`, e.line);
    }
  }

  /**
   * 式を LSB 先頭のネット配列に展開する (文脈依存幅の 2 段目)。
   *
   * ctx は上から配られてくる文脈幅。0 は「文脈なし」= 自己決定幅で計算する、の意味。
   * 実効幅は max(自己決定幅, ctx) で、文脈依存の演算子はこれを子に配る。
   * 返す配列の長さは必ず実効幅になるので、呼び出し側は代入先の幅に resize するだけ。
   */
  function evalExpr(e, ctx = 0) {
    const w = Math.max(selfWidth(e), ctx);

    switch (e.type) {
      case 'num': {
        const out = [];
        for (let b = 0; b < w; b++) {
          // 自分の幅より上は 0。ここでマスクしないと 4'hFF が 255 のまま広がる
          const bit = b < e.width ? (e.bits >> BigInt(b)) & 1n : 0n;
          out.push(bit === 1n ? CONST1 : CONST0);
        }
        return out;
      }
      case 'ref':
        return resize(refBits(e), w);
      case 'un': {
        if (e.op === '!') {
          // 論理否定は「全ビット 0 か」なので OR リダクションの反転。結果は 1 ビット。
          // ビットごとに反転する ~ と違うのはここ (~4'b0010 は 4'b1101、!4'b0010 は 0)。
          // 中身は自己決定なので文脈を渡さない。
          return resize([newGate('not', [reduceOr(evalExpr(e.a), e.line)])], w);
        }
        const a = evalExpr(e.a, w);        // ~ と単項 - は文脈依存
        if (e.op === '~') return a.map((n) => newGate('not', [n]));
        if (e.op === '-') {
          // 2 の補数で符号反転
          const inv = a.map((n) => newGate('not', [n]));
          return addBits(inv, Array(w).fill(CONST0), CONST1);
        }
        throw new CompileError(`未対応の単項演算子 '${e.op}'`, e.line);
      }
      case 'bin': {
        // --- 文脈を受け取らないもの (結果 1 ビット) ---
        if (e.op === '&&' || e.op === '||') {
          // 両辺を「0 でないか」に潰してからゲート 1 個。
          // 短絡評価は無い (ハードウェアなので両辺とも常に評価される)。式に副作用が
          // 無いので観測できる違いにはならない。
          const l = reduceOr(evalExpr(e.a), e.line);
          const r = reduceOr(evalExpr(e.b), e.line);
          return resize([newGate(e.op === '&&' ? 'and' : 'or', [l, r])], w);
        }
        if (e.op === '==' || e.op === '!=' || CMP[e.op]) {
          // 比較は外の文脈を受け取らないが、2 つのオペランドが互いの max(幅) に
          // 揃えられる。つまりオペランド 2 つだけで文脈を作る。
          // (8 ビットのリテラルと比べると、左辺の a - b も 8 ビットで計算される)
          const cw = Math.max(selfWidth(e.a), selfWidth(e.b));
          const l = evalExpr(e.a, cw);
          const r = evalExpr(e.b, cw);
          const bits = CMP[e.op] ? compareBits(l, r, e.op) : equalBits(l, r, e.op);
          return resize(bits, w);
        }

        // --- シフト: 左は文脈依存、シフト量は自己決定 ---
        if (e.op === '<<' || e.op === '>>') {
          const a = evalExpr(e.a, w);
          // リテラルなら並べ替えだけ、信号ならバレルシフタ
          return e.b.type === 'num'
            ? shiftFixed(a, Number(e.b.bits), e.op)
            : barrelShift(a, evalExpr(e.b), e.op);
        }

        // --- 残り (ビット演算・算術) は両辺とも文脈依存 ---
        const a = evalExpr(e.a, w);
        const b = evalExpr(e.b, w);
        if (e.op === '+' || e.op === '-') return addSub(a, b, e.op);
        const op = { '&': 'and', '|': 'or', '^': 'xor' }[e.op];
        if (!op) throw new CompileError(`未対応の二項演算子 '${e.op}'`, e.line);
        return a.map((n, i) => newGate(op, [n, b[i]]));
      }
      case 'tern': {
        const sel = reduceOr(evalExpr(e.sel), e.line);   // 条件は自己決定
        const a = evalExpr(e.a, w);
        const b = evalExpr(e.b, w);
        return a.map((n, i) => newGate('mux', [sel, n, b[i]]));
      }
      case 'concat': {
        // {msb側, ..., lsb側} なので、LSB 先頭配列では逆順に連結する。
        // 各パートは自己決定 — 文脈は中に伝わらない (だから幅が曖昧にならない)
        const out = [];
        for (let i = e.parts.length - 1; i >= 0; i--) out.push(...evalExpr(e.parts[i]));
        return resize(out, w);
      }
      default:
        throw new CompileError(`未知の式ノード '${e.type}'`, e.line);
    }
  }

  // ---- always の中の文 → レジスタの次状態 ------------------------------------
  //
  // state は「レジスタの Q ネット → 次の値のネット」。エントリが無いビットは
  // 「この経路では代入されていない」と読み、合流のときに Q そのもの (= 保持) を
  // 使う。分岐のない直線的な文の列なら、上から順に上書きするだけで最後が勝つ。

  const regLine = new Map();   // Q ネット → 最後に代入した行 (エラー表示用)

  function lhsRegBits(node, line) {
    const s = lookup(node.name, line);
    if (s.kind !== 'reg') {
      throw new CompileError(`always ブロックで代入する '${s.name}' は reg 宣言が必要`, line);
    }
    return refBits(node);
  }

  /**
   * 分岐の合流。cond が真なら a 側、偽なら b 側の値を採る。
   * a と b はどちらも base のコピーから走らせたものなので、base のキーは
   * 必ず両方に含まれる。両側が同じネットに行き着くビットには mux を作らない
   * (分岐が触っていないビットはこれで素通しになる)。
   */
  function mergeStates(cond, a, b, base) {
    const out = new Map(base);
    for (const qn of new Set([...a.keys(), ...b.keys()])) {
      const av = a.get(qn) ?? qn;
      const bv = b.get(qn) ?? qn;
      out.set(qn, av === bv ? av : newGate('mux', [cond, av, bv]));
    }
    return out;
  }

  function runStmts(stmts, state) {
    let cur = state;
    for (const st of stmts) {
      if (st.type === 'nb') {
        const q = lhsRegBits(st.lhs, st.line);
        // 代入先の幅が右辺の文脈幅になる (文脈依存幅)
        const d = resize(evalExpr(st.rhs, q.length), q.length);
        q.forEach((qn, i) => {
          cur.set(qn, d[i]);
          regLine.set(qn, st.line);
        });
        continue;
      }

      if (st.type === 'if') {
        const cond = reduceOr(evalExpr(st.cond), st.line);
        const thenState = runStmts(st.then, new Map(cur));
        const elseState = st.else ? runStmts(st.else, new Map(cur)) : new Map(cur);
        cur = mergeStates(cond, thenState, elseState, cur);
        continue;
      }

      if (st.type === 'case') {
        // case 式と全ラベルは、そのすべての max(幅) に揃えられる (Verilog の規則)。
        // 符号なししか無いので結果は max(2 つ) と同じになるが、規則どおりにしておく。
        let cw = selfWidth(st.sel);
        for (const it of st.items) {
          for (const label of it.labels) cw = Math.max(cw, selfWidth(label));
        }
        const sel = evalExpr(st.sel, cw);
        // default (無ければ「保持」) を土台にして後ろの項目から積む。こうすると
        // 先に書いた項目の mux が外側に来て、Verilog の「上から順に最初に一致
        // したものが勝つ」がそのまま出る。
        let acc = st.default ? runStmts(st.default, new Map(cur)) : new Map(cur);
        for (let k = st.items.length - 1; k >= 0; k--) {
          const it = st.items[k];
          let cond = null;
          for (const label of it.labels) {
            const hit = equalBits(sel, evalExpr(label, cw), '==')[0];
            cond = cond === null ? hit : newGate('or', [cond, hit]);
          }
          acc = mergeStates(cond, runStmts(it.stmts, new Map(cur)), acc, cur);
        }
        cur = acc;
        continue;
      }

      throw new CompileError(`未知の文ノード '${st.type}'`, st.line);
    }
    return cur;
  }

  /** 左辺のネット列に右辺を接続する (buf ゲートで橋渡し) */
  function connect(lhsNode, rhsBits, what, line) {
    const lhs = refBits(lhsNode);
    const src = resize(rhsBits, lhs.length);
    lhs.forEach((q, i) => {
      setDriver(q, what, line);
      gates.push({ op: 'buf', out: q, in: [src[i]] });
    });
  }

  // ---- 項目の処理 ----------------------------------------------------------
  let clock = null;

  for (const item of mod.items) {
    if (item.type === 'decl') continue;

    if (item.type === 'assign') {
      const s = lookup(item.lhs.name, item.line);
      if (s.kind === 'reg') {
        throw new CompileError(`assign で reg '${s.name}' は駆動できない (always を使う)`, item.line);
      }
      if (s.dir === 'input') {
        throw new CompileError(`入力ポート '${s.name}' は駆動できない`, item.line);
      }
      // 代入先の幅が右辺の文脈幅になる (文脈依存幅)
      const lhsWidth = refBits(item.lhs).length;
      connect(item.lhs, evalExpr(item.rhs, lhsWidth), 'assign 文', item.line);
      continue;
    }

    if (item.type === 'gate') {
      if (!GATE_PRIMITIVES.has(item.gate)) {
        throw new CompileError(`未知のゲート '${item.gate}'`, item.line);
      }
      if (item.args.length < 1) throw new CompileError('ゲートの引数が足りない', item.line);
      const [outNode, ...inNodes] = item.args;
      if (outNode.type !== 'ref') throw new CompileError('ゲートの第1引数は出力信号名', item.line);

      const unary = item.gate === 'not' || item.gate === 'buf';
      if (unary && inNodes.length !== 1) {
        throw new CompileError(`${item.gate} は入力 1 本 (${inNodes.length} 本指定された)`, item.line);
      }
      if (!unary && inNodes.length < 2) {
        throw new CompileError(`${item.gate} は入力 2 本以上 (${inNodes.length} 本指定された)`, item.line);
      }

      const inBits = inNodes.map((n) => evalExpr(n));
      const width = Math.max(...inBits.map((b) => b.length));
      const padded = inBits.map((b) => resize(b, width));

      const base = { and: 'and', nand: 'and', or: 'or', nor: 'or', xor: 'xor', xnor: 'xor', not: null, buf: null }[item.gate];
      const invert = item.gate === 'nand' || item.gate === 'nor' || item.gate === 'xnor' || item.gate === 'not';

      const result = [];
      for (let b = 0; b < width; b++) {
        let acc = padded[0][b];
        if (base) for (let k = 1; k < padded.length; k++) acc = newGate(base, [acc, padded[k][b]]);
        if (invert) acc = newGate('not', [acc]);
        result.push(acc);
      }
      connect(outNode, result, `${item.gate} ゲート`, item.line);
      continue;
    }

    if (item.type === 'always') {
      const clk = lookup(item.clock, item.line);
      if (clk.width !== 1) throw new CompileError(`クロック '${item.clock}' は 1 ビットでなければならない`, item.line);
      if (clock && clock !== item.clock) {
        throw new CompileError(`複数クロックは未対応 ('${clock}' と '${item.clock}')`, item.line);
      }
      clock = item.clock;
      clk.isClock = true;

      // 文を上から順に辿り、レジスタの各ビットについて「次の値」を組み立てる。
      // 分岐は then 側と else 側を別々に走らせてから mux でマージする。
      // どちらの経路でも代入されなかったビットは Q そのもの (= 保持) になる。
      const next = runStmts(item.stmts, new Map());

      for (const [qn, d] of next) {
        const line = regLine.get(qn) ?? item.line;
        setDriver(qn, `always @(posedge ${clock})`, line);
        regs.push({ q: qn, d, line });
      }
      continue;
    }

    throw new CompileError(`未対応の項目 '${item.type}'`, item.line);
  }

  // ---- 未駆動ネットの検査 ---------------------------------------------------
  const undriven = [];
  for (const s of signals.values()) {
    if (s.dir === 'input') continue;
    s.bits.forEach((n) => {
      if (!drivers.has(n)) undriven.push(nets[n].name);
    });
  }
  if (undriven.length > 0) {
    // 未駆動は 0 に固定して継続する (途中まで書いた RTL でも動かせるようにする)
    for (const s of signals.values()) {
      s.bits.forEach((n) => {
        if (!drivers.has(n)) {
          drivers.set(n, '未駆動 (0 固定)');
          gates.push({ op: 'buf', out: n, in: [CONST0] });
        }
      });
    }
  }

  return {
    name: mod.name,
    nets,
    gates,
    regs,
    signals,
    clock,
    portOrder: mod.portOrder,
    warnings: undriven.length ? [`未駆動の信号を 0 に固定しました: ${undriven.join(', ')}`] : [],
    CONST0,
    CONST1,
  };
}
