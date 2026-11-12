import { Image } from "nsh";
import logo from "./assets/logo.png";

// Apart from ui.tsx, as the app's only imported file: what imports the kit alone builds without it (the attach test's
// harness, whose nsh.json of its own roots it in its folder).
export function Logo(props: { size?: number }) {
  const size = () => props.size ?? 20;
  return <Image src={logo} accessibilityLabel="Pikibun" style={{ width: size(), height: size(), borderRadius: size() * 0.28 }} />;
}
