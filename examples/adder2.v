// モジュール階層。半加算器 2 個で全加算器、全加算器 2 個で 2 ビット加算器を作る。
//
// 階層はコンパイラが展開して 1 個の平坦なネットリストにする。信号名には
// インスタンス名が前置されるので、WAT を見ると `f0.h1.s` のような名前で出てくる。
// 奥にあるレジスタも完全修飾名で観測できる (この回路にはレジスタは無い)。
//
// ポート接続は順番でも名前でも書ける。--top を省くと、どこからもインスタンス化
// されていない module (ここでは adder2) が top になる。
//
//   node tools/vwc.js examples/adder2.v --run 1 --set a=3 --set b=2
//   node tools/vwc.js examples/adder2.v --top full_adder --run 1 --set a=1 --set b=1
module half_adder(input a, input b, output s, output c);
  assign s = a ^ b;
  assign c = a & b;
endmodule

module full_adder(input a, input b, input cin, output sum, output cout);
  wire s1, c1, c2;

  half_adder h0(a, b, s1, c1);                        // 順番で対応づけ
  half_adder h1(.a(s1), .b(cin), .s(sum), .c(c2));    // 名前で対応づけ

  assign cout = c1 | c2;
endmodule

module adder2(input [1:0] a, input [1:0] b, input cin, output [1:0] sum, output cout);
  wire carry;

  full_adder f0(.a(a[0]), .b(b[0]), .cin(cin),   .sum(sum[0]), .cout(carry));
  full_adder f1(.a(a[1]), .b(b[1]), .cin(carry), .sum(sum[1]), .cout(cout));
endmodule
