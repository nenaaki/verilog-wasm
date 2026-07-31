// 全加算器: 純粋な組合せ回路
module full_adder(
  input  a,
  input  b,
  input  cin,
  output sum,
  output cout
);
  wire axb;

  assign axb  = a ^ b;
  assign sum  = axb ^ cin;
  assign cout = (a & b) | (cin & axb);
endmodule
