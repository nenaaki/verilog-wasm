// LEB128 エンコーダ。WASM のすべての整数イミディエイトはこの形式。

/** 符号なし LEB128 (u32 相当) */
export function uleb(value) {
  let v = value;
  if (v < 0) throw new Error(`uleb: 負の値 ${value}`);
  const out = [];
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

/** 符号付き LEB128 (i32 相当) */
export function sleb(value) {
  let v = value | 0;
  const out = [];
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((v === 0 && !signBit) || (v === -1 && signBit)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

/** 符号付き LEB128 (i64 相当。BigInt を受ける) */
export function sleb64(value) {
  let v = BigInt(value);
  const out = [];
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    const signBit = (byte & 0x40) !== 0;
    if ((v === 0n && !signBit) || (v === -1n && signBit)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

/** 長さ前置きのベクタ。items は byte 配列の配列。 */
export function vec(items) {
  const out = uleb(items.length);
  for (const it of items) out.push(...it);
  return out;
}

/** セクション: id + サイズ + 中身 */
export function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

/** UTF-8 名前 (長さ前置き) */
export function name(str) {
  const bytes = [...new TextEncoder().encode(str)];
  return [...uleb(bytes.length), ...bytes];
}
