/**
 * 質問に添える画像の下ごしらえ。
 *
 * **原寸のまま送らない。** スマホの写真は1枚で数MBあり、そのまま送ると
 * リクエストが通らないうえ、モデルへの入力費用も無駄に増える。
 * ブラウザで長辺768pxまで縮めてから data URI にする。
 *
 * 768pxにしているのは、Geminiが画像をタイルに分けて処理する単位（768px）に
 * 合わせるためである。これ以上大きくしても、読み取れる情報はほとんど増えない。
 *
 * ここで縮めても、サーバーは**受け取ったバイト列を自分で検証する**
 * （backend/internal/server/attachment.go）。画面側の申告は信用されない。
 */

/** 長辺の最大画素数。Geminiが画像を処理するタイルの一辺に合わせている。 */
const MAX_EDGE_PIXELS = 768;

/** サーバー側の上限（400KB）に対する、data URI としての余裕を見た上限。 */
const MAX_DATA_URL_LENGTH = 520_000;

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type Attachment = {
  /** data URI。そのまま `<img src>` にも、APIへの送信にも使う。 */
  dataUrl: string;
  name: string;
};

function scaledSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE_PIXELS) return { width, height };
  const ratio = MAX_EDGE_PIXELS / longest;
  // 1px未満に潰れると canvas が作れないので、必ず1以上にする
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** チップに出す名前の長さ。これを超えたら真ん中を省く。 */
const MAX_NAME_RUNES = 24;

/**
 * 長いファイル名を、**拡張子を残したまま**短くする。
 *
 * 末尾を切ると「これは何のファイルか」が分からなくなる。真ん中を省けば、
 * 先頭の見分けと拡張子の両方が残る。CSSの省略記号でも見た目は整うが、
 * 文字列そのものを短くしておくと読み上げや折り返しでも破綻しない。
 */
export function shortenFileName(name: string, max: number = MAX_NAME_RUNES): string {
  const runes = Array.from(name);
  if (runes.length <= max) return name;

  const dot = name.lastIndexOf(".");
  // 拡張子が無い、または長すぎる（＝拡張子ではない）ときは末尾を省くだけ
  const extension = dot > 0 && runes.length - dot <= 6 ? name.slice(dot) : "";
  const head = Array.from(name.slice(0, name.length - extension.length));
  const keep = Math.max(1, max - Array.from(extension).length - 1);
  return head.slice(0, keep).join("") + "…" + extension;
}

export async function toAttachment(file: File): Promise<Attachment> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
    throw new Error("画像はJPEG・PNG・WebPだけ添付できます");
  }

  const bitmap = await createImageBitmap(file);
  const size = scaledSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("画像を読み込めませんでした");
  }
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();

  // 透過は失うがJPEGで送る。ミーム画像も写真も、透過が要る場面がない
  let dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  for (const quality of [0.7, 0.55]) {
    if (dataUrl.length <= MAX_DATA_URL_LENGTH) break;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > MAX_DATA_URL_LENGTH) {
    throw new Error("この画像は大きすぎます。別の画像を選んでください");
  }
  return { dataUrl, name: shortenFileName(file.name) };
}
