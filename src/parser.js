// Verilog サブセット → AST
//
// 式の優先順位 (低い順): ?:  |  ^  &  == !=  < <= > >=  + -  単項 (~ - +)  primary
// これは Verilog 本来の優先順位と一致する。等価 (== !=) は関係 (< など) より弱く、
// どちらもビット演算より強い。算術はさらに強い。
//
// '<=' はノンブロッキング代入と「以下」の両方に使われる。always 文の代入は
// parseLValue で左辺を読んでから expect('<=') で食べるので、式の中に出てきた
// '<=' だけが関係演算子として解釈される (Verilog も同じ解き方)。

import { lex } from './lexer.js';
import { CompileError } from './errors.js';

const GATE_PRIMITIVES = new Set(['and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buf']);
const DIRECTIONS = new Set(['input', 'output']);
const NET_KINDS = new Set(['wire', 'reg']);

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
  const expectIndex = () => {
    const t = peek();
    if (t.type !== 'num' || t.plain === undefined) throw err(`ビット添字には 10 進数が必要 ('${t.value}')`);
    next();
    return t.plain;
  };

  // ---- [msb:lsb] / [n] ----------------------------------------------------
  function parseRange() {
    if (!at('[')) return null;
    const line = peek().line;
    expect('[');
    const a = expectIndex();
    if (eat(':')) {
      const b = expectIndex();
      expect(']');
      return { msb: a, lsb: b, single: false, line };
    }
    expect(']');
    return { msb: a, lsb: a, single: true, line };
  }

  // ---- 式 ----------------------------------------------------------------
  function parseExpr() {
    const cond = parseOr();
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
  const parseRel = binaryLevel(['<=', '>=', '<', '>'], parseAdd);
  const parseEq = binaryLevel(['==', '!='], parseRel);
  const parseAnd = binaryLevel('&', parseEq);
  const parseXor = binaryLevel('^', parseAnd);
  const parseOr = binaryLevel('|', parseXor);

  function parseUnary() {
    if (at('~') || at('-')) {
      const t = next();
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
      return { type: 'num', width: t.width, bits: t.bits, line: t.line };
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
    const range = parseRange();
    const names = [expectIdent()];
    while (eat(',')) names.push(expectIdent());
    expect(';');
    return { type: 'decl', dir, kind, range, names, line };
  }

  function parseAlways() {
    const line = expect('always').line;
    expect('@');
    expect('(');
    if (!at('posedge')) {
      if (at('negedge')) throw err('negedge は未対応 (posedge のみ)');
      throw err("'posedge' が必要");
    }
    next();
    const clock = expectIdent();
    expect(')');

    const stmts = [];
    const parseStmt = () => {
      if (eat('begin')) {
        while (!at('end')) {
          if (peek().type === 'eof') throw err("'end' が見つからない");
          parseStmt();
        }
        expect('end');
        return;
      }
      const sline = peek().line;
      const lhs = parseLValue();
      if (at('=')) throw err('always ブロック内ではノンブロッキング代入 <= を使う');
      expect('<=');
      const rhs = parseExpr();
      expect(';');
      stmts.push({ lhs, rhs, line: sline });
    };
    parseStmt();

    return { type: 'always', clock, stmts, line };
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

  // ---- module ------------------------------------------------------------
  function parseModule() {
    const line = expect('module').line;
    const name = expectIdent();
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
      if (DIRECTIONS.has(v) || NET_KINDS.has(v)) items.push(parseDecl());
      else if (v === 'assign') {
        const aline = next().line;
        const lhs = parseLValue();
        expect('=');
        const rhs = parseExpr();
        expect(';');
        items.push({ type: 'assign', lhs, rhs, line: aline });
      } else if (v === 'always') items.push(parseAlways());
      else if (GATE_PRIMITIVES.has(v)) items.push(parseGateInst());
      else if (peek().type === 'ident') {
        throw err(`'${v}' は未対応 (モジュール階層・always_comb・initial などは未実装)`);
      } else throw err(`予期しないトークン '${v}'`);
    }
    expect('endmodule');

    return { type: 'module', name, portOrder, items, line };
  }

  const modules = [];
  while (peek().type !== 'eof') modules.push(parseModule());
  if (modules.length === 0) throw new CompileError('module が見つからない', 1);
  return modules;
}

export { GATE_PRIMITIVES };
