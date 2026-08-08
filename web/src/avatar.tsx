/**
 * アシスタントのアイコン。
 *
 * 画像が無いときは名前の頭文字を丸で描く。「画像を用意しないと見栄えが悪い」
 * 状態にすると、結局だれもアシスタントを作らなくなるため、既定でも成立させる。
 */

/** 画像は data URI だけ受け付ける。外部URLは弾かれてもここでは描かない。 */
const isDataImage = (value: string | undefined): value is string =>
  typeof value === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(value);

/**
 * 名前から色を決める。同じ名前なら常に同じ色になり、一覧で見分けがつく。
 * 彩度と明度を固定して、白文字が読める範囲から外れないようにする。
 */
function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

/** 頭文字。絵文字や結合文字で壊れないよう、コードポイント単位で1つ取る。 */
function initial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return Array.from(trimmed)[0];
}

export function AssistantAvatar({
  name,
  icon,
  size = 40,
}: {
  name: string;
  icon?: string;
  size?: number;
}) {
  if (isDataImage(icon)) {
    return (
      <img
        className="avatar"
        src={icon}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
    );
  }
  const hue = hueOf(name);
  return (
    <span
      className="avatar avatar-initial"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `hsl(${hue} 62% 42%)`,
      }}
    >
      {initial(name)}
    </span>
  );
}

/** 汎用（アシスタント未選択）の印。名前の頭文字とは別物だと分かる形にする。 */
export function DefaultAvatar({ size = 40 }: { size?: number }) {
  return (
    <span className="avatar avatar-default" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24">
        <path d="M12 3v3M7 9h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2ZM9 14h.01M15 14h.01" />
      </svg>
    </span>
  );
}

/** アイコンとして送れる最大サイズ。サーバー側の MaxIconBytes と揃える。 */
const MAX_ICON_BYTES = 96 * 1024;
const ICON_PIXELS = 128;

/**
 * 選ばれた画像を正方形へ切り出し、128pxのPNG/JPEGに縮めて data URI にする。
 *
 * 元画像をそのまま送ると、スマホの写真1枚で数MBになりFirestoreの
 * 1ドキュメント上限（約1MiB）を超える。表示は最大72pxなので、
 * ここで縮めても見た目は変わらない。
 */
export async function toIconDataURL(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = ICON_PIXELS;
  canvas.height = ICON_PIXELS;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像を読み込めませんでした");
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2, // 中央を正方形に切る
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    ICON_PIXELS,
    ICON_PIXELS,
  );
  bitmap.close();

  // PNGが大きいときはJPEGへ落とす。透過は失うが、送れないよりよい
  let url = canvas.toDataURL("image/png");
  for (const quality of [0.85, 0.7, 0.5]) {
    if (url.length <= MAX_ICON_BYTES) break;
    url = canvas.toDataURL("image/jpeg", quality);
  }
  if (url.length > MAX_ICON_BYTES) throw new Error("この画像は大きすぎます。別の画像を選んでください");
  return url;
}
