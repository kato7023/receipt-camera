import { useState, useEffect, useCallback } from 'react';
import { type Receipt, updateReceiptMemo, updateUploadStatus, deleteReceipt } from '../db';

interface ReceiptDetailProps {
  receipt: Receipt;
  onClose: () => void;
  onUpdate: () => void;
}

export default function ReceiptDetail({ receipt, onClose, onUpdate }: ReceiptDetailProps) {
  const [imageUrl, setImageUrl] = useState<string>('');
  const [memo, setMemo] = useState(receipt.memo || '');
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(receipt.image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [receipt.image]);

  const handleMemoSave = useCallback(async () => {
    if (!receipt.id) return;
    await updateReceiptMemo(receipt.id, memo);
    onUpdate();
  }, [receipt.id, memo, onUpdate]);

  const handleRetry = useCallback(async () => {
    if (!receipt.id) return;
    await updateUploadStatus(receipt.id, 'pending');
    onUpdate();
  }, [receipt.id, onUpdate]);

  const handleDelete = useCallback(async () => {
    if (!receipt.id) return;
    setIsDeleting(true);
    try {
      await deleteReceipt(receipt.id);
      onUpdate();
      onClose();
    } catch (err) {
      console.error('削除に失敗:', err);
      setIsDeleting(false);
    }
  }, [receipt.id, onUpdate, onClose]);

  const formatDate = (date: Date) => {
    const d = new Date(date);
    return `${d.getFullYear()}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'pending': return '未アップロード';
      case 'uploading': return 'アップロード中...';
      case 'completed': return 'アップロード完了';
      case 'error': return 'エラー';
      default: return status;
    }
  };

  return (
    <div className="receipt-detail-overlay" onClick={onClose}>
      <div className="receipt-detail" onClick={(e) => e.stopPropagation()}>
        {/* ヘッダー */}
        <div className="detail-header">
          <button className="detail-back-button" onClick={onClose} aria-label="戻る">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="detail-header-info">
            <span className="detail-date">{formatDate(receipt.createdAt)}</span>
            <span className={`status-badge ${receipt.uploadStatus}`}>
              {getStatusLabel(receipt.uploadStatus)}
            </span>
          </div>
        </div>

        {/* メタ情報 */}
        <div className="detail-meta">
          <div className="detail-meta-item">
            <span className="detail-meta-label">支払い方法</span>
            <span className="detail-meta-value">{receipt.paymentMethodName}</span>
          </div>
          {receipt.companyName && (
            <div className="detail-meta-item">
              <span className="detail-meta-label">会社</span>
              <span className="detail-meta-value">{receipt.companyName}</span>
            </div>
          )}
          {receipt.groupName && (
            <div className="detail-meta-item">
              <span className="detail-meta-label">グループ</span>
              <span className="detail-meta-value group-tag">{receipt.groupName}</span>
            </div>
          )}
        </div>

        {/* 画像 */}
        <div className="detail-image-container">
          {imageUrl && <img src={imageUrl} alt="領収書" className="detail-image" />}
        </div>

        {/* メモ */}
        <div className="detail-memo">
          <label className="memo-label" htmlFor="receipt-memo">メモ</label>
          <div className="memo-input-group">
            <input
              id="receipt-memo"
              type="text"
              className="memo-input"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              onBlur={handleMemoSave}
              placeholder="メモを入力..."
            />
          </div>
        </div>

        {/* エラー表示 */}
        {receipt.uploadStatus === 'error' && receipt.uploadError && (
          <div className="detail-error">
            <span className="detail-error-text">エラー: {receipt.uploadError}</span>
            <button className="action-button retry-button" onClick={handleRetry}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              リトライ
            </button>
          </div>
        )}

        {/* アクションボタン */}
        <div className="detail-actions">
          {showDeleteConfirm ? (
            <div className="delete-confirm">
              <span>本当に削除しますか？</span>
              <button className="action-button delete-yes" onClick={handleDelete} disabled={isDeleting}>
                {isDeleting ? '削除中...' : '削除する'}
              </button>
              <button className="action-button delete-no" onClick={() => setShowDeleteConfirm(false)}>
                キャンセル
              </button>
            </div>
          ) : (
            <button className="action-button delete-button" onClick={() => setShowDeleteConfirm(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              削除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
