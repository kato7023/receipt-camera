import { useState } from 'react';
import { forceRefreshMasters, resetApiKey } from '../api';

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // スプシのマスタ編集を即時反映する（GAS側の180日キャッシュも強制クリア）
  const handleRefreshMasters = async () => {
    setIsRefreshing(true);
    setMessage(null);
    try {
      const result = await forceRefreshMasters();
      setMessage(`更新完了: 会社 ${result.companies}件 / 支払い方法 ${result.paymentMethods}件`);
    } catch (err) {
      setMessage(`更新に失敗しました: ${(err as Error).message}`);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleResetApiKey = () => {
    resetApiKey();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet compact" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>設定</h3>
          <button className="modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="settings-section">
          <button className="settings-action-button" onClick={handleRefreshMasters} disabled={isRefreshing}>
            {isRefreshing ? (
              <><div className="shutter-spinner small" /> 更新中...</>
            ) : (
              'マスタを今すぐ更新'
            )}
          </button>
          <p className="settings-hint">
            スプレッドシートの会社マスタ・支払い方法マスタを編集した後に押すと、すぐにアプリへ反映されます（サーバー側のキャッシュもクリアします）。
          </p>
          {message && <p className="settings-message">{message}</p>}
        </div>

        <div className="settings-section">
          <button className="settings-action-button secondary" onClick={handleResetApiKey}>
            合言葉（APIキー）を再設定
          </button>
          <p className="settings-hint">合言葉を入力し直したい場合に使います。</p>
        </div>

        <div className="settings-info">
          <span>バージョン: v{__APP_VERSION__}</span>
        </div>
      </div>
    </div>
  );
}
