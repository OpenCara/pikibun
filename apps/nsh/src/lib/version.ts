const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export const isVersion = (version: string) => VERSION.test(version);
export const isPrerelease = (version: string) => VERSION.exec(version)?.[4] !== undefined;

export function compareVersions(a: string, b: string): number | undefined {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return undefined;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return Math.sign(difference);
  }
  const [leftPre, rightPre] = [left[4], right[4]];
  if (!leftPre || !rightPre) return leftPre ? -1 : rightPre ? 1 : 0;
  const leftIds = leftPre.split(".");
  const rightIds = rightPre.split(".");
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index++) {
    const [x, y] = [leftIds[index], rightIds[index]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const [xNumeric, yNumeric] = [/^[0-9]+$/.test(x), /^[0-9]+$/.test(y)];
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
