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
  'initial', 'generate', 'endgenerate', 'function', 'task', 'defparam', 'specify',
  'always_comb', 'always_ff', 'always_latch', 'genvar', 'integer', 'real', 'time',
]);
const DIRECTIONS = new Set(['input', 'output']);
const NET_KINDS = new Set(['wire', 'reg']);
// signed / unsigned は宣言の中で幅の前に来る (`wire signed [3:0] x;`)。予約語として
// 知らないと識別子に見えてしまい、次の '[' で見当違いのエラーになる
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

  const parseAdd = binaryLevel(['+', '-'], () => parseUnary());
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

  function parsePrimary() {
    const t = peek();

    if (t.type === 'num') {
      next();
      // mask は casez のラベルで「比較しない桁」。それ以外の場所では elaborate が断る
      return { type: 'num', width: t.width, bits: t.bits, mask: t.mask ?? 0n, line: t.line };
    }

    if (eat('(')) {
      const e = parseExpr();
      expect(')');
      return e;
    }

    if (at('{')) {
      const line = next().line;
      const parts = [parseExpr()];
      while (eat(',')) parts.push(parseExpr());
      expect('}');
      return { type: 'concat', parts, line };
    }

    if (t.type === 'ident') {
      next();
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
    const names = [expectIdent()];
    while (eat(',')) names.push(expectIdent());
    expect(';');
    return { type: 'decl', dir, kind, range, names, line };
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

  /** begin...end なら中の文の列、そうでなければ 1 文だけの列 */
  function parseStmtBlock() {
    if (eat('begin')) {
      const list = [];
      while (!at('end')) {
        // endmodule もここで止める。止めないと次の文の左辺として読んでしまい、
        // 「'<=' が必要」のような原因から遠いエラーになる
        if (peek().type === 'eof' || at('endmodule')) throw err("'end' が見つからない");
        list.push(parseStmt());
      }
      expect('end');
      return list;
    }
    return [parseStmt()];
  }

  function parseStmt() {
    if (at('if')) return parseIf();
    if (at('case') || at('casez')) return parseCase();
    // casex は x も don't care にする。x を値として持たないので z との差が出ず、
    // 「x なら何でも一致」を装うことになるので断る (casez なら z / ? で足りる)
    if (at('casex')) throw err('casex は未対応 (x を値として扱わない。casez を使う)');
    const line = peek().line;
    const lhs = parseLValue();
    if (at('=')) throw err('always ブロック内ではノンブロッキング代入 <= を使う');
    expect('<=');
    const rhs = parseExpr();
    expect(';');
    return { type: 'nb', lhs, rhs, line };
  }

  function parseIf() {
    const line = expect('if').line;
    expect('(');
    const cond = parseExpr();
    expect(')');
    const thenStmts = parseStmtBlock();
    // else if は「else の中身が 1 個の if 文」として自然に入れ子になる
    const elseStmts = eat('else') ? parseStmtBlock() : null;
    return { type: 'if', cond, then: thenStmts, else: elseStmts, line };
  }

  function parseCase() {
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
      if (peek().type === 'eof' || at('endmodule') || at('end')) {
        throw err("'endcase' が見つからない");
      }
      const iline = peek().line;
      if (eat('default')) {
        eat(':');                       // Verilog では ':' は省略できる
        if (dflt) throw err('default が 2 つある');
        dflt = parseStmtBlock();
        continue;
      }
      const labels = [parseExpr()];
      while (eat(',')) labels.push(parseExpr());
      expect(':');
      items.push({ labels, stmts: parseStmtBlock(), line: iline });
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

  function parseAlways() {
    const line = expect('always').line;
    expect('@');
    expect('(');
    const edges = [parseEdge()];
    while (eat('or')) edges.push(parseEdge());
    expect(')');
    if (edges.length > 2) {
      throw err(`イベントは 2 つまで (クロックと非同期リセット。${edges.length} 個ある)`);
    }

    const stmts = parseStmtBlock();

    return { type: 'always', edges, stmts, line };
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
      if (v === 'parameter' || v === 'localparam') {
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
      else if (GATE_PRIMITIVES.has(v)) items.push(parseGateInst());
      else if (UNSUPPORTED_ITEMS.has(v)) throw err(`'${v}' は未対応`);
      else if (peek().type === 'ident' && (peek(1).type === 'ident' || peek(1).value === '#')) {
        // <モジュール名> [#( … )] <インスタンス名> ( … ) ;
        items.push(parseModuleInst());
      } else if (peek().type === 'ident') {
        throw err(`'${v}' は未対応 (always_comb・initial などは未実装)`);
      } else throw err(`予期しないトークン '${v}'`);
    }
    expect('endmodule');

    return { type: 'module', name, params, portOrder, items, line };
  }

  const modules = [];
  while (peek().type !== 'eof') modules.push(parseModule());
  if (modules.length === 0) throw new CompileError('module が見つからない', 1);
  return modules;
}

export { GATE_PRIMITIVES };
