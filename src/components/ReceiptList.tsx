import { useState, useEffect, useCallback } from 'react';
import { db, updateReceiptCompany, updateReceiptGroup, updateUploadStatus, deleteReceipts } from '../db';
import type { Receipt, Company } from '../db';
import { getCachedCompanies, uploadReceipts } from '../api';
import CompanyAssigner from './CompanyAssigner';
import GroupManager from './GroupManager';

interface ReceiptListProps {
  onSelect: (receipt: Receipt) => void;
  refreshKey: number;
}

type FilterType = 'pending' | 'completed' | 'error' | 'all';

export default function ReceiptList({ onSelect, refreshKey }: ReceiptListProps) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [allReceipts, setAllReceipts] = useState<Receipt[]>([]);
  const [filter, setFilter] = useState<FilterType>('pending');
  const [thumbnailUrls, setThumbnailUrls] = useState<Map<number, string>>(new Map());
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isUploading, setIsUploading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [showCompanyAssigner, setShowCompanyAssigner] = useState(false);
  const [showGroupManager, setShowGroupManager] = useState(false);

  useEffect(() => {
    getCachedCompanies().then(setCompanies);
  }, []);

  const loadReceipts = useCallback(async () => {
    const all = await db.receipts.orderBy('createdAt').reverse().toArray();
    setAllReceipts(all);

    let filtered: Receipt[];
    switch (filter) {
      case 'pending':
        filtered = all.filter((r) => r.uploadStatus === 'pending');
        break;
      case 'completed':
        filtered = all.filter((r) => r.uploadStatus === 'completed');
        break;
      case 'error':
        filtered = all.filter((r) => r.uploadStatus === 'error');
        break;
      default:
        filtered = all;
    }
    setReceipts(filtered);

    setThumbnailUrls((prev) => {
      const nextUrls = new Map<number, string>();
      const prevCopy = new Map(prev);

      for (const receipt of filtered) {
        if (receipt.id !== undefined) {
          if (prevCopy.has(receipt.id)) {
            // 既存のオブジェクトURLを再利用
            nextUrls.set(receipt.id, prevCopy.get(receipt.id)!);
            prevCopy.delete(receipt.id); // 削除対象から除外
          } else {
            // 新規作成
            nextUrls.set(receipt.id, URL.createObjectURL(receipt.thumbnail));
          }
        }
      }

      // 不要になったURLのみ解放
      prevCopy.forEach((url) => URL.revokeObjectURL(url));
      return nextUrls;
    });
  }, [filter]);

  useEffect(() => { loadReceipts(); }, [loadReceipts, refreshKey]);
  useEffect(() => {
    return () => { thumbnailUrls.forEach((url) => URL.revokeObjectURL(url)); };
  }, []);

  const toggleSelectMode = () => {
    if (selectMode) { setSelectedIds(new Set()); setShowDeleteConfirm(false); }
    setSelectMode(!selectMode);
  };

  const toggleSelection = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setShowDeleteConfirm(false);
  };

  const selectAll = () => {
    setSelectedIds(new Set(receipts.filter(r => r.id !== undefined).map(r => r.id as number)));
  };

  // 会社割当（選択中のレシートに会社を設定）
  const handleCompanyAssign = useCallback(async (company: Company | null) => {
    try {
      if (company) {
        // 並列で会社を設定
        await Promise.all(
          Array.from(selectedIds).map((id) =>
            updateReceiptCompany(id, company.id, company.name)
          )
        );
      } else {
        // 並列で会社の設定を解除
        await Promise.all(
          Array.from(selectedIds).map((id) =>
            db.receipts.update(id, { companyId: null, companyName: null })
          )
        );
      }
    } catch (err) {
      console.error('会社割り当てに失敗しました:', err);
      alert('会社の割り当てに失敗しました。時間をおいて再度お試しください。');
    } finally {
      setShowCompanyAssigner(false);
      setSelectedIds(new Set());
      setSelectMode(false);
      loadReceipts();
    }
  }, [selectedIds, loadReceipts]);

  // グループ化
  const handleGroupApply = useCallback(async (groupName: string) => {
    await updateReceiptGroup(Array.from(selectedIds), groupName);
    setShowGroupManager(false);
    setSelectedIds(new Set());
    setSelectMode(false);
    loadReceipts();
  }, [selectedIds, loadReceipts]);

  // アップロード
  const handleUpload = useCallback(async () => {
    // 会社未設定のレシートがあるか確認
    const targetReceipts = receipts.filter(
      r => r.id !== undefined && (selectedIds.size === 0 || selectedIds.has(r.id!)) && r.uploadStatus === 'pending'
    );
    const noCompany = targetReceipts.filter(r => !r.companyId);
    if (noCompany.length > 0) {
      alert(`会社未設定のレシートが ${noCompany.length} 枚あります。先に会社を設定してください。`);
      return;
    }
    if (targetReceipts.length === 0) { alert('アップロード対象のレシートがありません。'); return; }

    setIsUploading(true);
    try {
      // ステータスをuploadingに更新
      for (const r of targetReceipts) {
        await updateUploadStatus(r.id!, 'uploading');
      }
      loadReceipts();

      const items = targetReceipts.map(r => ({
        image: r.image,
        companyId: r.companyId!,
        paymentMethodId: r.paymentMethodId,
        paymentMethodName: r.paymentMethodName,
        groupName: r.groupName,
        memo: r.memo,
        capturedAt: r.createdAt,
      }));

      const results = await uploadReceipts(items);

      // 結果を反映
      for (const result of results) {
        const receipt = targetReceipts[result.receiptIndex];
        if (receipt?.id) {
          if (result.status === 'completed') {
            await updateUploadStatus(receipt.id, 'completed');
          } else {
            await updateUploadStatus(receipt.id, 'error', result.error || 'アップロードに失敗しました');
          }
        }
      }
    } catch (err) {
      console.error('アップロードエラー:', err);
      for (const r of targetReceipts) {
        if (r.id) await updateUploadStatus(r.id, 'error', (err as Error).message);
      }
    } finally {
      setIsUploading(false);
      setSelectedIds(new Set());
      setSelectMode(false);
      loadReceipts();
    }
  }, [receipts, selectedIds, loadReceipts]);

  // リトライ（エラーのレシートをpendingに戻す）
  const handleRetry = useCallback(async () => {
    const errorReceipts = receipts.filter(r => r.id !== undefined && r.uploadStatus === 'error');
    for (const r of errorReceipts) {
      await updateUploadStatus(r.id!, 'pending');
    }
    loadReceipts();
  }, [receipts, loadReceipts]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    await deleteReceipts(Array.from(selectedIds));
    setSelectedIds(new Set());
    setSelectMode(false);
    setShowDeleteConfirm(false);
    loadReceipts();
  }, [selectedIds, loadReceipts]);

  const formatDate = (date: Date) => {
    const d = new Date(date);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
  };

  const pendingCount = allReceipts.filter(r => r.uploadStatus === 'pending').length;
  const completedCount = allReceipts.filter(r => r.uploadStatus === 'completed').length;
  const errorCount = allReceipts.filter(r => r.uploadStatus === 'error').length;

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'pending': return 'status-badge pending';
      case 'uploading': return 'status-badge uploading';
      case 'completed': return 'status-badge completed';
      case 'error': return 'status-badge error';
      default: return 'status-badge';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'pending': return '未アップロード';
      case 'uploading': return 'アップロード中';
      case 'completed': return '完了';
      case 'error': return 'エラー';
      default: return status;
    }
  };

  return (
    <div className="receipt-list">
      {/* ヘッダー */}
      <div className="list-header">
        <button className={`select-mode-button ${selectMode ? 'active' : ''}`} onClick={toggleSelectMode}>
          {selectMode ? '完了' : '選択'}
        </button>
        {selectMode && <button className="select-all-button" onClick={selectAll}>全選択</button>}
        {filter === 'error' && errorCount > 0 && !selectMode && (
          <button className="retry-all-button" onClick={handleRetry}>全てリトライ</button>
        )}
      </div>

      {/* フィルター */}
      <div className="filter-tabs">
        <button className={`filter-tab ${filter === 'pending' ? 'active' : ''}`} onClick={() => setFilter('pending')}>
          未アップロード<span className="filter-count pending">{pendingCount}</span>
        </button>
        <button className={`filter-tab ${filter === 'completed' ? 'active' : ''}`} onClick={() => setFilter('completed')}>
          完了<span className="filter-count completed">{completedCount}</span>
        </button>
        <button className={`filter-tab ${filter === 'error' ? 'active' : ''}`} onClick={() => setFilter('error')}>
          エラー<span className="filter-count error">{errorCount}</span>
        </button>
        <button className={`filter-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          すべて<span className="filter-count">{allReceipts.length}</span>
        </button>
      </div>

      {/* グリッド */}
      {receipts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </div>
          <p className="empty-text">
            {filter === 'pending' ? '未アップロードのレシートはありません'
              : filter === 'completed' ? 'アップロード済のレシートはありません'
              : filter === 'error' ? 'エラーのレシートはありません'
              : 'レシートがまだありません'}
          </p>
          <p className="empty-hint">カメラタブから撮影してください</p>
        </div>
      ) : (
        <div className="receipt-grid">
          {receipts.map((receipt) => (
            <button
              key={receipt.id}
              className={`receipt-card ${selectMode && selectedIds.has(receipt.id!) ? 'selected' : ''}`}
              onClick={() => selectMode ? toggleSelection(receipt.id!) : onSelect(receipt)}
            >
              <div className="receipt-card-image">
                <img src={thumbnailUrls.get(receipt.id!) || ''} alt={`領収書 ${receipt.id}`} loading="lazy" />
                {selectMode ? (
                  <span className={`select-checkbox ${selectedIds.has(receipt.id!) ? 'checked' : ''}`}>
                    {selectedIds.has(receipt.id!) && '✓'}
                  </span>
                ) : (
                  <div className="card-badges">
                    <span className={getStatusBadgeClass(receipt.uploadStatus)}>
                      {getStatusLabel(receipt.uploadStatus)}
                    </span>
                    {!receipt.companyId && receipt.uploadStatus === 'pending' && (
                      <span className="status-badge no-company">会社未設定</span>
                    )}
                    {receipt.groupName && (
                      <span className="group-label">{receipt.groupName}</span>
                    )}
                  </div>
                )}
              </div>
              <div className="receipt-card-info">
                <span className="receipt-date">{formatDate(receipt.createdAt)}</span>
                <span className="receipt-payment">{receipt.paymentMethodName}</span>
                {receipt.companyName && <span className="receipt-company">{receipt.companyName}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* バッチアクションバー */}
      {selectMode && selectedIds.size > 0 && (
        <div className="batch-action-bar">
          <span className="batch-count">{selectedIds.size}枚 選択中</span>
          <div className="batch-buttons">
            {showDeleteConfirm ? (
              <>
                <button className="batch-button delete-confirm-button" onClick={handleBatchDelete}>削除する</button>
                <button className="batch-button cancel-button" onClick={() => setShowDeleteConfirm(false)}>取消</button>
              </>
            ) : (
              <>
                <button className="batch-button delete-button" onClick={() => setShowDeleteConfirm(true)} title="削除">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
                <button className="batch-button group-button" onClick={() => setShowGroupManager(true)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                    <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                  </svg>
                  まとめる
                </button>
                <button className="batch-button company-button" onClick={() => setShowCompanyAssigner(true)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 21h18" />
                    <path d="M5 21V7l8-4v18" />
                    <path d="M19 21V11l-6-4" />
                  </svg>
                  会社設定
                </button>
                <button
                  className="batch-button upload-button"
                  onClick={handleUpload}
                  disabled={isUploading}
                >
                  {isUploading ? (
                    <div className="shutter-spinner small" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  )}
                  アップロード
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 未選択時のアップロードボタン（pendingフィルター時） */}
      {!selectMode && filter === 'pending' && pendingCount > 0 && (
        <div className="upload-all-bar">
          <button className="upload-all-button" onClick={handleUpload} disabled={isUploading}>
            {isUploading ? (
              <><div className="shutter-spinner small" /> アップロード中...</>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                全てアップロード（{pendingCount}枚）
              </>
            )}
          </button>
        </div>
      )}

      {/* 会社割当モーダル */}
      {showCompanyAssigner && (
        <CompanyAssigner
          companies={companies}
          selected={null}
          onSelect={handleCompanyAssign}
          onClose={() => setShowCompanyAssigner(false)}
        />
      )}

      {/* グループ化モーダル */}
      {showGroupManager && (
        <GroupManager
          selectedCount={selectedIds.size}
          onApply={handleGroupApply}
          onCancel={() => setShowGroupManager(false)}
        />
      )}
    </div>
  );
}
