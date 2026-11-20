// Fabrique une « vidéo de caméra » (format y4m) qui montre un QR code : Chromium l'utilise comme fausse caméra.
import { writeFileSync } from "node:fs";
import QRCode from "qrcode";
import sharp from "sharp";

export async function makeQrVideo(text: string, file: string) {
  const W = 640;
  const H = 480;
  const qr = await QRCode.toBuffer(text, { errorCorrectionLevel: "M", margin: 4, width: 260 });
  const { data } = await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite([{ input: qr, gravity: "center" }])
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const gray = data.length === W * H ? data : Buffer.from(data.filter((_, i) => i % (data.length / (W * H)) === 0));
  const chroma = Buffer.alloc((W * H) / 4, 128);
  const frames = Array.from({ length: 10 }, () => Buffer.concat([Buffer.from("FRAME\n"), gray, chroma, chroma]));
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...frames]));
}
