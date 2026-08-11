type Props = {
  message: string;
  onClose: () => void;
};

export function Toast({ message, onClose }: Props) {
  return (
    <>
      <div className="visually-hidden" role="status" aria-live="polite">{message}</div>
      {message && (
        <div className="toast" key={message}>
          <span aria-hidden="true">{message}</span>
          <button type="button" onClick={onClose} aria-label="通知を閉じる">×</button>
        </div>
      )}
    </>
  );
}
