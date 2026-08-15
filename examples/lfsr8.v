// 8bit LFSR (x^8 + x^6 + x^5 + x^4 + 1)。周期 255。
//
// 全 0 は自己ループになるので、種を initial で置く。生成した WASM は
// データセグメントで初期状態を運ぶので、instantiate しただけでここから始まる
// (外から setInput で入れ直さなくてよい)。
//
//   node tools/vwc.js examples/lfsr8.v --run 8
module lfsr8(
  input clk,
  output reg [7:0] q
);
  wire fb;

  initial q = 8'h01;

  assign fb = q[7] ^ q[5] ^ q[4] ^ q[3];

  always @(posedge clk)
    q <= {q[6:0], fb};
endmodule
