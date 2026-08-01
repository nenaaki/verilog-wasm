// シフト演算。定数シフトと可変シフトでコストが段違いになる。
//
// シフトの結果はいつも左オペランドの幅のままなので、`hi << 4` では 4 ビットの外に
// 出たビットが消える。幅を増やして詰めたいときは連接 {hi, lo} を使う。
//
// shr の `packed >> 2` はシフト量がリテラルなので、配線の付け替えだけで済み
// ゲートは 1 個も増えない。
//
// rotl の `packed << amt` はシフト量が信号なので、バレルシフタ (mux の log 段) に
// なる。8 ビット × 3 段で 24 個の mux。
//
//   node tools/vwc.js examples/shifter.v --run 1 --set hi=10 --set lo=5 --set amt=3
module shifter(
  input  [3:0] hi,
  input  [3:0] lo,
  input  [2:0] amt,
  output [7:0] packed,
  output [7:0] shr,
  output [7:0] rotl
);
  assign packed = {hi, lo};

  assign shr = packed >> 2;

  // amt ビット左ローテート。8 - amt もリテラルではないのでこちらもバレルシフタ。
  // amt = 0 のときは packed >> 8 が全 0 になるので、そのまま素通しになる。
  //
  // 引く数に 4'd8 とサイズを書いているのが要点。サイズ無しの 8 は 32 ビット幅なので
  // (Verilog の規則)、8 - amt が 32 ビット減算器になり、その 32 ビットぜんぶが
  // バレルシフタの「幅を超えたか」判定に入るため刈り取りも効かない。
  // 実測で 63 ゲート → 259 ゲートに膨らむ。シフト量の幅は自分で決めるのが安い。
  assign rotl = (packed << amt) | (packed >> (4'd8 - amt));
endmodule
