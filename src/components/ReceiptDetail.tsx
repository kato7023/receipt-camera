import { useState, useEffect, useCallback, useRef } from 'react';
import {
  type Receipt,
  type Company,
  type PaymentMethod,
  db,
  updateReceiptMemo,
  updateUploadStatus,
  deleteReceipt,
  updateReceiptCompany,
  updateReceiptGroup,
  updateReceiptPaymentMethod
} from '../db';
import { getCachedCompanies, getCachedPaymentMethods } from '../api';
import CompanyAssigner from './CompanyAssigner';

interface ReceiptDetailProps {
  receipt: Receipt;
  onClose: () => void;
  onUpdate: () => void;
}

export default function ReceiptDetail({ receipt, onClose, onUpdate }: ReceiptDetailProps) {
  const [currentReceipt, setCurrentReceipt] = useState<Receipt | null>(null);
  const [imageUrl, setImageUrl] = useState<string>('');
  const [memo, setMemo] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // マスタデータ
  const [companies, setCompanies] = useState<Company[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);

  // 編集用の状態
  const [showCompanySelector, setShowCompanySelector] = useState(false);
  const [showPaymentSelector, setShowPaymentSelector] = useState(false);
  const [isEditingGroup, setIsEditingGroup] = useState(false);
  const [groupInput, setGroupInput] = useState('');

  const groupInputRef = useRef<HTMLInputElement>(null);
  const imageUrlRef = useRef<string>('');

  // データの読み込み
  const loadReceiptData = useCallback(async () => {
    if (!receipt.id) return;
    const data = await db.receipts.get(receipt.id);
    if (data) {
      setCurrentReceipt(data);
      setMemo(data.memo || '');
      setGroupInput(data.groupName || '');

      const newUrl = URL.createObjectURL(data.image);
      const oldUrl = imageUrlRef.current;
      imageUrlRef.current = newUrl;
      setImageUrl(newUrl);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
    }
  }, [receipt.id]);

  useEffect(() => {
    loadReceiptData();
  }, [loadReceiptData]);

  // アンマウント時のみ解放（更新時の解放は loadReceiptData 内で一元管理）
  useEffect(() => {
    return () => {
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    getCachedCompanies().then(setCompanies);
    getCachedPaymentMethods().then(setPaymentMethods);
  }, []);

  useEffect(() => {
    if (isEditingGroup && groupInputRef.current) {
      groupInputRef.current.focus();
    }
  }, [isEditingGroup]);

  // メモ保存
  const handleMemoSave = useCallback(async () => {
    if (!receipt.id) return;
    await updateReceiptMemo(receipt.id, memo);
    await loadReceiptData();
    onUpdate();
  }, [receipt.id, memo, loadReceiptData, onUpdate]);

  // 会社選択
  const handleCompanySelect = useCallback(async (company: Company | null) => {
    if (!receipt.id) return;
    if (company) {
      await updateReceiptCompany(receipt.id, company.id, company.name);
    } else {
      await db.receipts.update(receipt.id, { companyId: null, companyName: null });
    }
    setShowCompanySelector(false);
    await loadReceiptData();
    onUpdate();
  }, [receipt.id, loadReceiptData, onUpdate]);

  // 支払い方法選択
  const handlePaymentSelect = useCallback(async (method: PaymentMethod) => {
    if (!receipt.id) return;
    await updateReceiptPaymentMethod(receipt.id, method.id, method.name);
    setShowPaymentSelector(false);
    await loadReceiptData();
    onUpdate();
  }, [receipt.id, loadReceiptData, onUpdate]);

  // グループ名保存
  const handleGroupSave = useCallback(async () => {
    if (!receipt.id) return;
    const trimmed = groupInput.trim();
    await updateReceiptGroup([receipt.id], trimmed ? trimmed : null);
    setIsEditingGroup(false);
    await loadReceiptData();
    onUpdate();
  }, [receipt.id, groupInput, loadReceiptData, onUpdate]);

  // グループ名編集キャンセル
  const handleGroupCancel = useCallback(() => {
    setGroupInput(currentReceipt?.groupName || '');
    setIsEditingGroup(false);
  }, [currentReceipt?.groupName]);

  const handleRetry = useCallback(async () => {
    if (!receipt.id) return;
    await updateUploadStatus(receipt.id, 'pending');
    await loadReceiptData();
    onUpdate();
  }, [receipt.id, loadReceiptData, onUpdate]);

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

  if (!currentReceipt) {
    return (
      <div className="receipt-detail-overlay" onClick={onClose}>
        <div className="receipt-detail loading" onClick={(e) => e.stopPropagation()}>
          <div className="shutter-spinner"></div>
        </div>
      </div>
    );
  }

  // 選択している会社のオブジェクトを取得
  const currentCompany = companies.find(c => c.id === currentReceipt.companyId) || null;

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
            <span className="detail-date">{formatDate(currentReceipt.createdAt)}</span>
            <span className={`status-badge ${currentReceipt.uploadStatus}`}>
              {getStatusLabel(currentReceipt.uploadStatus)}
            </span>
          </div>
        </div>

        {/* メタ情報 */}
        <div className="detail-meta">
          {/* 支払い方法 */}
          <div className="detail-meta-item editable" onClick={() => setShowPaymentSelector(true)}>
            <span className="detail-meta-label">支払い方法</span>
            <div className="detail-meta-value-container">
              <span className="detail-meta-value">{currentReceipt.paymentMethodName}</span>
              <svg className="edit-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </div>
          </div>

          {/* 会社 */}
          <div className="detail-meta-item editable" onClick={() => setShowCompanySelector(true)}>
            <span className="detail-meta-label">会社</span>
            <div className="detail-meta-value-container">
              {currentReceipt.companyName ? (
                <span className="detail-meta-value">{currentReceipt.companyName}</span>
              ) : (
                <span className="detail-meta-value unassigned">会社未設定</span>
              )}
              <svg className="edit-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </div>
          </div>

          {/* グループ */}
          <div className="detail-meta-item editable" onClick={() => !isEditingGroup && setIsEditingGroup(true)}>
            <span className="detail-meta-label">グループ</span>
            {isEditingGroup ? (
              <div className="detail-meta-input-container" onClick={(e) => e.stopPropagation()}>
                <input
                  ref={groupInputRef}
                  type="text"
                  className="detail-group-input"
                  value={groupInput}
                  onChange={(e) => setGroupInput(e.target.value)}
                  placeholder="グループ名を入力..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleGroupSave();
                    if (e.key === 'Escape') handleGroupCancel();
                  }}
                />
                <button className="group-save-btn" onClick={handleGroupSave}>✓</button>
                <button className="group-cancel-btn" onClick={handleGroupCancel}>×</button>
              </div>
            ) : (
              <div className="detail-meta-value-container">
                {currentReceipt.groupName ? (
                  <span className="detail-meta-value group-tag">{currentReceipt.groupName}</span>
                ) : (
                  <span className="detail-meta-value unassigned">グループ未設定</span>
                )}
                <svg className="edit-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
              </div>
            )}
          </div>
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
        {currentReceipt.uploadStatus === 'error' && currentReceipt.uploadError && (
          <div className="detail-error">
            <span className="detail-error-text">エラー: {currentReceipt.uploadError}</span>
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

      {/* 会社選択モーダル */}
      {showCompanySelector && (
        <CompanyAssigner
          companies={companies}
          selected={currentCompany}
          onSelect={handleCompanySelect}
          onClose={() => setShowCompanySelector(false)}
        />
      )}

      {/* 支払い方法選択モーダル */}
      {showPaymentSelector && (
        <div className="modal-overlay" onClick={() => setShowPaymentSelector(false)}>
          <div className="modal-sheet compact" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>支払い方法を選択</h3>
              <button className="modal-close" onClick={() => setShowPaymentSelector(false)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="company-list">
              {paymentMethods.map((m) => (
                <button
                  key={m.id}
                  className={`company-card ${currentReceipt.paymentMethodId === m.id ? 'active' : ''}`}
                  onClick={() => handlePaymentSelect(m)}
                >
                  <span>{m.name}</span>
                  {currentReceipt.paymentMethodId === m.id && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="check-icon">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
