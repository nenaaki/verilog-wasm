// デバッグ用バックエンド: 同じネットリストから WAT テキストを出す。
// codegen.js のバイナリと 1:1 対応させてあるので、生成結果を目で追える。

const WAT_ID = /[^0-9A-Za-z_.]/g;

export function emitWat(netlist, order, layout) {
  const { nets, gates, regs } = netlist;
  const { slots, regNext } = layout;

  const id = (netId) => `$n${netId}_${nets[netId].name.replace(WAT_ID, '_')}`;
  const L = [];

  L.push(`;; module ${netlist.name}`);
  L.push(`;; nets=${nets.length} gates=${gates.length} regs=${regs.length} state=${layout.byteSize}B`);
  L.push('(module');
  L.push(`  (memory (export "memory") ${layout.pages})`);

  for (const s of layout.signalTable) {
    const range = s.width > 1 ? `[${s.msb}:${s.lsb}]` : '';
    L.push(`  ;; ${s.dir.padEnd(8)} ${s.name}${range} @ ${s.offsets.join(',')}`);
  }

  // ---- eval: 組合せ論理のみ ----
  L.push('  (func $eval (export "eval")');
  const locals = nets.map((_, i) => id(i));
  for (let i = 0; i < locals.length; i += 6) {
    L.push(`    (local ${locals.slice(i, i + 6).map((n) => `${n} i64`).join(' ')})`);
  }

  L.push('    ;; --- 状態の読み込み ---');
  const load = (netId) => L.push(`    (local.set ${id(netId)} (i64.load offset=${slots.get(netId)} (i32.const 0)))`);
  for (const n of layout.inputNets) load(n);
  for (const r of regs) load(r.q);

  L.push('    ;; --- 組合せ論理 (トポロジカル順) ---');
  for (const gi of order) {
    const g = gates[gi];
    const a = g.in.map(id);
    let expr;
    switch (g.op) {
      case 'const': expr = `(i64.const ${g.value ? -1 : 0})`; break;
      case 'buf': expr = `(local.get ${a[0]})`; break;
      case 'not': expr = `(i64.xor (local.get ${a[0]}) (i64.const -1))`; break;
      case 'and':
      case 'or':
      case 'xor':
        expr = a.slice(1).reduce((acc, x) => `(i64.${g.op} ${acc} (local.get ${x}))`, `(local.get ${a[0]})`);
        break;
      case 'mux':
        expr = `(i64.or (i64.and (local.get ${a[1]}) (local.get ${a[0]}))`
          + ` (i64.and (local.get ${a[2]}) (i64.xor (local.get ${a[0]}) (i64.const -1))))`;
        break;
      default: throw new Error(`wat: 未知のゲート op '${g.op}'`);
    }
    L.push(`    (local.set ${id(g.out)} ${expr})`);
  }

  L.push('    ;; --- 出力ポート ---');
  for (const n of layout.outputNets) {
    L.push(`    (i64.store offset=${slots.get(n)} (i32.const 0) (local.get ${id(n)}))`);
  }
  L.push('    ;; --- レジスタ次状態 (専用スロット。commit まで Q は変えない) ---');
  regs.forEach((r, i) => {
    L.push(`    (i64.store offset=${regNext[i]} (i32.const 0) (local.get ${id(r.d)}))`);
  });
  if (regs.some((r) => r.qAsync != null && r.qAsync !== r.q)) {
    L.push('    ;; --- 非同期リセット (クロックを待たずに Q を上書き) ---');
    for (const r of regs) {
      if (r.qAsync == null || r.qAsync === r.q) continue;
      L.push(`    (i64.store offset=${slots.get(r.q)} (i32.const 0) (local.get ${id(r.qAsync)}))`
        + `   ;; ${nets[r.q].name}`);
    }
  }
  L.push('  )');

  // ---- commit: クロックエッジ ----
  L.push('  (func $commit (export "commit")');
  regs.forEach((r, i) => {
    L.push(`    (i64.store offset=${slots.get(r.q)} (i32.const 0)`
      + ` (i64.load offset=${regNext[i]} (i32.const 0)))   ;; ${nets[r.q].name}`);
  });
  L.push('  )');

  L.push('  ;; 末尾の eval がないと、エッジ直後の組合せ出力がエッジ前の状態のまま残る');
  L.push('  (func $step (export "step") (call $eval) (call $commit) (call $eval))');

  L.push('  (func $run (export "run") (param $n i32)');
  L.push('    (call $eval)');
  L.push('    (block $done (loop $again');
  L.push('      (br_if $done (i32.eqz (local.get $n)))');
  L.push('      (call $commit) (call $eval)');
  L.push('      (local.set $n (i32.sub (local.get $n) (i32.const 1)))');
  L.push('      (br $again)))');
  L.push('  )');
  L.push(')');

  return L.join('\n');
}
