// ゲートプリミティブのインスタンス化
module gates(input a, b, output y_and, y_or, y_xor, y_nand, y_nor, y_xnor, y_not);
  and  g0(y_and,  a, b);
  or   g1(y_or,   a, b);
  xor  g2(y_xor,  a, b);
  nand g3(y_nand, a, b);
  nor  g4(y_nor,  a, b);
  xnor g5(y_xnor, a, b);
  not  g6(y_not,  a);
endmodule
