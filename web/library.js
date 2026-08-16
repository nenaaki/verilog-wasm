// 回路の .json 書き出しと、部品ライブラリの取り込み。
//
// 書き出す形は 2 通りあるが、**ライブラリは「回路 1 個のファイル」を並べただけ**に
// してある:
//
//   回路 1 個    { "name": …, "nodes": […], "wires": […] }
//   ライブラリ   { "circuits": [ 上の形, 上の形, … ] }
//
// おかげで手で 1 個取り出せば単体のファイルとしてそのまま読めるし、読み込み側も
// circuits があるかどうかを見るだけで振り分けられる。版番号は持たない ―― 中身は
// サンプルや共有リンクとまったく同じ圧縮形式 (src/schematic.js の packCircuit) で、
// 知らないフィールドは expandCircuit が無視する。
//
// DOM に触らないので、テストから直に呼べる。

import { expandCircuit } from '../src/schematic.js';

const MAX_NAME = 32;        // 名前欄の maxlength と揃える

const rows = (arr, indent) => (arr.length
  ? `[\n${arr.map((r) => `${indent}  ${JSON.stringify(r)}`).join(',\n')}\n${indent}]`
  : '[]');

/**
 * 圧縮形式 1 個を JSON のテキストにする。
 * **部品と配線は 1 行ずつ並べる** ―― 手で開いて読めるように、そして回路を少し
 * 変えたときの diff が変わった行だけで済むように。
 */
export function circuitJson(name, packed, indent = '') {
  return `${indent}{\n${indent}  "name": ${JSON.stringify(name)},\n`
    + `${indent}  "nodes": ${rows(packed.nodes, `${indent}  `)},\n`
    + `${indent}  "wires": ${rows(packed.wires, `${indent}  `)}\n${indent}}`;
}

/**
 * 「保存した回路」まるごとを 1 個のライブラリファイルにする。
 * @param {Record<string, object>} saved 名前 → 圧縮形式
 */
export function libraryJson(saved) {
  const names = Object.keys(saved).sort();
  const body = names.map((n) => circuitJson(n, saved[n], '    ')).join(',\n');
  return `{\n  "circuits": [\n${body}\n  ]\n}\n`;
}

/** 読み込んだデータがライブラリか (回路 1 個なら false) */
export const isLibrary = (data) => Array.isArray(data?.circuits);

/**
 * ライブラリを「保存した回路」に取り込む。saved は書き換えず、新しい表を返す。
 *
 * **1 個ずつ検査して、通ったものだけ入れる。** 他人から来たファイルのこともあるので、
 * 壊れた回路 1 個でライブラリ全体が入らないほうが困る (筋の通らない配線を黙って
 * 捨てるのと同じ判断)。落としたものは理由を付けて返し、呼び出し側が伝える。
 *
 * 同じ名前は上書きする ―― 「保存」ボタンと同じ扱い。取り込みを 2 回やっても
 * 増えないほうが、名前が枝分かれしていくより扱いやすい。
 *
 * @returns {{all: object, added: string[], replaced: string[], skipped: string[]}}
 */
export function mergeLibrary(saved, list) {
  const all = { ...saved };
  const added = [];
  const replaced = [];
  const skipped = [];
  const done = new Set();          // 同じ名前がファイルの中に 2 回あっても 1 個と数える

  for (const [i, entry] of (list ?? []).entries()) {
    const name = typeof entry?.name === 'string' ? entry.name.trim().slice(0, MAX_NAME) : '';
    if (!name) { skipped.push(`${i + 1} 個目: 名前がありません`); continue; }
    try {
      expandCircuit(entry);        // 中身の検査。通らなければこの 1 個だけ落とす
      if (!done.has(name)) {
        done.add(name);
        (name in saved ? replaced : added).push(name);
      }
      all[name] = { nodes: entry.nodes, wires: entry.wires };
    } catch (e) {
      skipped.push(`${name}: ${e.message}`);
    }
  }
  return { all, added, replaced, skipped };
}
