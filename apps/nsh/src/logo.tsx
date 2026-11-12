import { Image } from "nsh";
import logo from "./assets/logo.png";

export function Logo(props: { size?: number }) {
  const size = () => props.size ?? 20;
  return <Image src={logo} accessibilityLabel="Pikibun" style={{ width: size(), height: size(), borderRadius: size() * 0.28 }} />;
}
