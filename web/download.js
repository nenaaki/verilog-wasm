// ブラウザにファイルを保存させる道具。
// Blob を作って <a download> をクリックするだけだが、URL の後始末を忘れると
// リロードするまでバイナリがメモリに残るので、ここに閉じ込めておく。

/**
 * ファイルとして保存する。
 * @param {string} filename 保存名 (拡張子まで含める)
 * @param {BlobPart} data 中身。Uint8Array でも文字列でもよい
 * @param {string} [mime]
 */
export function saveFile(filename, data, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // click 直後に revoke すると保存が始まる前に無効化される環境があるので少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** ファイル名に使える形に落とす (top モジュール名や回路名をそのまま渡せるように) */
export function safeName(name, fallback = 'circuit') {
  const s = String(name ?? '').trim().replace(/[^\w.-]+/g, '_').replace(/^[-._]+/, '');
  return s || fallback;
}
