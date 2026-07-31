// 8bit LFSR (x^8 + x^6 + x^5 + x^4 + 1)。周期 255。
// 全 0 は自己ループなので、シミュレータ側で q に非ゼロの初期値を与えて回す:
//   sim.setInput('q', 1); sim.run(255);
module lfsr8(
  input clk,
  output reg [7:0] q
);
  wire fb;

  assign fb = q[7] ^ q[5] ^ q[4] ^ q[3];

  always @(posedge clk)
    q <= {q[6:0], fb};
endmodule
