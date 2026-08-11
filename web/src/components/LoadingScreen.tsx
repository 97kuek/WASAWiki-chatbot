import { APP_URLS } from "../config";
import { Spinner } from "./Spinner";

type Props = {
  label: string;
  message?: string;
  admin?: boolean;
};

export function LoadingScreen({ label, message = label, admin = false }: Props) {
  return (
    <div className={`center app-loading${admin ? " admin-initial-loading" : ""}`} role="status" aria-label={label}>
      <img src={APP_URLS.logo} alt="WASA Chat" className="loading-wordmark" />
      <Spinner />
      <span className="muted">{message}…</span>
    </div>
  );
}
