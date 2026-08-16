// Verilog サブセットの字句解析。
// キーワードは ident として返し、文脈判定はパーサ側で行う
// (and / or / not はゲート名にも識別子にもなり得るため)。

import { CompileError } from './errors.js';

// 's は符号付きリテラル (4'sd5)。ビット列は 4'd5 と同じで、signed の印だけが付く。
//
// z / Z / ? と x / X は「その桁を比較しない」印。**2 本に分けて持つ**のは、
// どちらを比較から外すかが casez と casex で違うため (casez は z / ? だけ、
// casex は x も)。値としての x / z は持たないので、ラベル以外に出てきたら
// elaborate が名指しで断る ― どの文字だったかで理由が変わるので、ここでは
// 読むだけにして判断は上に任せる。
const RE_SIZED = /(\d+)?'([sS]?)([bodhBODH])([0-9a-fA-F_xXzZ?]+)/y;
const RE_DEC = /\d[\d_]*/y;
const RE_IDENT = /[A-Za-z_][A-Za-z0-9_$]*/y;

// '<=' はノンブロッキング代入と「以下」を兼ねる。どちらなのかは文脈で決まるので
// パーサ側で解く (Verilog 本来の解き方と同じ)。
// '~^' と '^~' は XNOR。前置ならリダクション、中置ならビットごと (Verilog と同じ)。
// 1 トークンにしておくのが要点で、`^` と `~` に割れると `^~a` が「~a のリダクション
// XOR」になってしまい、幅が偶数のとき Verilog の XNOR リダクションと合わない。
// 1 トークンにしても `a ^ ~b` は中置 XNOR として同じ値になるので壊れない。
// '~&' '~|' '~^' '^~' はリダクションの NAND / NOR / XNOR。**1 トークンにするのが要点**で、
// `~` と `&` に割れると `~(&a)` になり、`~` が文脈幅を受け取ってしまう ―― 8 ビットの
// 文脈に置いた `~|p` が 1 ビットの反転ではなく 8 ビットの反転になり、Verilog と食い違う
// (`~|8'h00` は `8'b1` であって `8'hFF` ではない)。
const PUNCT2 = ['<=', '>=', '==', '!=', '<<', '>>', '&&', '||', '~^', '^~', '~&', '~|'];
// '.' は名前指定のポート接続 (.a(x))、'#' はパラメータ指定 (#(.W(4))) で使う
// '/' はコメントの判定を先に済ませてからここに来る
const PUNCT1 = ['?', ':', '(', ')', '[', ']', '{', '}', ',', ';', '=', '&', '|', '^', '~', '@', '+', '-', '<', '>', '!', '.', '#', '*', '/', '%'];
// 3 文字の記号。'<<' や '==' より先に見ないと 2 文字で切れてしまうので、
// 候補をここでまとめて先に試す。
//   <<< >>> … 算術シフト
//   === !== … ビット列がそっくり同じか (x どうしも一致とみなす)
const PUNCT3 = ['<<<', '>>>', '===', '!=='];

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
      const radix = RADIX[baseChar.toLowerCase()];
      const digits = digitsRaw.replace(/_/g, '');
      // mask / xmask は「比較しない桁」。1 桁が基数ぶんのビットになるので、value と
      // 同じ桁上げで積めば z / x の位置がそのままビットに広がる (4'hz なら 4 ビット)
      let value = 0n;
      let mask = 0n;      // z / ? の桁
      let xmask = 0n;     // x の桁
      for (const d of digits) {
        const isZ = d === 'z' || d === 'Z' || d === '?';
        const isX = d === 'x' || d === 'X';
        if ((isZ || isX) && radix === 10) {
          throw new CompileError(`${raw}: 10 進のリテラルでは x / z / ? は使えない`, line);
        }
        const v = isZ || isX ? 0 : parseInt(d, radix);
        if (Number.isNaN(v)) throw new CompileError(`基数 ${radix} に対して不正な桁 '${d}'`, line);
        value = value * BigInt(radix) + BigInt(v);
        mask = mask * BigInt(radix) + (isZ ? BigInt(radix - 1) : 0n);
        xmask = xmask * BigInt(radix) + (isX ? BigInt(radix - 1) : 0n);
      }
      const width = widthStr ? parseInt(widthStr, 10) : UNSIZED_WIDTH;
      if (width < 1 || width > 4096) throw new CompileError(`ビット幅 ${width} が不正`, line);
      const wm = (1n << BigInt(width)) - 1n;

      // 桁がサイズに足りないぶんの上位は 0 で埋まる。**ただし左端の桁が x / z なら
      // そこまで x / z が広がる** (Verilog の規則)。`4'bx` は 000x ではなく xxxx、
      // `16'hz1` は zzzzzzzzzzzz0001 になる。埋めるのはリテラル自身のサイズまでで、
      // そこから先 (式の文脈幅) はふつうの 0 拡張 / 符号拡張 (elaborate 側)。
      const perDigit = { 2: 1, 8: 3, 16: 4 }[radix] ?? 0;
      const given = digits.length * perDigit;
      if (given < width && perDigit) {
        const head = digits[0];
        const fill = ((1n << BigInt(width)) - (1n << BigInt(given)));
        if (head === 'z' || head === 'Z' || head === '?') mask |= fill;
        else if (head === 'x' || head === 'X') xmask |= fill;
      }
      tokens.push({
        type: 'num', value: raw, line, width, bits: value & wm,
        mask: mask & wm, xmask: xmask & wm, signed: !!signChar,
      });
      i += raw.length;
      continue;
    }

    // 素の 10 進数。ビット選択の添字にも使うので数値そのものを保持する。
    // 基数を書かない 10 進リテラルは Verilog では signed (integer と同じ)
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
        unsized: true,
        signed: true,
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

    // $signed / $unsigned は符号の付け替えとして通す。$display のような
    // 他のシステム関数・タスクは、'$' を素の記号として弾くと理由が伝わらないので、
    // 名前まで読んでから断る
    if (c === '$') {
      RE_IDENT.lastIndex = i + 1;
      const sys = RE_IDENT.exec(src);
      const name = sys ? `$${sys[0]}` : '$';
      if (name !== '$signed' && name !== '$unsigned') {
        throw new CompileError(`${name} は未対応 (システム関数・タスクは扱わない)`, line);
      }
      tokens.push({ type: 'ident', value: name, line });
      i += name.length;
      continue;
    }

    const three = src.slice(i, i + 3);
    if (PUNCT3.includes(three)) {
      tokens.push({ type: 'punct', value: three, line });
      i += 3;
      continue;
    }

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
