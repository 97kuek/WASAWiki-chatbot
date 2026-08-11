import { useCallback, useEffect, useRef, useState } from "react";
import { UI_TIMING } from "../config";

/** 同じ通知で表示時間を延ばさず、画面をまたいで同じ挙動にする。 */
export function useToast(durationMs = UI_TIMING.toastMs) {
  const [message, setMessage] = useState("");
  const timer = useRef<number | null>(null);
  const current = useRef("");

  const hide = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    current.current = "";
    setMessage("");
  }, []);

  const show = useCallback((next: string) => {
    if (current.current === next && timer.current !== null) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    current.current = next;
    setMessage(next);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      current.current = "";
      setMessage("");
    }, durationMs);
  }, [durationMs]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return { toast: message, showToast: show, hideToast: hide };
}
