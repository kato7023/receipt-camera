import { useState } from 'react';

interface PickerItem {
  id: string;
  name: string;
  isMajor: boolean;
  shortName?: string;
}

interface ButtonPickerProps<T extends PickerItem> {
  items: T[];
  selected: T | null;
  onSelect: (item: T) => void;
}

export default function ButtonPicker<T extends PickerItem>({ items, selected, onSelect }: ButtonPickerProps<T>) {
  const [showDropdown, setShowDropdown] = useState(false);

  const majorItems = items.filter((i) => i.isMajor);
  const otherItems = items.filter((i) => !i.isMajor);

  return (
    <div className="picker">
      <div className="picker-buttons">
        {majorItems.map((item) => (
          <button
            key={item.id}
            className={`picker-button ${selected?.id === item.id ? 'active' : ''}`}
            onClick={() => onSelect(item)}
          >
            {item.shortName || item.name}
          </button>
        ))}

        {otherItems.length > 0 && (
          <div className="picker-dropdown-container">
            <button
              className={`picker-button picker-other ${otherItems.some((i) => i.id === selected?.id) ? 'active' : ''}`}
              onClick={() => setShowDropdown(!showDropdown)}
            >
              {(() => {
                const activeOther = otherItems.find((i) => i.id === selected?.id);
                return activeOther ? (activeOther.shortName || activeOther.name) : 'その他';
              })()}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {showDropdown && (
              <div className="picker-dropdown">
                {otherItems.map((item) => (
                  <button
                    key={item.id}
                    className={`picker-dropdown-item ${selected?.id === item.id ? 'active' : ''}`}
                    onClick={() => {
                      onSelect(item);
                      setShowDropdown(false);
                    }}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
