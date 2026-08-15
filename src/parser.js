// Verilog サブセット → AST
//
// 式の優先順位 (低い順):
//   ?:  ||  &&  |  ^ ~^ ^~  &  == !=  < <= > >=  << >>  + -
//   単項 (~ - + ! & | ^ ~^ ^~)  primary
// これは Verilog 本来の優先順位と一致する。論理演算子 (|| &&) はビット演算より
// 弱く、等価 (== !=) は関係 (< など) より弱く、関係はシフトより弱く、シフトは
// 算術より弱い。
//
// '<=' はノンブロッキング代入と「以下」の両方に使われる。always 文の代入は
// parseLValue で左辺を読んでから expect('<=') で食べるので、式の中に出てきた
// '<=' だけが関係演算子として解釈される (Verilog も同じ解き方)。

import { lex } from './lexer.js';
import { CompileError } from './errors.js';

const GATE_PRIMITIVES = new Set(['and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buf']);
// module 本体に書けそうで書けないもの。名前を出して断る。こうしないと
// 「<モジュール名> <インスタンス名>」に見えて、遠いところでエラーになる
const UNSUPPORTED_ITEMS = new Set([
  'task', 'defparam', 'specify',
  'always_comb', 'always_ff', 'always_latch', 'real', 'time',
]);
const DIRECTIONS = new Set(['input', 'output']);
const NET_KINDS = new Set(['wire', 'reg']);
// signed / unsigned は宣言の中で幅の前に来る (`wire signed [3:0] x;`)。予約語として
// 知らないと識別子に見えてしまい、次の '[' で見当違いのエラーになる
// module 本体にしか出てこない語。function の中で出会ったら endfunction の書き忘れ
const FUNC_BODY_STOP = new Set([
  'endmodule', 'module', 'assign', 'always', 'function', 'task', 'input', 'output', 'inout',
]);
const SIGNEDNESS = {
  signed: 'signed は未対応 (すべて符号なしとして扱う)',
  unsigned: 'unsigned は既定なので、書かずに省いてください',
};

