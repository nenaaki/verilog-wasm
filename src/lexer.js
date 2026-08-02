// Verilog サブセットの字句解析。
// キーワードは ident として返し、文脈判定はパーサ側で行う
// (and / or / not はゲート名にも識別子にもなり得るため)。

import { CompileError } from './errors.js';

// 's は符号付きリテラル (4'sd5)。扱わないが、基数の前に来るので読めないと
// 「解釈できない文字 '''」になってしまう。読んでから名指しで断る
const RE_SIZED = /(\d+)?'([sS]?)([bodhBODH])([0-9a-fA-F_]+)/y;
const RE_DEC = /\d[\d_]*/y;
const RE_IDENT = /[A-Za-z_][A-Za-z0-9_$]*/y;

// '<=' はノンブロッキング代入と「以下」を兼ねる。どちらなのかは文脈で決まるので
// パーサ側で解く (Verilog 本来の解き方と同じ)。
// '~^' と '^~' は XNOR。前置ならリダクション、中置ならビットごと (Verilog と同じ)。
// 1 トークンにしておくのが要点で、`^` と `~` に割れると `^~a` が「~a のリダクション
// XOR」になってしまい、幅が偶数のとき Verilog の XNOR リダクションと合わない。
// 1 トークンにしても `a ^ ~b` は中置 XNOR として同じ値になるので壊れない。
const PUNCT2 = ['<=', '>=', '==', '!=', '<<', '>>', '&&', '||', '~^', '^~'];
// '.' は名前指定のポート接続 (.a(x))、'#' はパラメータ指定 (#(.W(4))) で使う
const PUNCT1 = ['?', ':', '(', ')', '[', ']', '{', '}', ',', ';', '=', '&', '|', '^', '~', '@', '+', '-', '<', '>', '!', '.', '#'];
// 対応している演算子と見た目が近いので、素通りさせずに名指しで断る。
// どれも「扱っていないものが絡まなければ同じ意味になる」ので、黙って別扱いに
// するより理由を出したほうがよい。
const PUNCT3_REJECT = {
  '===': '=== は未対応 (x / z を扱わないので == と同じ意味になる)',
  '!==': '!== は未対応 (x / z を扱わないので != と同じ意味になる)',
  '<<<': '<<< は未対応 (算術左シフトは signed でも << と同じ結果になる)',
  '>>>': '>>> は未対応 (signed を扱わないので >> と同じ意味になる)',
};

const RADIX = { b: 2, o: 8, d: 10, h: 16 };

// サイズを書かないリテラル (`10` や `'hFF`) の幅。Verilog では integer と同じ
// 32 ビットになる。値が収まる最小幅にすると、文脈幅が配られない位置 (シフト量など)
// で `1 + 1` が 1 ビット幅の 0 になってしまい、Verilog と食い違う。
const UNSIZED_WIDTH = 32;

/** @returns {{type:'ident'|'num'|'punct'|'eof', value:string, line:number, width?:number, bits?:bigint}[]} */
export function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;

  while (i < src.length) {
    const c = src[i];

    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      if (i >= src.length) throw new CompileError('ブロックコメントが閉じていない', line);
      i += 2;
      continue;
    }

    // 8'hFF / 1'b0 / 4'd10 のような基数付きリテラル (サイズは省略可)
    RE_SIZED.lastIndex = i;
    const sized = RE_SIZED.exec(src);
    if (sized) {
      const [raw, widthStr, signChar, baseChar, digitsRaw] = sized;
      if (signChar) {
        throw new CompileError(
          `${raw} の 's は未対応 (signed を扱わないので `
          + `${widthStr ?? ''}'${baseChar}${digitsRaw} と同じビット列になる)`, line);
      }
      const radix = RADIX[baseChar.toLowerCase()];
      const digits = digitsRaw.replace(/_/g, '');
      let value = 0n;
      for (const d of digits) {
        const v = parseInt(d, radix);
        if (Number.isNaN(v)) throw new CompileError(`基数 ${radix} に対して不正な桁 '${d}'`, line);
        value = value * BigInt(radix) + BigInt(v);
      }
      const width = widthStr ? parseInt(widthStr, 10) : UNSIZED_WIDTH;
      if (width < 1 || width > 4096) throw new CompileError(`ビット幅 ${width} が不正`, line);
      tokens.push({ type: 'num', value: raw, line, width, bits: value });
      i += raw.length;
      continue;
    }

    // 素の 10 進数。ビット選択の添字にも使うので数値そのものを保持する
    RE_DEC.lastIndex = i;
    const dec = RE_DEC.exec(src);
    if (dec) {
      const raw = dec[0];
      const value = BigInt(raw.replace(/_/g, ''));
      tokens.push({
        type: 'num',
        value: raw,
        line,
        width: UNSIZED_WIDTH,
        bits: value,
        plain: Number(value),
      });
      i += raw.length;
      continue;
    }

    RE_IDENT.lastIndex = i;
    const id = RE_IDENT.exec(src);
    if (id) {
      tokens.push({ type: 'ident', value: id[0], line });
      i += id[0].length;
      continue;
    }

    // $signed / $display のようなシステム関数・タスク。'$' を素の記号として
    // 弾くと理由が伝わらないので、名前まで読んでから断る
    if (c === '$') {
      RE_IDENT.lastIndex = i + 1;
      const sys = RE_IDENT.exec(src);
      const name = sys ? `$${sys[0]}` : '$';
      throw new CompileError(name === '$signed' || name === '$unsigned'
        ? `${name} は未対応 (signed を扱わないので符号の付け替えができない)`
        : `${name} は未対応 (システム関数・タスクは扱わない)`, line);
    }

    const three = src.slice(i, i + 3);
    if (PUNCT3_REJECT[three]) throw new CompileError(PUNCT3_REJECT[three], line);

    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      tokens.push({ type: 'punct', value: two, line });
      i += 2;
      continue;
    }
    if (PUNCT1.includes(c)) {
      tokens.push({ type: 'punct', value: c, line });
      i++;
      continue;
    }

    throw new CompileError(`解釈できない文字 '${c}'`, line);
  }

  tokens.push({ type: 'eof', value: '<eof>', line });
  return tokens;
}
