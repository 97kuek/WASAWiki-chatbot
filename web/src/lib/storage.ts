export type StorageArea = "local" | "session";

/** Cookie全面遮断などでStorage参照が例外になっても、画面は継続させる。 */
export function readStored(area: StorageArea, key: string): string | null {
  try {
    return (area === "local" ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(area: StorageArea, key: string, value: string | null): void {
  try {
    const storage = area === "local" ? localStorage : sessionStorage;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* 保存できなくても、現在のタブでは選んだ状態を維持する */
  }
}

/** 保存済みJSONが壊れていたり別の型なら、利用できるIDだけへ正規化する。 */
export function readStoredIds(key: string): string[] {
  try {
    const parsed = JSON.parse(readStored("local", key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
