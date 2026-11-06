// NSH 0.4's declarations give `CryptoKey` only as a value; packages/shared/src/crypto.ts (reached through the shared
// types) names it as a type, as the DOM's declarations allow. Its members, loosely, as NSH's web crypto has them.
interface CryptoKey {
  readonly algorithm: any;
  readonly extractable: boolean;
  readonly type: any;
  readonly usages: any[];
}