export function parse(src) {
  const toks = lex(src);
  let p = 0;

  const peek = (k = 0) => toks[Math.min(p + k, toks.length - 1)];
  const at = (v) => peek().value === v && peek().type !== 'num';
  const err = (msg) => new CompileError(msg, peek().line);

  const next = () => toks[p++];
  const eat = (v) => (at(v) ? (p++, true) : false);
  const expect = (v) => {
    if (!at(v)) throw err(`'${v}' が必要ですが '${peek().value}' がありました`);
    return next();
  };
  const expectIdent = () => {
    if (peek().type !== 'ident') throw err(`識別子が必要ですが '${peek().value}' がありました`);
    return next().value;
  };
  /** 宣言に付いた signed / unsigned を名指しで断る。幅の前に呼ぶ */
  function rejectSignedness() {
    const t = peek();
    if (t.type === 'ident' && SIGNEDNESS[t.value]) throw err(SIGNEDNESS[t.value]);
  }
  // ---- [msb:lsb] / [n] ----------------------------------------------------
  // 添字は式で受ける。`[WIDTH-1:0]` のようにパラメータが入るので、数に落とすのは
  // elaborate 側 (パラメータの値が決まってから)。
  function parseRange() {
    if (!at('[')) return null;
    const line = peek().line;
    expect('[');
    const a = parseExpr();
    if (eat(':')) {
      const b = parseExpr();
      expect(']');
      return { msb: a, lsb: b, single: false, line };
    }
    expect(']');
    return { msb: a, lsb: a, single: true, line };
  }

  // ---- 式 ----------------------------------------------------------------
  function parseExpr() {
    const cond = parseLogOr();
    if (eat('?')) {
      const a = parseExpr();
      expect(':');
      const b = parseExpr();
      return { type: 'tern', sel: cond, a, b };
    }
    return cond;
  }

  /** ops は同じ優先順位で左結合する演算子 ('+' と '-' のように複数並ぶ) */
  function binaryLevel(ops, sub) {
    const list = Array.isArray(ops) ? ops : [ops];
    return () => {
      let left = sub();
      for (;;) {
        const op = list.find((o) => at(o));
        if (!op) return left;
        const line = next().line;
        left = { type: 'bin', op, a: left, b: sub(), line };
      }
    };
  }

  // * / % は + - より強く結合する (Verilog と同じ)
  const parseMul = binaryLevel(['*', '/', '%'], () => parseUnary());
  const parseAdd = binaryLevel(['+', '-'], parseMul);
  const parseShift = binaryLevel(['<<', '>>'], parseAdd);
  const parseRel = binaryLevel(['<=', '>=', '<', '>'], parseShift);
  const parseEq = binaryLevel(['==', '!='], parseRel);
  const parseAnd = binaryLevel('&', parseEq);
  const parseXor = binaryLevel(['^', '~^', '^~'], parseAnd);
  const parseOr = binaryLevel('|', parseXor);
  const parseLogAnd = binaryLevel('&&', parseOr);
  const parseLogOr = binaryLevel('||', parseLogAnd);

  // 前置に置ける演算子。& | ^ ~^ ^~ はリダクション (全ビットを 1 個に畳む)。
  // 中置にも出てくる記号だが、オペランドが来る位置に現れたら必ずリダクション。
  // `~&a` `~|a` は `~` と `&` に割れても `~(&a)` になり、結果が 1 ビットなので
  // NAND / NOR として正しく落ちる (専用トークンは要らない)。
  const PREFIX = ['~', '-', '!', '&', '|', '^', '~^', '^~'];

  function parseUnary() {
    const t = peek();
    if (t.type === 'punct' && PREFIX.includes(t.value)) {
      next();
      return { type: 'un', op: t.value, a: parseUnary(), line: t.line };
    }
    if (at('+')) {           // 単項 + は Verilog でも何もしない
      next();
      return parseUnary();
    }
    return parsePrimary();
  }

  /**
   * いまの '[' に対応する ']' の次が '.' か。
   * `a[3]` (ビット選択) と `b[3].t` (階層の添字) を見分けるための先読み。
   * 添字の中にさらに '[' が来ることがあるので、深さを数えて対応を取る。
   */
  function closingBracketThenDot() {
    let depth = 0;
    for (let k = 0; ; k++) {
      const tk = peek(k);
      if (tk.type === 'eof') return false;
      if (tk.value === '[') depth++;
      else if (tk.value === ']' && --depth === 0) return peek(k + 1).value === '.';
    }
  }

  function parsePrimary() {
    const t = peek();

    if (t.type === 'num') {
      next();
      // mask は casez のラベルで「比較しない桁」。それ以外の場所では elaborate が断る
      return {
        type: 'num', width: t.width, bits: t.bits, mask: t.mask ?? 0n,
        unsized: !!t.unsized, line: t.line,
      };
    }

    if (eat('(')) {
      const e = parseExpr();
      expect(')');
      return e;
    }

    if (at('{')) {
      const line = next().line;
      const first = parseExpr();
      // {n{…}} は繰り返し連接。'{' が続いたら first は中身ではなく繰り返し回数。
      // 1 個目を読むまで区別が付かないので、読んでから振り分ける
      if (at('{')) {
        next();
        const parts = [parseExpr()];
        while (eat(',')) parts.push(parseExpr());
        expect('}');
        expect('}');
        return { type: 'repeat', count: first, parts, line };
      }
      const parts = [first];
      while (eat(',')) parts.push(parseExpr());
      expect('}');
      return { type: 'concat', parts, line };
    }

    if (t.type === 'ident') {
      next();
      // 識別子のすぐ後ろに '(' が来たら関数呼び出し。式の中でここが曖昧になる
      // 書き方は他に無い (ゲートのインスタンス化は文の位置にしか出てこない)
      if (at('(')) {
        next();
        const args = [];
        if (!at(')')) {
          args.push(parseExpr());
          while (eat(',')) args.push(parseExpr());
        }
        expect(')');
        return { type: 'call', name: t.value, args, line: t.line };
      }
      // 階層参照。`u0.q` / `bits[3].p` のように、インスタンスや generate ブロックの
      // 中の信号を外から読む。名前は完全修飾名でそのまま signals のキーになるが、
      // 添字が genvar のこともある (`bits[i-1].s`) ので、数に落とすのは elaborate 側。
      // ビット選択の '[' と紛らわしいので、']' の次が '.' かどうかで見分ける。
      if (at('.') || (at('[') && closingBracketThenDot())) {
        const path = [{ name: t.value, index: null }];
        for (;;) {
          if (at('[')) {
            next();
            path[path.length - 1].index = parseExpr();
            expect(']');
          }
          if (!eat('.')) break;
          path.push({ name: expectIdent(), index: null });
          if (!at('.') && !(at('[') && closingBracketThenDot())) break;
        }
        return { type: 'ref', path, range: parseRange(), line: t.line };
      }
      return { type: 'ref', name: t.value, range: parseRange(), line: t.line };
    }

    throw err(`式が必要ですが '${t.value}' がありました`);
  }

  function parseLValue() {
    const line = peek().line;
    const name = expectIdent();
    return { type: 'ref', name, range: parseRange(), line };
  }

  // ---- module 本体の項目 ---------------------------------------------------
  function parseDecl() {
    const line = peek().line;
    let dir = null;
    let kind = null;
    if (DIRECTIONS.has(peek().value)) dir = next().value;
    if (NET_KINDS.has(peek().value)) kind = next().value;
    if (!dir && !kind) throw err('宣言が必要');
    rejectSignedness();
    const range = parseRange();
    // `wire t = a & b;` は宣言と assign を 1 行で書いたもの (net declaration assignment)。
    // 名前ごとに書けるので `wire x = a, y = b;` も通す。
    // reg に付けたら初期値の意味になってしまうので、そこは名指しで断る。
    const names = [];
    const inits = [];
    do {
      const nm = expectIdent();
      names.push(nm);
      if (!at('=')) continue;
      const iline = next().line;
      if (kind === 'reg') {
        throw err(`reg '${nm}' の宣言に初期値は書けない (initial は未対応)`);
      }
      inits.push({ name: nm, expr: parseExpr(), line: iline });
    } while (eat(','));
    expect(';');
    return { type: 'decl', dir, kind, range, names, inits, line };
  }

  /**
   * parameter / localparam の宣言。値は定数式で、elaborate が順に評価する。
   *   parameter WIDTH = 8, DEPTH = 4;
   *   localparam TOP = WIDTH - 1;
   * localparam はインスタンス化のときに差し替えられない点だけが違う。
   */
  function parseParamDecl() {
    const line = peek().line;
    const local = next().value === 'localparam';
    if (at('[')) throw err('parameter の幅指定は未対応 (値の大きさで決まる)');
    const items = [];
    do {
      const name = expectIdent();
      expect('=');
      items.push({ name, expr: parseExpr(), local, line });
    } while (eat(','));
    expect(';');
    return { type: 'param', items, line };
  }

  /**
   * #( … ) の中身。モジュール側は宣言 (`#(parameter W = 8)`)、
   * インスタンス側は指定 (`#(.W(4))` / `#(4)`) で形が違うので mode で分ける。
   */
  function parseParamList(mode) {
    expect('#');
    expect('(');
    const out = [];
    if (!at(')')) {
      const named = mode === 'decl' ? true : at('.');
      do {
        if (mode === 'decl') {
          eat('parameter');                       // ANSI 形式では省略できる
          const name = expectIdent();
          expect('=');
          out.push({ name, expr: parseExpr(), local: false, line: peek().line });
        } else {
          if (named !== at('.')) throw err('パラメータ指定は名前指定と順番指定を混ぜられない');
          if (named) {
            expect('.');
            const name = expectIdent();
            expect('(');
            out.push({ name, expr: parseExpr() });
            expect(')');
          } else {
            out.push({ name: null, expr: parseExpr() });
          }
        }
      } while (eat(','));
    }
    expect(')');
    return out;
  }

  // ---- always の中の文 -----------------------------------------------------
  //
  // 文は入れ子になるので、フラットな列ではなく木で返す:
  //   { type:'nb',   lhs, rhs }              … lhs <= rhs
  //   { type:'if',   cond, then:[], else }   … else は文の列か null
  //   { type:'case', sel, items:[{labels,stmts}], default }

  /**
   * function の宣言。戻り値は関数名そのものへの代入で決まる (Verilog の決まり)。
   *
   *   function [7:0] add1(input [7:0] a);
   *     reg [7:0] t;          … ローカル変数
   *     begin
   *       t = a + 1;          … ブロッキング代入
   *       add1 = t;           … 関数名に入れた値が戻り値
   *     end
   *   endfunction
   *
   * 引数は ANSI 形式 (括弧の中に input) だけ。時間制御は Verilog の仕様上そもそも
   * 書けないので、本体は必ず組合せ回路になる = このコンパイラの表現範囲に収まる。
   */
  function parseFunction() {
    const line = expect('function').line;
    if (at('automatic') || at('static')) throw err(`function の ${peek().value} は未対応`);
    rejectSignedness();
    const range = parseRange();          // 省略時は 1 ビット
    const name = expectIdent();

    const args = [];
    if (eat('(')) {
      if (at(')')) throw err('function には引数が 1 つ以上必要');
      do {
        if (!at('input')) throw err('function の引数は input だけ');
        next();
        rejectSignedness();
        const arange = parseRange();
        args.push({ name: expectIdent(), range: arange, line: peek().line });
        // input a, b; のようにまとめて書く形も許す
        while (at(',') && peek(1).type === 'ident' && !at2Input()) {
          next();
          args.push({ name: expectIdent(), range: arange, line: peek().line });
        }
      } while (eat(','));
      expect(')');
    }
    expect(';');
    if (args.length === 0) {
      throw err('引数を括弧の中に input で書く (function f(input a); の形。旧形式は未対応)');
    }

    // ローカル変数の宣言。本体より先にまとめて書く。integer は for のループ変数
    const locals = [];
    const ints = [];
    while (at('reg') || at('wire') || at('integer')) {
      if (at('integer')) { ints.push(...parseIntDecl().names); continue; }
      const kind = next().value;
      rejectSignedness();
      const lrange = parseRange();
      const names = [expectIdent()];
      while (eat(',')) names.push(expectIdent());
      expect(';');
      for (const n of names) locals.push({ name: n, range: lrange, kind, line });
    }

    // begin...end で囲んでも囲まなくてもよいので parseStmtBlock で読む。
    // module 本体にしか出てこない語が来たら endfunction の書き忘れ ― ここで止めないと
    // `assign` を代入の左辺として読んでしまい、原因から遠いエラーになる
    const body = [];
    while (!at('endfunction')) {
      if (peek().type === 'eof' || FUNC_BODY_STOP.has(peek().value)) {
        throw err("'endfunction' が見つからない");
      }
      body.push(...parseStmtBlock('function'));
    }
    expect('endfunction');
    if (body.length === 0) throw err(`function ${name} の中身が空`);
    // 戻り値は「関数名への代入」なので、1 度も代入していなければ書き間違い。
    // 実行時ではなくここで見るのは、分岐の片側だけの代入は正しい形だから
    if (!assignsTo(body, name)) {
      throw err(`function ${name} は戻り値 (${name} への代入) がどこにも無い`);
    }
    return { type: 'func', name, range, args, locals, ints, body, line };
  }

  /** 文の列のどこかで name に代入しているか */
  function assignsTo(stmts, name) {
    return stmts.some((st) => {
      if (st.type === 'ba' || st.type === 'nb') return st.lhs.name === name;
      if (st.type === 'if') {
        return assignsTo(st.then, name) || (st.else ? assignsTo(st.else, name) : false);
      }
      if (st.type === 'block') return assignsTo(st.stmts, name);
      if (st.type === 'for' || st.type === 'while' || st.type === 'repeat_stmt') {
        return assignsTo(st.body, name);
      }
      if (st.type === 'case') {
        return st.items.some((it) => assignsTo(it.stmts, name))
          || (st.default ? assignsTo(st.default, name) : false);
      }
      return false;
    });
  }

  /** 次の ',' の後ろが input かどうか (引数をまとめて書く形の判定用) */
  const at2Input = () => peek(1).value === 'input';

  /**
   * begin...end なら中の文の列、そうでなければ 1 文だけの列。
   * ctx はブロッキング代入 (`=`) で書く場所の名前 ('function' / 'always @(*)')。
   * null ならノンブロッキング代入 (`<=`) の always ブロック。取り違えは名指しで断る。
   */
  function parseStmtBlock(ctx = null) {
    if (eat('begin')) {
      // 名前付きブロックはブロック内の宣言と disable のためのもの。どちらも無い
      if (at(':')) {
        throw err('文の begin にラベルは書けない (generate のブロックのラベルとは別物)');
      }
      const list = [];
      while (!at('end')) {
        // endmodule / endfunction もここで止める。止めないと次の文の左辺として
        // 読んでしまい、「'<=' が必要」のような原因から遠いエラーになる
        if (peek().type === 'eof' || at('endmodule') || at('endfunction')) {
          throw err("'end' が見つからない");
        }
        list.push(parseStmt(ctx));
      }
      expect('end');
      return list;
    }
    return [parseStmt(ctx)];
  }

  function parseStmt(ctx = null) {
    // 入れ子の begin … end。文が並ぶ所ならどこにでも置ける (ループの本体で書きがち)
    if (at('begin')) return { type: 'block', stmts: parseStmtBlock(ctx), line: peek().line };
    if (at('if')) return parseIf(ctx);
    if (at('for')) return parseFor(ctx);
    if (at('while')) return parseWhile(ctx);
    if (at('repeat')) return parseRepeat(ctx);
    // forever は終わりが定数に決まらないので展開できない
    if (at('forever')) throw err('forever は未対応 (繰り返しは回数が定数に決まるものだけ)');
    if (at('case') || at('casez')) return parseCase(ctx);
    // casex は x も don't care にする。x を値として持たないので z との差が出ず、
    // 「x なら何でも一致」を装うことになるので断る (casez なら z / ? で足りる)
    if (at('casex')) throw err('casex は未対応 (x を値として扱わない。casez を使う)');
    const line = peek().line;
    const lhs = parseLValue();
    // function と always @(*) はレジスタではなくその場で値が決まるので blocking 代入。
    if (ctx) {
      if (at('<=')) throw err(`${ctx} の中はブロッキング代入 = を使う`);
      expect('=');
      const rhs = parseExpr();
      expect(';');
      return { type: 'ba', lhs, rhs, line };
    }
    // always @(posedge) の中はレジスタなのでノンブロッキング (`<=`)。ただし
    // integer への代入だけは展開時の値なので `=` になる (while の添字を進める形)。
    // ここでは左辺が integer かどうか分からないので、両方受けて elaborate に任せる。
    if (at('=')) {
      next();
      const rhs = parseExpr();
      expect(';');
      return { type: 'ba', lhs, rhs, line };
    }
    expect('<=');
    const rhs = parseExpr();
    expect(';');
    return { type: 'nb', lhs, rhs, line };
  }

  /**
   * while。elaborate 時に完全展開するので、条件は毎回定数式でなければならない。
   * つまり動くのは integer で宣言した変数だけで、それを本体で進める形になる:
   *
   *   i = 0;
   *   while (i < 8) begin q[i] <= d[7-i]; i = i + 1; end
   */
  function parseWhile(ctx) {
    const line = expect('while').line;
    expect('(');
    const cond = parseExpr();
    expect(')');
    return { type: 'while', cond, body: parseStmtBlock(ctx), line };
  }

  /** repeat。回数は定数式。ループ変数が要らないぶん while より素直に書ける */
  function parseRepeat(ctx) {
    const line = expect('repeat').line;
    expect('(');
    const count = parseExpr();
    expect(')');
    return { type: 'repeat_stmt', count, body: parseStmtBlock(ctx), line };
  }

  /**
   * for。elaborate 時に完全展開するので、初期値・条件・更新式はすべて定数式で、
   * 動くのはループ変数 (integer で宣言) だけ。
   *
   *   for (i = 0; i < 8; i = i + 1) q[i] <= d[7-i];
   *
   * ヘッダの代入は Verilog では always の中でもブロッキング (`=`) なので、
   * 本体が `<=` でもここは `=` で受ける。
   */
  function parseFor(ctx) {
    const line = expect('for').line;
    expect('(');
    const name = expectIdent();
    expect('=');
    const init = parseExpr();
    expect(';');
    const cond = parseExpr();
    expect(';');
    const stepName = expectIdent();
    expect('=');
    const step = parseExpr();
    expect(')');
    if (stepName !== name) {
      throw err(`for の更新式は初期化と同じ変数でなければならない (${name} と ${stepName})`);
    }
    return { type: 'for', name, init, cond, step, body: parseStmtBlock(ctx), line };
  }

  /**
   * initial。この処理系は時間を持たない cycle-based なので、手続きとしては走らせない。
   * 合成できる形 ―― **レジスタの電源投入時の値** ―― として読み、定数の代入だけを受ける。
   * それ以外 (if / case / 信号を読む右辺) は elaborate 側で名指しで断る。
   */
  function parseInitial() {
    const line = expect('initial').line;
    return { type: 'initial', stmts: parseStmtBlock('initial'), line };
  }

  /** integer の宣言。信号ではなく「elaborate 時の整数」= for のループ変数になる */
  function parseIntDecl() {
    const line = expect('integer').line;
    if (at('[')) throw err('integer に幅は書けない (for のループ変数として使う)');
    const names = [expectIdent()];
    while (eat(',')) names.push(expectIdent());
    expect(';');
    return { type: 'intdecl', names, line };
  }

  function parseIf(ctx = null) {
    const line = expect('if').line;
    expect('(');
    const cond = parseExpr();
    expect(')');
    const thenStmts = parseStmtBlock(ctx);
    // else if は「else の中身が 1 個の if 文」として自然に入れ子になる
    const elseStmts = eat('else') ? parseStmtBlock(ctx) : null;
    return { type: 'if', cond, then: thenStmts, else: elseStmts, line };
  }

  function parseCase(ctx = null) {
    // casez はラベルの z / ? をその桁だけ比較から外す。式の側は 2 値しか無いので
    // 「ラベルの don't care」だけを見れば Verilog と同じ結果になる
    const casez = at('casez');
    const line = next().line;
    expect('(');
    const sel = parseExpr();
    expect(')');

    const items = [];
    let dflt = null;
    while (!at('endcase')) {
      // ラベルとして読み込んでしまう前に、ブロックの終わりを止める
      if (peek().type === 'eof' || at('endmodule') || at('endfunction') || at('end')) {
        throw err("'endcase' が見つからない");
      }
      const iline = peek().line;
      if (eat('default')) {
        eat(':');                       // Verilog では ':' は省略できる
        if (dflt) throw err('default が 2 つある');
        dflt = parseStmtBlock(ctx);
        continue;
      }
      const labels = [parseExpr()];
      while (eat(',')) labels.push(parseExpr());
      expect(':');
      items.push({ labels, stmts: parseStmtBlock(ctx), line: iline });
    }
    expect('endcase');
    if (items.length === 0 && !dflt) throw err('case の中身が空');
    return { type: 'case', casez, sel, items, default: dflt, line };
  }

  /** posedge x / negedge x。どちらがクロックでどちらがリセットかは elaborate が決める */
  function parseEdge() {
    const t = peek();
    if (t.value !== 'posedge' && t.value !== 'negedge') {
      throw err("'posedge' または 'negedge' が必要");
    }
    next();
    return { kind: t.value, name: expectIdent(), line: t.line };
  }

  /**
   * always は 2 種類ある。@ の後ろの形で決まる。
   *
   *   always @(posedge clk)  … レジスタ。ノンブロッキング代入 (`<=`)
   *   always @(*) / @(a, b)  … 組合せ回路。ブロッキング代入 (`=`)
   *
   * 感度リストを書いた場合は「取りこぼしが無いか」を elaborate 側で確かめる。
   * 実機と食い違う古典的なバグなので、そのまま通さずに名指しで断りたい。
   */
  function parseAlways() {
    const line = expect('always').line;
    expect('@');

    // always @* (括弧なし) も書ける
    if (eat('*')) return { type: 'always', comb: true, sens: null, stmts: parseStmtBlock('always @(*)'), line };

    expect('(');
    if (eat('*')) {
      expect(')');
      return { type: 'always', comb: true, sens: null, stmts: parseStmtBlock('always @(*)'), line };
    }

    if (at('posedge') || at('negedge')) {
      const edges = [parseEdge()];
      while (eat('or')) edges.push(parseEdge());
      expect(')');
      if (edges.length > 2) {
        throw err(`イベントは 2 つまで (クロックと非同期リセット。${edges.length} 個ある)`);
      }
      return { type: 'always', edges, stmts: parseStmtBlock(), line };
    }

    // 信号名が並んでいたら感度リスト。区切りは or でもコンマでもよい
    const sens = [expectIdent()];
    while (eat('or') || eat(',')) sens.push(expectIdent());
    expect(')');
    return { type: 'always', comb: true, sens, stmts: parseStmtBlock('always @(*)'), line };
  }

  function parseGateInst() {
    const line = peek().line;
    const gate = next().value;
    let instName = null;
    if (peek().type === 'ident') instName = next().value;
    expect('(');
    const args = [parseExpr()];
    while (eat(',')) args.push(parseExpr());
    expect(')');
    expect(';');
    return { type: 'gate', gate, instName, args, line };
  }

  /**
   * モジュールのインスタンス化。
   *   half_adder h0(a, b, s, c);                  … 順番で対応づけ
   *   half_adder h0(.a(x), .b(y), .s(z), .c());   … 名前で対応づけ (空は未接続)
   * 混在は Verilog でも禁止なのでエラーにする。
   */
  function parseModuleInst() {
    const line = peek().line;
    const moduleName = next().value;
    const paramArgs = at('#') ? parseParamList('inst') : [];
    const instName = expectIdent();
    expect('(');

    const ports = [];
    if (!at(')')) {
      const named = at('.');
      do {
        if (named !== at('.')) throw err('ポート接続は名前指定と順番指定を混ぜられない');
        if (named) {
          expect('.');
          const pname = expectIdent();
          expect('(');
          ports.push({ name: pname, expr: at(')') ? null : parseExpr() });
          expect(')');
        } else {
          ports.push({ name: null, expr: parseExpr() });
        }
      } while (eat(','));
    }
    expect(')');
    expect(';');
    return { type: 'inst', module: moduleName, name: instName, params: paramArgs, ports, line };
  }

  // ---- module ------------------------------------------------------------
  function parseModule() {
    const line = expect('module').line;
    const name = expectIdent();
    // ヘッダの #(parameter …) と本体の parameter 宣言は 1 本の順序付きリストにまとめる。
    // 後のものが前のものを参照できるので、順番に意味がある。
    const params = at('#') ? parseParamList('decl') : [];
    const portDecls = [];
    const portOrder = [];

    if (eat('(')) {
      if (!at(')')) {
        // ANSI 形式か非 ANSI 形式かを最初のトークンで判定する
        const ansi = DIRECTIONS.has(peek().value);
        do {
          if (ansi) {
            const pline = peek().line;
            if (!DIRECTIONS.has(peek().value)) throw err('ANSI ポートリストでは input/output が必要');
            const dir = next().value;
            const kind = NET_KINDS.has(peek().value) ? next().value : null;
            rejectSignedness();
            const range = parseRange();
            const pname = expectIdent();
            portDecls.push({ type: 'decl', dir, kind, range, names: [pname], line: pline });
            portOrder.push(pname);
            // input a, b; のように同一宣言で複数ポートを並べる形も許す
            while (at(',') && peek(1).type === 'ident' && !DIRECTIONS.has(peek(1).value)) {
              next();
              const extra = expectIdent();
              portDecls.push({ type: 'decl', dir, kind, range, names: [extra], line: pline });
              portOrder.push(extra);
            }
          } else {
            portOrder.push(expectIdent());
          }
        } while (eat(','));
      }
      expect(')');
    }
    expect(';');

    const items = [...portDecls];
    while (!at('endmodule')) {
      if (peek().type === 'eof') throw err("'endmodule' が見つからない");
      const v = peek().value;
      if (v === 'generate') {
        const gline = next().line;
        const gitems = [];
        while (!at('endgenerate')) {
          // endmodule まで来たら書き忘れ。ここで止めないと endmodule を項目として読む
          if (peek().type === 'eof' || at('endmodule')) throw err("'endgenerate' が見つからない");
          parseGenItem(gitems);
        }
        expect('endgenerate');
        // generate / endgenerate 自体はスコープを作らない (ラベル無し)
        items.push({ type: 'genblock', label: null, items: gitems, line: gline });
      } else if (v === 'for' || v === 'if' || v === 'case') {
        // generate / endgenerate は省ける。module の直下の for / if / case は generate 構文
        parseGenItem(items);
      } else {
        parseModuleItem(items, params);
      }
    }
    expect('endmodule');

    return { type: 'module', name, params, portOrder, items, line };
  }

  /**
   * module の項目 1 個。generate の中からも同じものを読むので切り出してある。
   * params が null なら generate の中 — parameter と function は module の直下でしか
   * 宣言できないので、そこで名前を出して断る。
   */
  function parseModuleItem(items, params) {
    const v = peek().value;
    if (v === 'parameter' || v === 'localparam') {
      if (!params) {
        throw err(`generate の中の ${v} は未対応 (module の直下で宣言してください)`);
      }
      // 本体の parameter は宣言の並びに足す (ヘッダのぶんの後ろに来る)
      params.push(...parseParamDecl().items);
    } else if (DIRECTIONS.has(v) || NET_KINDS.has(v)) items.push(parseDecl());
    else if (v === 'assign') {
      const aline = next().line;
      const lhs = parseLValue();
      expect('=');
      const rhs = parseExpr();
      expect(';');
      items.push({ type: 'assign', lhs, rhs, line: aline });
    } else if (v === 'always') items.push(parseAlways());
    else if (v === 'integer') items.push(parseIntDecl());
    else if (v === 'initial') items.push(parseInitial());
    else if (v === 'genvar') items.push(parseGenvarDecl());
    else if (v === 'function') {
      if (!params) throw err('generate の中の function は未対応 (module の直下で宣言してください)');
      items.push(parseFunction());
    } else if (GATE_PRIMITIVES.has(v)) items.push(parseGateInst());
    else if (UNSUPPORTED_ITEMS.has(v)) throw err(`'${v}' は未対応`);
    else if (peek().type === 'ident' && (peek(1).type === 'ident' || peek(1).value === '#')) {
      // <モジュール名> [#( … )] <インスタンス名> ( … ) ;
      items.push(parseModuleInst());
    } else if (peek().type === 'ident') {
      throw err(`'${v}' は未対応 (always_comb・always_ff などは未実装)`);
    } else throw err(`予期しないトークン '${v}'`);
  }

  // ---- generate --------------------------------------------------------------
  //
  // generate は「どの項目を作るか」を elaborate 時に決める仕掛け。always の中の
  // for / if / case とよく似た形に見えるが、展開されるものが「文」ではなく
  // 「module の項目 (宣言・assign・always・インスタンス)」である点が違う。だから
  // 文の構文木 (parseStmtBlock) ではなく、ここで別に組み立てる。
  //
  // generate / endgenerate は省ける (Verilog-2005 と同じ)。module の直下に
  // for / if / case が来たら、それは generate 構文だと読む。

  /** genvar の宣言。integer と同じ「elaborate 時の整数」なので intdecl に寄せる */
  function parseGenvarDecl() {
    const line = expect('genvar').line;
    if (at('[')) throw err('genvar に幅は書けない (generate の添字として使う)');
    const names = [expectIdent()];
    while (eat(',')) names.push(expectIdent());
    expect(';');
    return { type: 'intdecl', names, line };
  }

  /** begin [: ラベル] <項目>* end。ラベルはスコープの名前になる */
  function parseGenBlock() {
    const line = expect('begin').line;
    const label = eat(':') ? expectIdent() : null;
    const items = [];
    while (!at('end')) {
      if (peek().type === 'eof' || at('endmodule') || at('endgenerate')) {
        throw err("generate ブロックの 'end' が見つからない");
      }
      parseGenItem(items);
    }
    expect('end');
    return { type: 'genblock', label, items, line };
  }

  /** for / if / case の枝 1 個。begin … end でも項目 1 個でもよい */
  function parseGenBody() {
    if (at('begin')) return parseGenBlock();
    const line = peek().line;
    const items = [];
    parseGenItem(items);
    return { type: 'genblock', label: null, items, line };
  }

  function parseGenFor() {
    const line = expect('for').line;
    expect('(');
    const name = expectIdent();
    expect('=');
    const init = parseExpr();
    expect(';');
    const cond = parseExpr();
    expect(';');
    const stepName = expectIdent();
    expect('=');
    const step = parseExpr();
    expect(')');
    if (stepName !== name) {
      throw err(`for の更新式は初期化と同じ変数でなければならない (${name} と ${stepName})`);
    }
    const body = parseGenBody();
    // 繰り返すぶんだけ同じ名前が並ぶので、区別するラベルが要る
    if (!body.label) {
      throw err('generate の for にはラベルが要る (for (…) begin : g … end の形。'
        + '中の名前が g[0].x になる)');
    }
    return { type: 'genfor', name, init, cond, step, body, line };
  }

  function parseGenIf() {
    const line = expect('if').line;
    expect('(');
    const cond = parseExpr();
    expect(')');
    const then = parseGenBody();
    const els = eat('else') ? parseGenBody() : null;
    return { type: 'genif', cond, then, else: els, line };
  }

  function parseGenCase() {
    const line = expect('case').line;
    expect('(');
    const sel = parseExpr();
    expect(')');
    const items = [];
    let dflt = null;
    while (!at('endcase')) {
      if (peek().type === 'eof' || at('endmodule')) throw err("'endcase' が見つからない");
      const iline = peek().line;
      if (eat('default')) {
        eat(':');                       // Verilog では ':' は省略できる
        if (dflt) throw err('default が 2 つある');
        dflt = parseGenBody();
        continue;
      }
      const labels = [parseExpr()];
      while (eat(',')) labels.push(parseExpr());
      expect(':');
      items.push({ labels, body: parseGenBody(), line: iline });
    }
    expect('endcase');
    if (items.length === 0 && !dflt) throw err('case の中身が空');
    return { type: 'gencase', sel, items, default: dflt, line };
  }

  /** generate の中に書ける 1 個。for / if / case / begin か、ふつうの module 項目 */
  function parseGenItem(items) {
    const v = peek().value;
    if (v === 'for') { items.push(parseGenFor()); return; }
    if (v === 'if') { items.push(parseGenIf()); return; }
    if (v === 'case') { items.push(parseGenCase()); return; }
    if (v === 'begin') { items.push(parseGenBlock()); return; }
    if (v === 'generate') {
      throw err('generate は入れ子にできない (中の for / if / case はそのまま書ける)');
    }
    if (v === 'casez' || v === 'casex') {
      throw err(`generate の中では case だけ使える (${v} は条件を回路にする書き方なので、`
        + 'どの項目を作るかは決められない)');
    }
    parseModuleItem(items, null);
  }

  const modules = [];
  while (peek().type !== 'eof') modules.push(parseModule());
  if (modules.length === 0) throw new CompileError('module が見つからない', 1);
  return modules;
}

export { GATE_PRIMITIVES };
