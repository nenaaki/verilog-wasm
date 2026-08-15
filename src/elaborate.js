// AST → ネットリスト IR
//
// すべての信号を 1 ビット単位のネットに展開する (bit-blast)。
// 以降の工程 (スケジューリング / コード生成) はビット幅を一切意識しない。
//
// ネットリスト IR:
//   nets   : [{ name }]                      … 1 ネット = 1 ビット
//   gates  : [{ op, out, in:[netId], value }] … op: const|buf|not|and|or|xor|mux
//   regs   : [{ q, d, rst, rstD, qAsync, line }] … posedge clk の D フリップフロップ
//            rst 以下は非同期リセット付きのときだけ埋まる (無いときは null):
//              rst    … リセットが効いている条件のネット
//              rstD   … リセット時の値
//              qAsync … mux(rst, rstD, q)。クロックを待たずに Q へ書き戻す値で、
//                       eval が Q スロットに store する (d は commit 用)
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

const MAX_DEPTH = 16;   // インスタンスの入れ子の上限

// z / ? は「その桁を比較しない」印としてだけ扱う。値としての z は持たないので、
// casez のラベル以外の場所に出てきたら断る (黙って 0 にすると回路が静かに変わる)
const DONT_CARE_ONLY_IN_CASEZ = 'z / ? は casez のラベルでしか使えない (値としての z は扱わない)';

/**
 * @param {object} mod    top にする module の AST
 * @param {object[]} [all] インスタンス解決に使う module 一覧 (省略時は階層なし)
 */
