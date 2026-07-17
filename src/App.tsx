import { useState, useCallback, useEffect } from 'react';
import CameraView from './components/CameraView';
import ReceiptList from './components/ReceiptList';
import ReceiptDetail from './components/ReceiptDetail';
import SettingsModal from './components/SettingsModal';
import { reconcilePendingUploads, backupPendingReceipts, ensureApiKey, autoProcessPendingReceipts, enrichPendingReceipts, scheduleAutoUpload } from './api';
import type { Receipt } from './db';

type TabType = 'camera' | 'list';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>('camera');
  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);

  const refresh = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  // 撮影後は連写が落ち着くのを待ってから（30秒デバウンス）自動アップロードを実行
  const handleCapture = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
    scheduleAutoUpload(refresh, 30000);
  }, [refresh]);

  const handleSelectReceipt = useCallback((receipt: Receipt) => {
    setSelectedReceipt(receipt);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedReceipt(null);
  }, []);

  // 編集（会社設定・金額入力など）で保留が解除された可能性があるため、
  // 少し待ってから自動アップロードを実行する
  const handleUpdate = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
    scheduleAutoUpload(refresh, 5000);
  }, [refresh]);

  // 起動時にストレージの永続化をOSへ要求する。
  // iOSは空き容量が減るとサイトデータ（合言葉・未アップロード領収書）を予告なく
  // 削除することがあるため、自動削除の対象から外すよう登録する（保証ではなく強い要求）。
  useEffect(() => {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((granted) => {
        console.log('storage.persist:', granted ? 'granted' : 'denied');
      });
    }
  }, []);

  // 起動時にAPIキー（合言葉）が未設定なら入力を求める
  // （GAS側のScript Properties「API_KEY」と一致しないと全APIが拒否される）
  useEffect(() => {
    ensureApiKey();
  }, []);

  // 起動時に「'uploading'のまま止まっているレシート」をGASへ問い合わせて解消し、
  // その後、保留理由のない未アップロードレシートを自動アップロード、
  // さらにAI推測（OCR→過去照合→申請の自動補完）の待ち分を処理する
  useEffect(() => {
    reconcilePendingUploads()
      .then(() => {
        setRefreshKey((prev) => prev + 1);
        return autoProcessPendingReceipts();
      })
      .then(async (processed) => {
        const enriched = await enrichPendingReceipts();
        if (processed + enriched > 0) setRefreshKey((prev) => prev + 1);
      });
  }, []);

  // 起動時に、撮影直後のバックグラウンドバックアップに失敗したままのレシートを再試行する
  useEffect(() => {
    backupPendingReceipts();
  }, []);

  return (
    <div className="app">
      {/* ヘッダー */}
      <header className="app-header">
        <div className="app-logo">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
            <path d="M8 10h8" />
            <path d="M8 14h4" />
          </svg>
          <h1>レシートカメラ Pro</h1>
        </div>
        <div className="header-right">
          <span className="app-version">v{__APP_VERSION__}</span>
          <button className="settings-button" onClick={() => setShowSettings(true)} aria-label="設定">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="app-main">
        {activeTab === 'camera' ? (
          <CameraView onCapture={handleCapture} />
        ) : (
          <ReceiptList
            onSelect={handleSelectReceipt}
            refreshKey={refreshKey}
          />
        )}
      </main>

      {/* ボトムナビゲーション */}
      <nav className="bottom-nav">
        <button
          className={`nav-tab ${activeTab === 'camera' ? 'active' : ''}`}
          onClick={() => setActiveTab('camera')}
          aria-label="撮影"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
            <circle cx="12" cy="13" r="3" />
          </svg>
          <span>撮影</span>
        </button>
        <button
          className={`nav-tab ${activeTab === 'list' ? 'active' : ''}`}
          onClick={() => setActiveTab('list')}
          aria-label="一覧"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
          <span>一覧</span>
        </button>
      </nav>

      {/* 詳細画面オーバーレイ */}
      {selectedReceipt && (
        <ReceiptDetail
          receipt={selectedReceipt}
          onClose={handleCloseDetail}
          onUpdate={handleUpdate}
        />
      )}

      {/* 設定モーダル */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
