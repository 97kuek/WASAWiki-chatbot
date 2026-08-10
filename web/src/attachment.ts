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
  return { dataUrl, name: file.name };
}