export function elaborate(mod, all = [mod]) {
  const modules = new Map(all.map((m) => [m.name, m]));
  const instanceNames = new Set();
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

  // ---- 定数畳み込みと共通部分式除去 -----------------------------------------
  //
  // ゲートは「入力だけで決まる純粋な関数」なので、作る前に 2 つ挟める:
  //   - 定数畳み込み: 入力が $const0 / $const1 なら答えのネットをそのまま返す
  //   - 共通部分式除去: 同じ op と同じ入力の組が既にあれば、その出力を使い回す
  //
  // ここは全ゲート生成の唯一の入口なので、加算器・比較器・バレルシフタ・mux 木の
  // すべてが自動的に恩恵を受ける。とくにゼロ拡張 (resize が $const0 を詰める) と
  // サイズ無しリテラルの 32 ビット化で入る定数が、ここで大量に消える。

  const gateOf = new Map();   // 出力ネット → そのゲート (~~x = x をたたむのに使う)
  const cse = new Map();      // `op:入力` → 既存の出力ネット

  /** 片方がもう片方の not か。x & ~x / x | ~x をたたむのに使う */
  function isInverseOf(a, b) {
    const ga = gateOf.get(a);
    if (ga && ga.op === 'not' && ga.in[0] === b) return true;
    const gb = gateOf.get(b);
    return !!(gb && gb.op === 'not' && gb.in[0] === a);
  }

  /** たためたら結果のネット ID、たためなければ null */
  function fold(op, ins) {
    if (op === 'not') {
      const [a] = ins;
      if (a === CONST0) return CONST1;
      if (a === CONST1) return CONST0;
      const g = gateOf.get(a);
      if (g && g.op === 'not') return g.in[0];          // ~~x = x
      return null;
    }
    if (op === 'and') {
      const [a, b] = ins;
      if (a === CONST0 || b === CONST0) return CONST0;
      if (a === CONST1) return b;
      if (b === CONST1) return a;
      if (a === b) return a;                           // x & x = x
      return isInverseOf(a, b) ? CONST0 : null;        // x & ~x = 0
    }
    if (op === 'or') {
      const [a, b] = ins;
      if (a === CONST1 || b === CONST1) return CONST1;
      if (a === CONST0) return b;
      if (b === CONST0) return a;
      if (a === b) return a;                           // x | x = x
      return isInverseOf(a, b) ? CONST1 : null;        // x | ~x = 1
    }
    if (op === 'xor') {
      const [a, b] = ins;
      if (a === b) return CONST0;                      // x ^ x = 0
      if (a === CONST0) return b;
      if (b === CONST0) return a;
      if (a === CONST1) return newGate('not', [b]);    // 1 ^ x = ~x
      if (b === CONST1) return newGate('not', [a]);
      return null;
    }
    if (op === 'mux') {
      const [s, a, b] = ins;
      if (s === CONST1) return a;
      if (s === CONST0) return b;
      if (a === b) return a;
      if (a === CONST1 && b === CONST0) return s;      // s ? 1 : 0 = s
      if (a === CONST0 && b === CONST1) return newGate('not', [s]);
      // 選ばれる側が選択信号そのもの / その反転なら、その枝の値は定数に決まる。
      // 割り算の剰余の上位ビットがちょうどこの形 (s ? ~s : 0) になり、
      // これを畳めるかどうかで非サイズリテラルの除算が 4 倍変わる
      if (a === s) return newGate('or', [s, b]);       // s ? 1 : b = s | b
      if (b === s) return newGate('and', [s, a]);      // s ? a : 0 = s & a
      if (isInverseOf(s, a)) return newGate('and', [a, b]);   // s ? 0 : b = ~s & b
      if (isInverseOf(s, b)) return newGate('or', [b, a]);    // s ? a : 1 = ~s | a
      return null;
    }
    return null;
  }

  const newGate = (op, ins, tag) => {
    const folded = fold(op, ins);
    if (folded !== null) return folded;

    // and / or / xor は入力の順番を問わないので、揃えてから引く
    const keyIns = op === 'mux' ? ins : [...ins].sort((a, b) => a - b);
    const hit = cse.get(`${op}:${keyIns}`);
    if (hit !== undefined) return hit;

    const out = newNet(`$${op}${gates.length}${tag ? `_${tag}` : ''}`);
    const gate = { op, out, in: ins };
    gates.push(gate);
    gateOf.set(out, gate);
    drivers.set(out, 'ゲート');
    cse.set(`${op}:${keyIns}`, out);
    return out;
  };

  // ---- 宣言とスコープ ------------------------------------------------------
  //
  // 階層は「展開しながら平坦化」する。signals は 1 個のフラットな Map で、キーは
  // インスタンス名を前置した完全修飾名 (`h0.s1`、`h0.h1.carry`)。名前解決だけを
  // 現在のスコープで行う。scope は再帰の入り口で差し替えて出口で戻すので、
  // 深さ優先の走査中は常に「いま展開している場所の接頭辞」になっている。
  let scope = '';
  // いま展開している module の接頭辞。generate ブロックは module の中の入れ子
  // スコープなので、scope はそれより深くなり得る (`h0.g[2].`)。名前を外へ辿るとき
  // ここで止める ― 子 module から親の信号は見えないが、generate ブロックの中から
  // その module の信号は見える、という違いを 1 個の変数で表している。
  let scopeBase = '';

  /**
   * 名前が実際に宣言されているスコープを、内側から外へ辿って探す。
   * 見つからなければ scopeBase を返す (エラーメッセージが module の名前で出る)。
   */
  function resolveScope(name) {
    for (let p = scope; ; p = p.slice(0, p.lastIndexOf('.', p.length - 2) + 1)) {
      if (signals.has(p + name) || params.has(p + name) || loopVars.has(p + name)) return p;
      if (p === scopeBase || p.length <= scopeBase.length) return scopeBase;
    }
  }

  // ---- function ---------------------------------------------------------------
  //
  // function は呼び出しごとにインライン展開する。本体は Verilog の仕様上時間制御を
  // 持てないので必ず組合せ回路で、ローカル変数はレジスタではなく「その場で値が入る
  // 一時変数」= ただのネット配列になる。だから blocking 代入は「名前をネット配列に
  // 貼り替える」だけで表せる (always の非ノンブロッキングと違って保持の場合分けが無い)。
  // integer で宣言した名前 (完全修飾名)。信号ではなく「elaborate 時の整数」で、
  // for のループ変数としてだけ動く。値は params に入れるので、本体の `q[i]` のような
  // 添字が parameter と同じ経路でそのまま定数式として解ける
  const loopVars = new Set();
  const MAX_UNROLL = 4096;             // 展開しきれない for の歯止め

  const funcs = new Map();             // 完全修飾名 → AST
  // 展開中のローカル環境。null 以外のあいだ refBits がこちらを先に見る。
  // 入れ子の呼び出し (f(g(a))) は保存・復帰でスタックにする
  let funcEnv = null;
  const MAX_FUNC_DEPTH = 32;           // 再帰の歯止め
  let funcDepth = 0;

  // ---- パラメータと定数式 ----------------------------------------------------
  //
  // parameter / localparam の値。signals と同じく完全修飾名で持つので、同じ module を
  // 別のパラメータで 2 回インスタンス化しても互いに影響しない。
  const params = new Map();

  const PARAM_WIDTH = 32;              // サイズ無しリテラルと同じ扱い
  const WRAP32 = 1n << BigInt(PARAM_WIDTH);

  /**
   * 定数式を評価する。パラメータとリテラルだけで組まれた式が対象で、
   * 幅を持たない整数 (BigInt) として計算する。
   * ビット幅が要る演算 (~ や連接) は意味が決まらないので断る。
   */
  function constExpr(e) {
    const bool = (b) => (b ? 1n : 0n);
    switch (e.type) {
      case 'num':
        if (e.mask) throw new CompileError(DONT_CARE_ONLY_IN_CASEZ, e.line);
        return e.bits & ((1n << BigInt(e.width)) - 1n);      // 自分の幅で切る
      case 'call':
        // 定数式は幅を持たない整数で計算するので、ビットに展開する function は使えない
        throw new CompileError(`定数式では function (${e.name}) を呼べない`, e.line);
      case 'ref': {
        // 階層参照は「回路の中の信号」なので、定数式には出てこない
        if (e.path) throw new CompileError('階層参照は定数式に使えない', e.line);
        const v = params.get(resolveScope(e.name) + e.name);
        if (v === undefined) {
          throw new CompileError(
            `'${e.name}' は定数式に使えない (parameter / localparam ではない)`, e.line);
        }
        if (e.range) throw new CompileError('定数式でビット選択は使えない', e.line);
        return v;
      }
      case 'un': {
        if (e.op === '-') return -constExpr(e.a);
        if (e.op === '!') return bool(constExpr(e.a) === 0n);
        throw new CompileError(`定数式では単項 '${e.op}' は使えない (幅が決まらない)`, e.line);
      }
      case 'bin': {
        const a = constExpr(e.a);
        const b = constExpr(e.b);
        switch (e.op) {
          case '+': return a + b;
          case '-': return a - b;
          // 回路にはならないが、定数どうしなら elaborate 時に計算できる
          case '*': return a * b;
          case '/':
            if (b === 0n) throw new CompileError('定数式で 0 除算', e.line);
            return a / b;
          case '%':
            if (b === 0n) throw new CompileError('定数式で 0 除算', e.line);
            return a % b;
          case '<<': return a << b;
          case '>>': return a >> b;
          case '&': return a & b;
          case '|': return a | b;
          case '^': return a ^ b;
          case '==': return bool(a === b);
          case '!=': return bool(a !== b);
          case '<': return bool(a < b);
          case '<=': return bool(a <= b);
          case '>': return bool(a > b);
          case '>=': return bool(a >= b);
          case '&&': return bool(a !== 0n && b !== 0n);
          case '||': return bool(a !== 0n || b !== 0n);
          default: throw new CompileError(`定数式では '${e.op}' は使えない`, e.line);
        }
      }
      case 'tern':
        return constExpr(e.sel) !== 0n ? constExpr(e.a) : constExpr(e.b);
      default:
        throw new CompileError(`定数式には使えない式 ('${e.type}')`, e.line);
    }
  }

  /** [msb:lsb] を数に落とす。パラメータの値が決まった後でないと呼べない */
  function evalRange(range, line) {
    const msb = Number(constExpr(range.msb));
    const lsb = Number(constExpr(range.lsb));
    if (!Number.isSafeInteger(msb) || !Number.isSafeInteger(lsb) || msb < 0 || lsb < 0) {
      throw new CompileError(`ビット範囲 [${msb}:${lsb}] が不正`, range.line ?? line);
    }
    return { msb, lsb };
  }

  /** 定数の値を LSB 先頭のネット配列にする (パラメータを式の中で使ったとき) */
  function constBits(value, width) {
    const masked = ((value % WRAP32) + WRAP32) % WRAP32;
    const out = [];
    for (let b = 0; b < width; b++) {
      const bit = b < PARAM_WIDTH ? (masked >> BigInt(b)) & 1n : 0n;
      out.push(bit === 1n ? CONST1 : CONST0);
    }
    return out;
  }

  /**
   * スコープのパラメータを決める。ヘッダと本体の宣言を順に評価しつつ、
   * インスタンス側の指定 (すでに親のスコープで評価済み) で上書きする。
   * localparam は上書きできない。
   */
  function setupParams(m, prefix, overrides) {
    const declared = (m.params ?? []).filter((p) => !p.local).map((p) => p.name);
    const byName = new Map();
    for (const [i, o] of (overrides ?? []).entries()) {
      const name = o.name ?? declared[i];
      if (name === undefined) {
        throw new CompileError(
          `${m.name} の parameter は ${declared.length} 個だが ${i + 1} 個目を渡している`, o.line);
      }
      if (!declared.includes(name)) {
        throw new CompileError(`${m.name} に parameter '${name}' は無い`
          + `${(m.params ?? []).some((p) => p.local && p.name === name) ? ' (localparam は差し替えられない)' : ''}`,
          o.line);
      }
      if (byName.has(name)) throw new CompileError(`parameter '${name}' を 2 回指定している`, o.line);
      byName.set(name, o.value);
    }

    const saved = scope;
    const savedBase = scopeBase;
    scope = prefix;                    // 既定値は自分のスコープで評価する
    scopeBase = prefix;                // 親の名前は見えない (module の境界)
    for (const p of m.params ?? []) {
      params.set(prefix + p.name, byName.has(p.name) ? byName.get(p.name) : constExpr(p.expr));
    }
    scope = saved;
    scopeBase = savedBase;
  }

  function declare(prefix, name, { dir, kind, range }, line) {
    const full = prefix + name;
    let s = signals.get(full);
    const r = range ? evalRange(range, line) : null;
    if (!s) {
      const msb = r ? r.msb : 0;
      const lsb = r ? r.lsb : 0;
      if (msb < lsb) throw new CompileError(`降順ビット範囲 [${msb}:${lsb}] は未対応`, line);
      const width = msb - lsb + 1;
      const bits = [];
      for (let b = 0; b < width; b++) {
        bits.push(newNet(width > 1 ? `${full}[${b + lsb}]` : full));
      }
      s = {
        name: full, local: name, isTop: prefix === '',
        dir: dir ?? null, kind: kind ?? 'wire', msb, lsb, width, bits,
      };
      signals.set(full, s);
    } else {
      if (r && (r.msb !== s.msb || r.lsb !== s.lsb)) {
        throw new CompileError(`${full} のビット範囲が宣言間で矛盾している`, line);
      }
      if (dir) s.dir = dir;
      if (kind) s.kind = kind;
    }
    return s;
  }

  const lookup = (name, line) => {
    const base = resolveScope(name);
    const s = signals.get(base + name);
    if (!s) {
      if (params.has(base + name)) {
        throw new CompileError(`'${name}' は parameter なので信号として使えない`, line);
      }
      if (loopVars.has(base + name)) {
        throw new CompileError(
          `'${name}' は integer なので信号として使えない (for のループ変数と定数式でだけ使える)`, line);
      }
      throw new CompileError(`未宣言の信号 '${name}'`, line);
    }
    return s;
  };

  /**
   * 項目の並びから宣言だけを拾う。generate ブロックの中身にも同じものを使うので、
   * module 単位ではなく項目の配列を受ける。入れ子の generate は見ない ―
   * 中の宣言はそのブロックを展開するときに、そのブロックのスコープで処理する。
   */
  function declItems(items, prefix) {
    for (const item of items) {
      if (item.type === 'decl') {
        for (const n of item.names) declare(prefix, n, item, item.line);
      }
      if (item.type === 'intdecl') {
        for (const n of item.names) {
          if (signals.has(prefix + n)) {
            throw new CompileError(`'${n}' が信号と integer で二重に宣言されている`, item.line);
          }
          loopVars.add(prefix + n);
        }
      }
      if (item.type === 'func') {
        if (funcs.has(prefix + item.name)) {
          throw new CompileError(`function '${item.name}' が二重に定義されている`, item.line);
        }
        if (signals.has(prefix + item.name)) {
          throw new CompileError(`'${item.name}' は信号と function で名前がぶつかっている`, item.line);
        }
        funcs.set(prefix + item.name, item);
      }
    }
  }

  /** 宣言だけ先に処理して、前方参照 (assign が後続の wire 宣言を参照する等) を許す */
  function declPass(m, prefix) {
    // [WIDTH-1:0] の WIDTH を引くのに自分のスコープが要る
    const saved = scope;
    const savedBase = scopeBase;
    scope = prefix;
    scopeBase = prefix;
    declItems(m.items, prefix);
    scope = saved;
    scopeBase = savedBase;
    for (const pname of m.portOrder) {
      if (!signals.has(prefix + pname)) {
        throw new CompileError(
          `${m.name}: ポート '${pname}' の方向が宣言されていない`, m.line);
      }
    }
  }

  // ---- 式の評価 (→ LSB 先頭のネット配列) ------------------------------------
  /**
   * 繰り返し連接 `{n{…}}` の n。定数式なので展開時に数に落ちる。
   * 0 は許す ―― `{{(W-1){1'b0}}, x}` は W が 1 のとき 0 回になり、Verilog でも
   * 「連接の中でだけ許される幅 0」として通る書き方だから。
   */
  function repeatCount(e) {
    const n = constExpr(e.count);
    if (n < 0n) {
      throw new CompileError(`繰り返し連接の回数が負 (${n})`, e.line);
    }
    if (n > MAX_UNROLL) {
      throw new CompileError(
        `繰り返し連接の回数が多すぎる (${n}。上限 ${MAX_UNROLL})`, e.line);
    }
    return Number(n);
  }

  function resize(bits, width) {
    if (bits.length === width) return bits;
    if (bits.length > width) return bits.slice(0, width);
    return [...bits, ...Array(width - bits.length).fill(CONST0)];
  }

  /**
   * 階層参照のパスを完全修飾名に落とす。`bits[i-1].s` の添字は genvar のことが
   * あるので、ここで初めて数になる (signals のキーは `bits[0].s` の形)。
   */
  function pathName(node) {
    return node.path
      .map((p) => (p.index === null ? p.name : `${p.name}[${constExpr(p.index)}]`))
      .join('.');
  }

  function refBits(node) {
    if (node.path) {
      const name = pathName(node);
      const base = resolveScope(name);
      const s = signals.get(base + name);
      if (!s) {
        // 先頭の名前のスコープが既にあるなら、末尾の名前の間違い。
        // 影も形も無いなら、まだ展開されていない (書く場所の問題) 可能性が高い
        const head = node.path[0].name;
        const known = [...signals.keys()]
          .some((k) => k.startsWith(`${base}${head}.`) || k.startsWith(`${base}${head}[`));
        throw new CompileError(
          known
            ? `階層参照 '${name}' の指す信号が無い ('${head}' の中にその名前は無い)`
            : `階層参照 '${name}' の指す信号が無い `
              + '(インスタンスや generate ブロックより後ろに書く必要がある)',
          node.line);
      }
      return sliceOfSignal(s, node);
    }
    // function を展開している間はローカル (引数・ローカル変数・戻り値) を先に見る。
    // 外側の信号と同じ名前でもローカルが勝つ (Verilog のスコープ規則)
    const local = funcEnv?.get(node.name);
    if (local) return sliceBits(local, node);
    return sliceOfSignal(lookup(node.name, node.line), node);
  }

  /** 信号のビット選択 / 部分選択。範囲を書いていなければ全ビット */
  function sliceOfSignal(s, node) {
    if (!node.range) return s.bits;
    // 添字は定数式。パラメータ入りの [WIDTH-1:0] もここで数になる
    const { msb, lsb } = evalRange(node.range, node.line);
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
   * function のローカル変数のビット選択 / 部分選択。signals と同じ添字の数え方に
   * するため、宣言時の msb / lsb を持ち歩いている。
   */
  function sliceBits(local, node) {
    if (!node.range) return local.bits;
    const { msb, lsb } = evalRange(node.range, node.line);
    if (msb < lsb) throw new CompileError(`降順の部分選択 [${msb}:${lsb}] は未対応`, node.line);
    const out = [];
    for (let i = lsb; i <= msb; i++) {
      const pos = i - local.lsb;
      if (pos < 0 || pos >= local.bits.length) {
        throw new CompileError(
          `${node.name}[${i}] は宣言範囲 [${local.msb}:${local.lsb}] の外`, node.line);
      }
      out.push(local.bits[pos]);
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
   * addBits と同じ加算器だが、最上位段の桁上げ出力も返す。
   * 割り算の「引けるかどうか」は a - b の桁上げ出力そのものなので、和と判定を
   * 1 個の加算器から取り出す必要がある (geCarry は判定だけで和を作らない)。
   */
  function addCarry(a, b, cin) {
    let carry = cin;
    const bits = [];
    for (let i = 0; i < a.length; i++) {
      const axb = newGate('xor', [a[i], b[i]]);
      bits.push(newGate('xor', [axb, carry]));
      carry = newGate('or', [newGate('and', [a[i], b[i]]), newGate('and', [carry, axb])]);
    }
    return { bits, carry };
  }

  /**
   * a * b。両辺は実効幅 w に揃えてある。部分積を w 段積む配列乗算器で、
   * w ビットに収まらない桁は作らない (+ / - と同じく、あふれは捨てる)。
   *
   * 部分積の j 段目は「a を j ビット左にずらして b[j] でマスクしたもの」なので、
   * 下位 j ビットは必ず 0 になる。そこは加算器を置かず、累算器の j ビット目から
   * 上だけを足す。全加算器は w²/2 個ほどで、素朴に w 段の w ビット加算を並べる
   * より半分で済む。
   *
   * 片側が定数なら fold が効いて勝手に縮む。b[j] が 0 の段は部分積が丸ごと消え、
   * 1 の段は AND が素通りするので、`a * 4` は加算器 0 個のただのシフトになる。
   * 幅が 32 に広がる非サイズリテラルでも、上位の 0 ビットが同じ経路で消える。
   */
  function mulBits(a, b) {
    const w = a.length;
    let acc = a.map((n) => newGate('and', [n, b[0]]));
    for (let j = 1; j < w; j++) {
      const row = a.slice(0, w - j).map((n) => newGate('and', [n, b[j]]));
      const sum = addBits(acc.slice(j), row, CONST0);
      acc = [...acc.slice(0, j), ...sum];
    }
    return acc;
  }

  /**
   * 符号なしの a / b と a % b を 1 個の回路から取り出す (両方要ることは少ないが、
   * 使わない側は刈り取りが落とす)。筆算そのままの復元法で、上の桁から 1 ビットずつ:
   *
   *   剰余を 1 ビット左にずらして a のその桁を下ろす
   *   → b を引いてみる → 引けたら (桁上げが立ったら) 商のその桁が 1、剰余を差に更新
   *
   * 剰余は常に b 未満なので w ビットに収まるが、左にずらした直後だけ 1 ビット
   * はみ出す。そこで途中は w+1 ビットで持ち、最後に切り詰める。
   *
   * **b が 0 のときは全桁で「引けた」ことになり、商は全 1・剰余は a になる。**
   * Verilog は x を返すが、この処理系は x を値として持たないので、回路が自然に
   * 出す値をそのまま定義とした。
   */
  function divRem(a, b) {
    const w = a.length;
    const nb = [...b, CONST0].map((n) => newGate('not', [n]));   // ~b (w+1 ビット)
    let rem = Array(w + 1).fill(CONST0);
    const quot = new Array(w);
    for (let i = w - 1; i >= 0; i--) {
      rem = [a[i], ...rem.slice(0, w)];                          // rem = rem<<1 | a[i]
      const { bits, carry } = addCarry(rem, nb, CONST1);         // rem - b
      quot[i] = carry;                                           // 桁上げ = 引けた = rem >= b
      rem = rem.map((n, k) => newGate('mux', [carry, bits[k], n]));
    }
    return { quot, rem: rem.slice(0, w) };
  }

  /**
   * a == b / a != b。差分ビットを OR リダクションして 1 ビットにする。
   * XNOR の AND リダクションでも同じだが、こちらは基本ゲートだけで済む。
   */
  /**
   * case のラベル 1 個と式の一致。casez のときはラベルに書いた z / ? の桁を
   * 比較から外す。ラベルを幅 cw に伸ばしたときの上位は 0 で埋まる (don't care は
   * 広がらない) ので、そこは比較する ― Verilog の規則どおり。
   *
   * don't care は**リテラルに書いたものだけ**を見る。式で作った z は無いので、
   * ラベルがリテラル以外なら普通の一致になる。
   */
  function matchLabel(sel, label, cw, casez) {
    const mask = casez && label.type === 'num' ? label.mask : 0n;
    if (!mask) return equalBits(sel, evalExpr(label, cw), '==')[0];
    // mask を落としたリテラルとして評価する (don't care の桁は 0 が入っている)
    const bits = evalExpr({ ...label, mask: 0n }, cw);
    const diffs = [];
    for (let i = 0; i < cw; i++) {
      if ((mask >> BigInt(i)) & 1n) continue;
      diffs.push(newGate('xor', [sel[i], bits[i]]));
    }
    if (diffs.length === 0) return CONST1;        // 全桁 don't care = 常に一致
    let diff = diffs[0];
    for (let i = 1; i < diffs.length; i++) diff = newGate('or', [diff, diffs[i]]);
    return newGate('not', [diff]);
  }

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

  /**
   * リダクション: 全ビットを 1 個のゲート列に畳んで 1 ビットにする。
   * 空なら単位元 (and は 1、or / xor は 0) を返す。
   */
  function reduce(bits, op) {
    if (bits.length === 0) return op === 'and' ? CONST1 : CONST0;
    let acc = bits[0];
    for (let i = 1; i < bits.length; i++) acc = newGate(op, [acc, bits[i]]);
    return acc;
  }

  const reduceOr = (bits) => reduce(bits, 'or');

  // 前置に書いたときのリダクション。~& / ~| は `~` と割れても
  // 「1 ビットの結果を反転」になるので、ここでは扱わなくてよい。
  const REDUCE = { '&': 'and', '|': 'or', '^': 'xor' };

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
      case 'call':
        // 関数呼び出しの自己決定幅は宣言した戻り値の幅。中身は見なくて済む
        return funcWidth(lookupFunc(e));
      case 'ref':
        if (e.path) return refBits(e).length;      // 階層参照は parameter にならない
        // parameter を式の中で使ったときはサイズ無しリテラルと同じ 32 ビット扱い
        if (params.has(resolveScope(e.name) + e.name)) return PARAM_WIDTH;
        return refBits(e).length;        // refBits は純粋 (既存のネット ID を返すだけ)
      case 'un':
        // 論理否定とリダクションは 1 ビット。残り (~ 単項 -) はオペランドの幅
        if (e.op === '!' || REDUCE[e.op] || e.op === '~^' || e.op === '^~') return 1;
        return selfWidth(e.a);
      case 'bin':
        if (e.op === '&&' || e.op === '||') return 1;
        if (e.op === '==' || e.op === '!=' || CMP[e.op]) return 1;
        if (e.op === '<<' || e.op === '>>') return selfWidth(e.a);
        return Math.max(selfWidth(e.a), selfWidth(e.b));
      case 'tern':
        return Math.max(selfWidth(e.a), selfWidth(e.b));
      case 'concat':
        return e.parts.reduce((sum, p) => sum + selfWidth(p), 0);
      case 'repeat':
        // 繰り返し連接。回数は定数式なので、ここで数に落とせる
        return repeatCount(e) * e.parts.reduce((sum, p) => sum + selfWidth(p), 0);
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
      // 関数呼び出しは自己決定幅 (= 宣言した戻り値の幅) で展開して、
      // 外の文脈幅にはゼロ拡張で合わせる。文脈は中に配らない
      case 'call':
        return resize(inlineFunc(e), w);
      case 'num': {
        if (e.mask) throw new CompileError(DONT_CARE_ONLY_IN_CASEZ, e.line);
        const out = [];
        for (let b = 0; b < w; b++) {
          // 自分の幅より上は 0。ここでマスクしないと 4'hFF が 255 のまま広がる
          const bit = b < e.width ? (e.bits >> BigInt(b)) & 1n : 0n;
          out.push(bit === 1n ? CONST1 : CONST0);
        }
        return out;
      }
      case 'ref': {
        if (e.path) return resize(refBits(e), w);
        const pv = params.get(resolveScope(e.name) + e.name);
        if (pv !== undefined) {
          if (e.range) throw new CompileError('parameter のビット選択は未対応', e.line);
          return constBits(pv, w);
        }
        return resize(refBits(e), w);
      }
      case 'un': {
        if (e.op === '!') {
          // 論理否定は「全ビット 0 か」なので OR リダクションの反転。結果は 1 ビット。
          // ビットごとに反転する ~ と違うのはここ (~4'b0010 は 4'b1101、!4'b0010 は 0)。
          // 中身は自己決定なので文脈を渡さない。
          return resize([newGate('not', [reduceOr(evalExpr(e.a))])], w);
        }
        // リダクションも結果 1 ビット。中身は自己決定
        if (REDUCE[e.op]) {
          return resize([reduce(evalExpr(e.a), REDUCE[e.op])], w);
        }
        if (e.op === '~^' || e.op === '^~') {
          return resize([newGate('not', [reduce(evalExpr(e.a), 'xor')])], w);
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
          const l = reduceOr(evalExpr(e.a));
          const r = reduceOr(evalExpr(e.b));
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
        if (e.op === '*') return mulBits(a, b);
        if (e.op === '/') return divRem(a, b).quot;
        if (e.op === '%') return divRem(a, b).rem;
        // 中置の ~^ / ^~ はビットごとの XNOR
        if (e.op === '~^' || e.op === '^~') {
          return a.map((n, i) => newGate('not', [newGate('xor', [n, b[i]])]));
        }
        const op = { '&': 'and', '|': 'or', '^': 'xor' }[e.op];
        if (!op) throw new CompileError(`未対応の二項演算子 '${e.op}'`, e.line);
        return a.map((n, i) => newGate(op, [n, b[i]]));
      }
      case 'tern': {
        const sel = reduceOr(evalExpr(e.sel));   // 条件は自己決定
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
      case 'repeat': {
        // {n{a, b}} は {a, b} を n 個並べたもの。LSB 先頭配列では
        // 中身をそのまま n 回つなぐだけでその順番になる
        const inner = [];
        for (let i = e.parts.length - 1; i >= 0; i--) inner.push(...evalExpr(e.parts[i]));
        const out = [];
        for (let k = 0; k < repeatCount(e); k++) out.push(...inner);
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

  // ---- function の展開 --------------------------------------------------------

  /** 呼び出し名から function を引く。スコープを外側へ辿る */
  function lookupFunc(node) {
    for (let p = scope; ; p = p.slice(0, p.lastIndexOf('.', p.length - 2) + 1)) {
      const f = funcs.get(p + node.name);
      if (f) return f;
      if (p === '') break;
    }
    throw new CompileError(
      `'${node.name}' という function は無い (式の中の名前 + '(' は関数呼び出し)`, node.line);
  }

  /** 宣言した戻り値の幅。範囲を省略したら 1 ビット */
  function funcWidth(f) {
    if (!f.range) return 1;
    const { msb, lsb } = evalRange(f.range, f.line);
    return msb - lsb + 1;
  }

  /** 宣言の [msb:lsb] を {msb, lsb, width} にする。省略なら 1 ビットの [0:0] */
  function declRange(range, line) {
    if (!range) return { msb: 0, lsb: 0, width: 1 };
    const { msb, lsb } = evalRange(range, line);
    if (msb < lsb) throw new CompileError(`降順の宣言 [${msb}:${lsb}] は未対応`, line);
    return { msb, lsb, width: msb - lsb + 1 };
  }

  /**
   * function をインライン展開して戻り値のビット配列を返す。
   *
   * ローカル環境 (引数・ローカル変数・戻り値) は「名前 → ネット配列」の Map で、
   * blocking 代入はここを貼り替えるだけ。if / case は環境のコピーを 2 本走らせて
   * mux で合流する (always の mergeStates と同じ形)。
   */
  function inlineFunc(node) {
    const f = lookupFunc(node);
    if (node.args.length !== f.args.length) {
      throw new CompileError(
        `${f.name} の引数は ${f.args.length} 個 (${node.args.length} 個渡されている)`, node.line);
    }
    if (++funcDepth > MAX_FUNC_DEPTH) {
      funcDepth = 0;
      throw new CompileError(`function '${f.name}' の呼び出しが深すぎる (再帰は未対応)`, node.line);
    }

    // 引数は**呼び出し側の環境**で評価する。渡した後に新しい環境へ切り替える
    const bound = f.args.map((a, i) => {
      const r = declRange(a.range, a.line);
      return [a.name, { ...r, bits: resize(evalExpr(node.args[i], r.width), r.width) }];
    });

    const env = new Map(bound);
    // 戻り値とローカルは 0 から始める (Verilog では未定義だが 2 値しか無いので 0)
    const retR = declRange(f.range, f.line);
    env.set(f.name, { ...retR, bits: Array(retR.width).fill(CONST0) });
    for (const l of f.locals) {
      if (env.has(l.name)) {
        throw new CompileError(`${f.name}: '${l.name}' が引数と重複している`, l.line);
      }
      const r = declRange(l.range, l.line);
      env.set(l.name, { ...r, bits: Array(r.width).fill(CONST0) });
    }

    // ローカルの integer も for のループ変数。scope はいまの module のままにする
    // (書き換えると module の parameter や信号が引けなくなる)。値は unrollFor が
    // ループの前後で退避・復帰するので、外側に同名があっても壊れない
    for (const n of f.ints ?? []) loopVars.add(scope + n);

    const outer = funcEnv;
    funcEnv = env;
    let out;
    try {
      const end = runFuncStmts(f.body, envBits(env));
      out = end.get(f.name);
      if (!out) throw new CompileError(`function ${f.name} は戻り値を代入していない`, f.line);
    } finally {
      funcEnv = outer;
      funcDepth--;
    }
    return out;
  }

  /** 環境から「名前 → ネット配列」だけを取り出す (合流のときに扱いやすい形) */
  const envBits = (env) => new Map([...env].map(([k, v]) => [k, v.bits]));

  /** 走らせた結果のビット配列を funcEnv に書き戻す (以降の式が新しい値を読む) */
  function syncEnv(bits) {
    for (const [k, v] of bits) funcEnv.get(k).bits = v;
  }

  /** if / case の合流。触られていないビットには mux を作らない */
  function mergeBits(cond, a, b) {
    const out = new Map();
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      const av = a.get(k);
      const bv = b.get(k);
      out.set(k, av.map((n, i) => (n === bv[i] ? n : newGate('mux', [cond, n, bv[i]]))));
    }
    return out;
  }

  /**
   * for を elaborate 時に完全展開する。合成ツールと同じやり方。
   *
   * ループ変数は parameter と同じ表 (params) に入れる。おかげで本体の `q[i]` や
   * `d[7-i]` は「定数式の添字」としてそのまま解け、専用の仕組みが要らない。
   *
   * @param run 本体を走らせる関数 (always なら runStmts、function なら runFuncStmts)
   */
  function unrollFor(st, state, run) {
    const key = resolveScope(st.name) + st.name;
    if (!loopVars.has(key)) {
      throw new CompileError(
        `'${st.name}' は integer で宣言されていない (for のループ変数)`, st.line);
    }
    const had = params.has(key);
    const saved = params.get(key);
    let cur = state;
    try {
      params.set(key, constExpr(st.init));
      for (let n = 0; ; n++) {
        // 添字が変わると部分選択の幅も変わり得るので、幅のキャッシュを捨てる
        selfWidthCache.clear();
        if (constExpr(st.cond) === 0n) break;
        if (n >= MAX_UNROLL) {
          throw new CompileError(
            `for の繰り返しが ${MAX_UNROLL} 回を超えた (条件が定数で終わらない?)`, st.line);
        }
        cur = run(st.body, cur);
        params.set(key, constExpr(st.step));
      }
    } finally {
      selfWidthCache.clear();
      if (had) params.set(key, saved); else params.delete(key);
    }
    return cur;
  }

  /** function の本体を走らせる。state は「名前 → ネット配列」 */
  function runFuncStmts(stmts, state) {
    let cur = state;
    for (const st of stmts) {
      syncEnv(cur);                     // 右辺は「ここまでの結果」を読む
      if (st.type === 'ba') {
        const target = cur.get(st.lhs.name);
        if (!target) {
          throw new CompileError(
            `'${st.lhs.name}' は function の中で宣言されていない`, st.line);
        }
        const decl = funcEnv.get(st.lhs.name);
        if (!st.lhs.range) {
          cur.set(st.lhs.name, resize(evalExpr(st.rhs, target.length), target.length));
          continue;
        }
        // 部分代入。触ったビットだけ差し替える
        const { msb, lsb } = evalRange(st.lhs.range, st.line);
        if (msb < lsb) throw new CompileError(`降順の部分代入 [${msb}:${lsb}] は未対応`, st.line);
        const w = msb - lsb + 1;
        const src = resize(evalExpr(st.rhs, w), w);
        const next = [...target];
        for (let i = 0; i < w; i++) {
          const pos = lsb + i - decl.lsb;
          if (pos < 0 || pos >= next.length) {
            throw new CompileError(
              `${st.lhs.name}[${lsb + i}] は宣言範囲 [${decl.msb}:${decl.lsb}] の外`, st.line);
          }
          next[pos] = src[i];
        }
        cur.set(st.lhs.name, next);
        continue;
      }

      if (st.type === 'for') {
        cur = unrollFor(st, cur, runFuncStmts);
        continue;
      }

      if (st.type === 'if') {
        const cond = reduceOr(evalExpr(st.cond));
        const thenB = runFuncStmts(st.then, new Map(cur));
        syncEnv(cur);                   // else 側は if に入る前の値から始める
        const elseB = st.else ? runFuncStmts(st.else, new Map(cur)) : new Map(cur);
        cur = mergeBits(cond, thenB, elseB);
        continue;
      }

      if (st.type === 'case') {
        let cw = selfWidth(st.sel);
        for (const it of st.items) {
          for (const label of it.labels) cw = Math.max(cw, selfWidth(label));
        }
        const sel = evalExpr(st.sel, cw);
        const before = new Map(cur);
        let acc = st.default ? runFuncStmts(st.default, new Map(before)) : new Map(before);
        for (let k = st.items.length - 1; k >= 0; k--) {
          const it = st.items[k];
          syncEnv(before);
          let cond = null;
          for (const label of it.labels) {
            const hit = matchLabel(sel, label, cw, st.casez);
            cond = cond === null ? hit : newGate('or', [cond, hit]);
          }
          acc = mergeBits(cond, runFuncStmts(it.stmts, new Map(before)), acc);
        }
        cur = acc;
        continue;
      }

      throw new CompileError(`function の中に書けない文 '${st.type}'`, st.line);
    }
    syncEnv(cur);
    return cur;
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

      if (st.type === 'for') {
        cur = unrollFor(st, cur, runStmts);
        continue;
      }

      if (st.type === 'if') {
        const cond = reduceOr(evalExpr(st.cond));
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
            const hit = matchLabel(sel, label, cw, st.casez);
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

  /** 式の中に出てくる信号名を集める (どのイベント信号を見ているか判定するのに使う) */
  function refNames(e, out = []) {
    if (!e || typeof e !== 'object') return out;
    if (e.type === 'ref') { if (!e.path) out.push(e.name); return out; }
    for (const k of ['a', 'b', 'sel']) if (e[k]) refNames(e[k], out);
    if (e.parts) for (const p of e.parts) refNames(p, out);
    if (e.args) for (const a of e.args) refNames(a, out);   // 関数呼び出しの引数
    return out;
  }

  /**
   * always のイベントリストを「クロック」と「非同期リセット」に振り分ける。
   *
   * イベントが 1 つなら普通の同期回路。2 つなら片方が非同期リセットで、
   * **どちらがリセットかは本体の先頭の if がどの信号を見ているかで決める**。
   * Verilog もイベントリストの順番では決まらず、この形で書くのが決まりになっている:
   *
   *   always @(posedge clk or posedge rst)   if (rst)   q <= 0; else q <= d;
   *   always @(posedge clk or negedge rst_n) if (!rst_n) q <= 0; else q <= d;
   *
   * リセットが効いている条件は if の条件そのものなので、負論理リセット (!rst_n) も
   * そのまま通る。エッジの向き自体は使わない (連続時間を持たないモデルなので、
   * 「リセット条件が真のあいだ Q が上書きされる」ことだけを表現する)。
   */
  function splitReset(item) {
    const { edges } = item;

    if (edges.length === 1) {
      if (edges[0].kind !== 'posedge') {
        throw new CompileError('negedge は未対応 (posedge のみ)', item.line);
      }
      return { clkName: edges[0].name, rstCond: null, rstStmts: null, body: item.stmts };
    }

    const st = item.stmts.length === 1 ? item.stmts[0] : null;
    if (!st || st.type !== 'if') {
      throw new CompileError(
        '非同期リセット付きの always は、本体全体を if (リセット条件) ... else ... にする必要がある',
        item.line);
    }

    const inCond = new Set(refNames(st.cond));
    const hits = edges.filter((e) => inCond.has(e.name));
    if (hits.length !== 1) {
      const names = edges.map((e) => e.name).join(' と ');
      throw new CompileError(
        `if の条件が ${names} のどちらを見ているか決まらない`
        + ' (非同期リセット側の信号だけを条件に書く)', st.line);
    }
    const rstEdge = hits[0];
    const clkEdge = edges.find((e) => e !== rstEdge);
    if (clkEdge.kind !== 'posedge') {
      throw new CompileError(
        `クロック '${clkEdge.name}' は posedge でなければならない (negedge は未対応)`, item.line);
    }
    const rstSig = lookup(rstEdge.name, item.line);
    if (rstSig.width !== 1) {
      throw new CompileError(`非同期リセット '${rstEdge.name}' は 1 ビットでなければならない`, item.line);
    }

    return {
      clkName: clkEdge.name,
      rstCond: reduceOr(evalExpr(st.cond)),
      rstStmts: st.then,
      body: st.else ?? [],          // else が無ければ「リセット以外では保持」
    };
  }

  /** ネット列どうしを接続する (buf ゲートで橋渡し) */
  function connectNets(lhs, rhsBits, what, line) {
    const src = resize(rhsBits, lhs.length);
    lhs.forEach((q, i) => {
      setDriver(q, what, line);
      const gate = { op: 'buf', out: q, in: [src[i]] };
      gates.push(gate);
      gateOf.set(q, gate);   // bufRoot がたどれるように記録する
    });
  }

  /** 左辺のネット列に右辺を接続する */
  function connect(lhsNode, rhsBits, what, line) {
    connectNets(refBits(lhsNode), rhsBits, what, line);
  }

  /**
   * buf をたどって元のネットを返す。ポート接続は buf で橋渡しするので、
   * 親のクロックと子の clk ポートは別ネットになる。クロックの同一性はここで見る。
   */
  function bufRoot(net) {
    let n = net;
    for (let i = 0; i < 64; i++) {          // 念のため上限を切る
      const g = gateOf.get(n);
      if (!g || g.op !== 'buf') return n;
      n = g.in[0];
    }
    return n;
  }

  // ---- always @(*) (組合せ回路) ------------------------------------------------
  //
  // レジスタ用の always とは別物なので、別の経路で落とす。
  //
  //   代入は blocking (`=`) なので、後の文は前の文の結果を読む
  //     → function の展開に使っている runFuncStmts がそのまま使える
  //   保持は無い。代入されない経路があればラッチになる
  //     → この処理系はラッチを持たないので、作らずにエラーにする
  //
  // 環境の初期値は**その信号自身のネット**にしておく。すると「代入前に読む」と
  // 自分のネットが出てきて、結果の中に残る。それがそのままラッチの判定になる
  // (自分の値に依存する組合せ出力 = 保持している、ということ)。

  /** 文の並びから代入先の名前を集める (分岐の中も見る) */
  function combTargets(stmts, out = new Set()) {
    for (const st of stmts) {
      if (st.type === 'ba') out.add(st.lhs.name);
      else if (st.type === 'for') combTargets(st.body, out);
      else if (st.type === 'if') {
        combTargets(st.then, out);
        if (st.else) combTargets(st.else, out);
      } else if (st.type === 'case') {
        for (const it of st.items) combTargets(it.stmts, out);
        if (st.default) combTargets(st.default, out);
      }
    }
    return out;
  }

  /** 文の並びが読んでいる名前を集める (感度リストの取りこぼしを見るため) */
  function combReads(stmts, out = []) {
    for (const st of stmts) {
      if (st.type === 'ba') {
        refNames(st.rhs, out);
        if (st.lhs.range) { refNames(st.lhs.range.msb, out); refNames(st.lhs.range.lsb, out); }
      } else if (st.type === 'for') combReads(st.body, out);
      else if (st.type === 'if') {
        refNames(st.cond, out);
        combReads(st.then, out);
        if (st.else) combReads(st.else, out);
      } else if (st.type === 'case') {
        refNames(st.sel, out);
        for (const it of st.items) {
          for (const l of it.labels) refNames(l, out);
          combReads(it.stmts, out);
        }
        if (st.default) combReads(st.default, out);
      }
    }
    return out;
  }

  function runCombAlways(item) {
    const names = [...combTargets(item.stmts)];
    if (names.length === 0) {
      throw new CompileError('always @(*) の中に代入が無い', item.line);
    }

    const targets = new Map();
    for (const name of names) {
      const s = lookup(name, item.line);
      if (s.dir === 'input') {
        throw new CompileError(`入力ポート '${s.name}' は駆動できない`, item.line);
      }
      if (s.kind !== 'reg') {
        throw new CompileError(
          `always @(*) の代入先 '${s.name}' は reg で宣言する (wire は assign で駆動する)`,
          item.line);
      }
      targets.set(name, s);
    }

    // 感度リストを書いたなら、読んでいる信号が全部並んでいること。
    // 足りないと実機と食い違う (この処理系では列挙を無視するので値は正しく出るが、
    // 「書いたとおりに読めない Verilog」を通してしまうことになる)
    if (item.sens) {
      const listed = new Set(item.sens);
      const missing = [...new Set(combReads(item.stmts))]
        .filter((n) => !listed.has(n) && !targets.has(n) && signals.has(resolveScope(n) + n));
      if (missing.length > 0) {
        throw new CompileError(
          `always @(…) の感度リストに ${missing.join(', ')} が足りない `
          + '(@(*) と書けば取りこぼさない)', item.line);
      }
    }

    const savedEnv = funcEnv;
    funcEnv = new Map();
    for (const [name, s] of targets) {
      funcEnv.set(name, { bits: [...s.bits], msb: s.msb, lsb: s.lsb });
    }
    let out;
    try {
      out = runFuncStmts(item.stmts, envBits(funcEnv));
    } finally {
      funcEnv = savedEnv;
    }

    // 代入先自身のネットが結果に残っていたら「前の値を保っている」= ラッチ。
    // どの信号のネットで引っかかったかまで返すと、原因が 2 通りに切り分けられる:
    //   自分自身 … 代入されない経路がある (else / default の書き忘れ)
    //   別の名前 … その名前を代入より前に読んでいる (文の順番)
    const ownOf = new Map();                    // ネット → 代入先の名前
    for (const s of targets.values()) s.bits.forEach((n) => ownOf.set(n, s.name));
    const memo = new Map();
    const heldBy = (n) => {
      if (ownOf.has(n)) return n;
      const hit = memo.get(n);
      if (hit !== undefined) return hit;
      memo.set(n, -1);                          // 途中に循環があっても止まる
      const g = gateOf.get(n);
      let r = -1;
      if (g) for (const x of g.in) { r = heldBy(x); if (r >= 0) break; }
      memo.set(n, r);
      return r;
    };

    // 駆動するのは**このブロックが触ったビットだけ**。信号まるごとではない。
    // `always @(*) z[i] = …;` を i ごとに分けて書くのは正しい Verilog で、
    // 各ブロックは自分のビットだけを駆動する (残りは別のブロックが駆動する)。
    // 種のまま残っているビット = 一度も触っていない、として見分ける。
    for (const [name, s] of targets) {
      const bits = out.get(name);
      for (let i = 0; i < bits.length; i++) {
        if (bits[i] === s.bits[i]) continue;             // このブロックでは触っていない
        const held = heldBy(bits[i]);
        if (held >= 0) {
          throw new CompileError(
            held === s.bits[i]
              ? `always @(*) の '${nets[held].name}' に、代入されない経路がある `
                + '(ラッチになる)。先に既定値を代入するか、else / default を書いてください'
              : `always @(*) の '${nets[s.bits[i]].name}' が '${nets[held].name}' を`
                + `代入より前に読んでいる (ラッチになる)。'${nets[held].name}' への代入を`
                + '先に書いてください',
            item.line);
        }
        connectNets([s.bits[i]], [bits[i]], 'always @(*)', item.line);
      }
    }
  }

  // ---- 項目の処理 ----------------------------------------------------------
  let clock = null;        // クロックのルートネット (buf をたどった先)
  let clockName = null;    // エラー表示用の名前

  function itemPass(mod, prefix, isTop, depth, stack) {
    for (const item of mod.items) runItem(item, mod, prefix, isTop, depth, stack);
  }

  /**
   * generate ブロックを 1 個展開する。tag が null ならスコープを作らずに
   * 親の名前空間へそのまま出す (generate / endgenerate 自体と、ラベルの無い枝)。
   *
   * 中の宣言はここで先に済ませるので、ブロックの中での前方参照は module の直下と
   * 同じように効く。scopeBase は動かさない ― ブロックの中から module の信号が
   * 見えるのは、resolveScope が scopeBase まで外へ辿るからである。
   */
  function runGenBlock(blk, mod, prefix, isTop, depth, stack, tag) {
    const child = tag === null ? prefix : `${prefix}${tag}.`;
    const saved = scope;
    scope = child;
    try {
      declItems(blk.items, child);
      for (const it of blk.items) runItem(it, mod, child, isTop, depth, stack);
    } finally {
      scope = saved;
    }
  }

  function runItem(item, mod, prefix, isTop, depth, stack) {
    if (item.type === 'decl') {
      // `wire t = 式;` の右辺。宣言そのものは declPass で済んでいるので、
      // ここは assign 文とまったく同じ扱いにする
      for (const init of item.inits ?? []) {
        const lhs = { type: 'ref', name: init.name, range: null, line: init.line };
        const s = lookup(init.name, init.line);
        if (s.dir === 'input') {
          throw new CompileError(`入力ポート '${s.name}' は駆動できない`, init.line);
        }
        connect(lhs, evalExpr(init.expr, refBits(lhs).length), '宣言の代入', init.line);
      }
      return;
    }
    // function は宣言だけ。回路になるのは呼び出された場所 (declPass で集めてある)
    if (item.type === 'func') return;
    // integer / genvar は展開時の整数。declPass で名前を登録してある
    if (item.type === 'intdecl') return;

    // ---- generate。どの項目を作るかを定数式で決めて、選んだものを流し込む ----
    if (item.type === 'genblock') {
      runGenBlock(item, mod, prefix, isTop, depth, stack, item.label);
      return;
    }

    if (item.type === 'genfor') {
      // 添字は for のループ変数とまったく同じ経路 (params に入れて定数式で解く)
      const key = resolveScope(item.name) + item.name;
      if (!loopVars.has(key)) {
        throw new CompileError(
          `'${item.name}' は genvar で宣言されていない (generate の for の添字)`, item.line);
      }
      const had = params.has(key);
      const savedVal = params.get(key);
      try {
        params.set(key, constExpr(item.init));
        for (let n = 0; ; n++) {
          selfWidthCache.clear();      // 添字が変わると部分選択の幅も変わり得る
          if (constExpr(item.cond) === 0n) break;
          if (n >= MAX_UNROLL) {
            throw new CompileError(
              `generate の for が ${MAX_UNROLL} 回を超えた (条件が定数で終わらない?)`, item.line);
          }
          // ラベルは g[0] / g[1] … になる (Verilog の名前の付け方と同じ)
          runGenBlock(item.body, mod, prefix, isTop, depth, stack,
            `${item.body.label}[${params.get(key)}]`);
          params.set(key, constExpr(item.step));
        }
      } finally {
        selfWidthCache.clear();
        if (had) params.set(key, savedVal); else params.delete(key);
      }
      return;
    }

    if (item.type === 'genif') {
      const taken = constExpr(item.cond) !== 0n ? item.then : item.else;
      if (taken) runGenBlock(taken, mod, prefix, isTop, depth, stack, taken.label);
      return;
    }

    if (item.type === 'gencase') {
      const sel = constExpr(item.sel);
      let taken = null;
      for (const it of item.items) {
        if (it.labels.some((l) => constExpr(l) === sel)) { taken = it.body; break; }
      }
      taken ??= item.default;
      if (taken) runGenBlock(taken, mod, prefix, isTop, depth, stack, taken.label);
      return;
    }

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
      return;
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
      return;
    }

    if (item.type === 'always' && item.comb) {
      runCombAlways(item);
      return;
    }

    if (item.type === 'always') {
      const { clkName, rstCond, rstStmts, body } = splitReset(item);

      const clk = lookup(clkName, item.line);
      if (clk.width !== 1) throw new CompileError(`クロック '${clkName}' は 1 ビットでなければならない`, item.line);
      // 階層をまたぐと親の clk と子の clk ポートは別ネットになるので、
      // buf をたどった元で同一性を見る
      const clkRoot = bufRoot(clk.bits[0]);
      if (clock !== null && clock !== clkRoot) {
        throw new CompileError(`複数クロックは未対応 ('${clockName}' と '${clk.name}')`, item.line);
      }
      clock = clkRoot;
      clockName = clk.name;
      clk.isClock = true;

      // 文を上から順に辿り、レジスタの各ビットについて「次の値」を組み立てる。
      // 分岐は then 側と else 側を別々に走らせてから mux でマージする。
      // どちらの経路でも代入されなかったビットは Q そのもの (= 保持) になる。
      const next = runStmts(body, new Map());
      const rstNext = rstStmts ? runStmts(rstStmts, new Map()) : null;

      // リセット側だけで代入されるビットもあるので、両方のキーを見る
      const touched = new Set([...next.keys(), ...(rstNext ? rstNext.keys() : [])]);
      for (const qn of touched) {
        const line = regLine.get(qn) ?? item.line;
        setDriver(qn, `always @(posedge ${clockName})`, line);
        const dNormal = next.get(qn) ?? qn;      // エッジでの次の値 (無ければ保持)

        if (rstCond === null) {
          regs.push({ q: qn, d: dNormal, rst: null, rstD: null, qAsync: null, line });
          continue;
        }
        const rstD = rstNext.get(qn) ?? qn;      // リセットで触られないビットは保持
        regs.push({
          q: qn,
          // エッジでもリセットが優先する
          d: newGate('mux', [rstCond, rstD, dNormal]),
          rst: rstCond,
          rstD,
          // 非同期部分: クロックを待たずに Q を上書きする値 (eval で書く)
          qAsync: newGate('mux', [rstCond, rstD, qn]),
          line,
        });
      }
      return;
    }

    if (item.type === 'inst') {
      instantiate(item, prefix, depth, stack);
      return;
    }

    throw new CompileError(`未対応の項目 '${item.type}'`, item.line);
  }

  /**
   * インスタンスを展開する (階層の平坦化)。
   *
   *   1. 子の宣言だけ先に処理して、ポートのネットを作る
   *   2. 親のスコープで接続式を評価し、buf でポートに橋渡しする
   *   3. 子の中身を子のスコープで展開する (入れ子はここで再帰)
   *
   * 2 を 3 より先にやるのが要点。子の always がクロックの同一性を見るとき、
   * 先に buf がつながっていないと親のクロックまでたどれない。
   */
  function instantiate(item, prefix, depth, stack) {
    if (depth >= MAX_DEPTH) {
      throw new CompileError(`インスタンスの入れ子が深すぎる (上限 ${MAX_DEPTH})`, item.line);
    }
    const sub = modules.get(item.module);
    if (!sub) throw new CompileError(`module '${item.module}' が見つからない`, item.line);
    if (stack.includes(item.module)) {
      throw new CompileError(
        `module '${item.module}' が自分自身を含んでいる (${[...stack, item.module].join(' → ')})`,
        item.line);
    }

    const childPrefix = `${prefix}${item.name}.`;
    if (instanceNames.has(childPrefix)) {
      throw new CompileError(`インスタンス名 '${item.name}' が重複している`, item.line);
    }
    instanceNames.add(childPrefix);

    // --- 1. 子の宣言 ---
    // --- 0. パラメータ ---
    // 指定式は「親のスコープで」評価する (親のパラメータを渡せる)。
    // 宣言より先に決めないと、[WIDTH-1:0] のような幅が数にならない。
    setupParams(sub, childPrefix, item.params.map((o) => ({
      name: o.name, value: constExpr(o.expr), line: item.line,
    })));

    declPass(sub, childPrefix);

    // --- 2. ポート接続 (式は親のスコープで評価する) ---
    const named = item.ports.length > 0 && item.ports[0].name !== null;
    if (!named && item.ports.length > sub.portOrder.length) {
      throw new CompileError(
        `${item.module} のポートは ${sub.portOrder.length} 個だが ${item.ports.length} 個つないでいる`,
        item.line);
    }
    const seen = new Set();
    for (const [i, conn] of item.ports.entries()) {
      const pname = conn.name ?? sub.portOrder[i];
      if (!sub.portOrder.includes(pname)) {
        throw new CompileError(`${item.module} にポート '${pname}' は無い`, item.line);
      }
      if (seen.has(pname)) {
        throw new CompileError(`ポート '${pname}' を 2 回つないでいる`, item.line);
      }
      seen.add(pname);
      if (!conn.expr) continue;                       // 未接続

      const port = signals.get(childPrefix + pname);
      if (port.dir === 'input') {
        connectNets(port.bits, evalExpr(conn.expr, port.width),
          `${item.name} の入力ポート ${pname}`, item.line);
      } else if (port.dir === 'output') {
        if (conn.expr.type !== 'ref') {
          throw new CompileError(
            `出力ポート '${pname}' には信号名をつなぐ (式は駆動できない)`, item.line);
        }
        connectNets(refBits(conn.expr), port.bits,
          `${item.name} の出力ポート ${pname}`, item.line);
      } else {
        throw new CompileError(`ポート '${pname}' の方向が宣言されていない`, item.line);
      }
    }

    // --- 3. 子の中身 ---
    const saved = scope;
    const savedBase = scopeBase;
    scope = childPrefix;
    scopeBase = childPrefix;           // ここから外へは名前を辿らない (module の境界)
    itemPass(sub, childPrefix, false, depth + 1, [...stack, item.module]);
    scope = saved;
    scopeBase = savedBase;
  }

  // ---- 展開の開始 ----------------------------------------------------------
  setupParams(mod, '', []);          // top は既定値のまま
  declPass(mod, '');
  // top の input だけは外部から与えられるので「駆動済み」とみなす
  for (const s of signals.values()) {
    if (s.isTop && s.dir === 'input') s.bits.forEach((n) => drivers.set(n, '入力ポート'));
  }
  itemPass(mod, '', true, 0, [mod.name]);

  // ---- 未駆動ネットの検査 ---------------------------------------------------
  // top の入力ポートだけは外から与えられるので対象外。子モジュールの入力ポートは
  // 親がつないでいなければ本当に未駆動なので、ここで拾って 0 に固定する
  // (未接続のポートに気づけるように警告に出す)。
  const undriven = [];
  for (const s of signals.values()) {
    if (s.isTop && s.dir === 'input') continue;
    s.bits.forEach((n) => {
      if (!drivers.has(n)) undriven.push(nets[n].name);
    });
  }
  if (undriven.length > 0) {
    // 未駆動は 0 に固定して継続する (途中まで書いた RTL でも動かせるようにする)
    for (const s of signals.values()) {
      if (s.isTop && s.dir === 'input') continue;
      s.bits.forEach((n) => {
        if (!drivers.has(n)) {
          drivers.set(n, '未駆動 (0 固定)');
          const gate = { op: 'buf', out: n, in: [CONST0] };
          gates.push(gate);
          gateOf.set(n, gate);
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
