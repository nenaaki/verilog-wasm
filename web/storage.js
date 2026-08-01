// localStorage への出入り口。ここ以外から localStorage を触らない。
//
// 保存する値はすべて圧縮形式 (src/schematic.js の packCircuit) の JSON。
// 使えない環境 (プライベートウィンドウ・容量オーバー) でも編集自体は続けられるよう、
// 読みは既定値を返し、書きは成否を返すだけで例外を投げない。

const KEY = {
  saved: 'verilog-wasm/saved',   // 名前 → 圧縮形式
  work: 'verilog-wasm/work',     // 編集中の回路 (自動保存)
  clip: 'verilog-wasm/clip',     // コピーした部分回路
};

function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return v ?? fallback;
  } catch { return fallback; }   // 壊れていたら無かったことにする
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

/** 名前を付けて保存した回路すべて */
export function readSaved() {
  const o = readJson(KEY.saved, {});
  return o && typeof o === 'object' ? o : {};
}

export const writeSaved = (all) => writeJson(KEY.saved, all);

/** 編集中の回路 (自動保存) */
export const readWork = () => readJson(KEY.work, null);
export const writeWork = (compact) => writeJson(KEY.work, compact);

/** コピーした部分回路。別のタブで開いた回路にも貼れるように localStorage に置く */
export const readClip = () => readJson(KEY.clip, null);
export const writeClip = (compact) => writeJson(KEY.clip, compact);
