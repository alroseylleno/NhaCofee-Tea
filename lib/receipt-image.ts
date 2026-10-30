// Getting a bill photo ready to attach to an expense.
//
// A phone photo of a bill is 3–6 MB; at 2000 px on the long edge the text stays
// legible at a tenth of the size, which keeps the bucket light and keeps UAT
// (where the file lives in browser storage) under the browser's quota. Only
// images are shrunk: a PDF, an image the browser cannot decode (HEIC outside
// Safari) or one that is already small is attached as it is.

const MAX_EDGE = 2000;
const SMALL_ENOUGH = 1_500_000;

export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
/// UAT keeps the file inside localStorage next to the whole Finance state.
export const RECEIPT_UAT_MAX_BYTES = 1_500_000;

export async function prepareReceiptFile(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || /gif|svg/i.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SMALL_ENOUGH) { bitmap.close(); return file; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); return file; }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "hoa-don"}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return file;
  }
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function isPdfReceipt(receipt: { name: string; dataUrl?: string; file?: File }) {
  return /\.pdf$/i.test(receipt.name) || receipt.file?.type === "application/pdf" || Boolean(receipt.dataUrl?.startsWith("data:application/pdf"));
}
