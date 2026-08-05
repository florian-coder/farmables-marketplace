import { useEffect, useRef } from 'react';

/**
 * Dialog de confirmare pentru acțiuni ireversibile.
 * Înlocuiește window.confirm(), care rupe complet identitatea vizuală
 * și nu poate comunica severitatea acțiunii.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirmă',
  cancelLabel = 'Anulează',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) {
        onCancel?.();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    confirmRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, busy, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onCancel?.();
        }
      }}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-body"
      >
        <h2 className="dialog-title" id="dialog-title">
          {title}
        </h2>
        <p className="dialog-body" id="dialog-body">
          {body}
        </p>
        <div className="dialog-actions">
          <button
            className="button quiet"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            className={`button ${tone === 'danger' ? 'danger' : 'primary'}`}
            type="button"
            ref={confirmRef}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Se procesează...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
