import type { Company } from '../db';

interface CompanyAssignerProps {
  companies: Company[];
  selected: Company | null;
  onSelect: (company: Company | null) => void;
  onClose: () => void;
}

export default function CompanyAssigner({ companies, selected, onSelect, onClose }: CompanyAssignerProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>会社を選択</h3>
          <button className="modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="company-list">
          <button
            className={`company-card ${!selected ? 'active' : ''}`}
            onClick={() => onSelect(null)}
          >
            <div className="company-card-icon none">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
              </svg>
            </div>
            <span>未選択（後で設定）</span>
          </button>

          {companies.map((company) => (
            <button
              key={company.id}
              className={`company-card ${selected?.id === company.id ? 'active' : ''}`}
              onClick={() => onSelect(company)}
            >
              <div className="company-card-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 21h18" />
                  <path d="M5 21V7l8-4v18" />
                  <path d="M19 21V11l-6-4" />
                </svg>
              </div>
              <span>{company.name}</span>
              {selected?.id === company.id && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="check-icon">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
