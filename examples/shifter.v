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
  // 8 はサイズ無しなので Verilog の規則どおり 32 ビット幅で、素直に展開すると
  // 32 ビット減算器になる。定数畳み込みがこれをたたむので、4'd8 と書いた場合と
  // 同じ回路 (ゲート数も WASM のバイト数も一致) になる。
  assign rotl = (packed << amt) | (packed >> (8 - amt));
endmodule
