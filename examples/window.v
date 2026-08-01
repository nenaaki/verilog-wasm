// 値が [lo, hi] の範囲に入っているかを見る。比較器 2 個を && でまとめる。
//
// 論理演算子は両辺を「0 でないか」に潰してからゲート 1 個になる。結果は 1 ビット
// なので、そのまま条件や 1 ビットの出力に使える。ビットごとに働く & や ~ とは
// 別物で、`~4'b0010` は `4'b1101` だが `!4'b0010` は `0` になる。
//
// カッコは無くても同じに読める (比較は && より強く結合する) が、意図を出すために
// 付けてある。
//
//   node tools/vwc.js examples/window.v --run 1 --set x=5 --set lo=3 --set hi=9 --set valid=1
module window(
  input  [3:0] x,
  input  [3:0] lo,
  input  [3:0] hi,
  input  valid,
  output inside,
  output outside,
  output empty
);
  assign inside  = valid && (x >= lo) && (x <= hi);
  assign outside = !inside;

  // lo > hi なら範囲が空。ここも比較器 1 個ぶん
  assign empty = lo > hi;
endmodule
