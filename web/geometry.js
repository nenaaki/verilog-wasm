// 回路図の寸法まわり。状態を持たない関数だけを置く。
//
// 部品の箱の大きさと端子の位置は、回路部品 (block) が入ってから
// 「種類で決まる定数」ではなく「そのノードで決まる値」になった。

import { insOf, outsOf } from '../src/schematic.js';

export const W = 68, H = 44;         // ふつうの部品の箱のサイズ
export const BLOCK_W = 120;          // 回路部品の箱の幅
export const PIN_PITCH = 22, BLOCK_PAD = 13;
export const CANVAS = { w: 900, h: 480 };

/** 部品の箱の大きさ。回路部品だけ端子の数で縦に伸びる */
export function sizeOf(node) {
  if (node.type !== 'block') return { w: W, h: H };
  const rows = Math.max(insOf(node), outsOf(node), 1);
  return { w: BLOCK_W, h: Math.max(H, 2 * BLOCK_PAD + (rows - 1) * PIN_PITCH) };
}

/** 端子を縦に並べた位置 */
export function pinYs(node, count) {
  const h = sizeOf(node).h;
  if (node.type !== 'block') return count === 1 ? [h / 2] : [h * 0.3, h * 0.7];
  const top = (h - (count - 1) * PIN_PITCH) / 2;
  return Array.from({ length: count }, (_, i) => top + i * PIN_PITCH);
}

/** 入力端子の座標 (ノードの左上から見た位置) */
export const inPin = (node, port) => ({ x: 0, y: pinYs(node, insOf(node))[port] });

/** 出力端子の座標 */
export const outPin = (node, port) => ({ x: sizeOf(node).w, y: pinYs(node, outsOf(node))[port] });

/** 配線のパス。右から左へ戻る線 (フィードバック) だけ上に膨らませる */
export function wirePath(a, b) {
  if (b.x - a.x < 12) {
    // 素直に引くと部品の裏に隠れてしまうため
    const d = Math.max(70, (a.x - b.x) * 0.35);
    return `M ${a.x} ${a.y} C ${a.x + d} ${a.y - d}, ${b.x - d} ${b.y - d}, ${b.x} ${b.y}`;
  }
  const dx = Math.max(30, (b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
