/**
 * Google Drive 操作 — 画像保存
 * 画像保全優先: Freee API 呼び出し前に Drive 保存を完了させる
 */

/**
 * 領収書画像を Google Drive に保存
 * @param imageBase64 Base64エンコードされた画像データ
 * @param mimeType MIME タイプ（例: image/jpeg）
 * @param companyName 会社名（フォルダ分け用）
 * @param timestamp タイムスタンプ（ファイル名用）
 * @returns Drive ファイル ID
 */
function saveImageToDrive(imageBase64, mimeType, companyName, timestamp) {
  const rootFolder = DriveApp.getFolderById(DRIVE_ROOT_FOLDER_ID);

  // フォルダ構造: 領収書/[会社名]/[YYYY-MM]/
  const receiptFolder = getOrCreateFolder(rootFolder, '領収書');
  const companyFolder = getOrCreateFolder(receiptFolder, companyName);

  const date = new Date(timestamp);
  const monthFolder = getOrCreateFolder(
    companyFolder,
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  );

  // ファイル名: receipt_20260703_143000.jpg
  const dateStr = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const fileName = `receipt_${dateStr}.${extension}`;

  // Base64 デコード → Blob 作成 → 保存
  const decoded = Utilities.base64Decode(imageBase64);
  const blob = Utilities.newBlob(decoded, mimeType, fileName);
  const file = monthFolder.createFile(blob);

  return file.getId();
}

/**
 * フォルダが存在すれば取得、なければ作成
 */
function getOrCreateFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parent.createFolder(name);
}
