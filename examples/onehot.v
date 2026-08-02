// 3 本のうち何本立っているかを見る回路。
//
// ポートリストは非 ANSI 形式 (名前だけ並べて、方向は本体で宣言する)。
// ゲートプリミティブは 3 入力で書いていて、buf も使っている。
// exactly は論理演算子 (&& || !) で「ちょうど 1 本」を書き下したもの。
//
//   node tools/vwc.js examples/onehot.v --run 1 --set a=1 --set b=0 --set c=0
module onehot(a, b, c, any, all, none, exactly, copy);
  input a, b, c;
  output any, all, none, exactly, copy;

  or  g0(any,  a, b, c);      // 3 入力でも書ける
  and g1(all,  a, b, c);
  nor g2(none, a, b, c);
  buf g3(copy, a);

  assign exactly = (a && !b && !c) || (!a && b && !c) || (!a && !b && c);
endmodule
