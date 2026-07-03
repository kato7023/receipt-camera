import { useState, useEffect } from 'react';
import { getExistingGroupNames } from '../db';

interface GroupManagerProps {
  selectedCount: number;
  onApply: (groupName: string) => void;
  onCancel: () => void;
}

export default function GroupManager({ selectedCount, onApply, onCancel }: GroupManagerProps) {
  const [groupName, setGroupName] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    getExistingGroupNames().then(setSuggestions);
  }, []);

  const handleApply = () => {
    if (groupName.trim()) {
      onApply(groupName.trim());
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-sheet compact" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{selectedCount}枚をグループ化</h3>
          <button className="modal-close" onClick={onCancel}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="group-input-area">
          <input
            type="text"
            className="group-input"
            placeholder="グループ名を入力（例: 6/30 出張）"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            autoFocus
          />

          {suggestions.length > 0 && (
            <div className="group-suggestions">
              <span className="group-suggestions-label">履歴:</span>
              {suggestions.map((name) => (
                <button
                  key={name}
                  className={`group-suggestion-chip ${groupName === name ? 'active' : ''}`}
                  onClick={() => setGroupName(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="modal-button cancel" onClick={onCancel}>キャンセル</button>
          <button className="modal-button primary" onClick={handleApply} disabled={!groupName.trim()}>グループ化</button>
        </div>
      </div>
    </div>
  );
}
