import { Canvas, computed, Path2D } from "nsh";
import { encodeQr, qrPath } from "../lib/qr";

export function QrCode(props: { value: string; size?: number; label?: string; testID?: string }) {
  const shape = computed(() => {
    const matrix = encodeQr(props.value);
    return { modules: matrix.length + 8, path: new Path2D(qrPath(matrix)) };
  });
  const size = () => props.size ?? 208;
  return (
    <Canvas testID={props.testID} accessible accessibilityLabel={props.label ?? "QR code"} role="image"
      style={{ width: size(), height: size(), flexShrink: 0, borderRadius: 6 }}
      draw={(cx, area) => {
        const { modules, path } = shape();
        cx.fillStyle = "#ffffff";
        cx.fillRect(0, 0, area.width, area.height);
        const scale = Math.min(area.width, area.height) / modules;
        cx.scale(scale, scale);
        cx.fillStyle = "#000000";
        cx.fill(path);
      }} />
  );
}
