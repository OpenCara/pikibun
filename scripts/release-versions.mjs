export const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function compareReleaseVersions(a, b) {
  const left = RELEASE_VERSION.exec(a);
  const right = RELEASE_VERSION.exec(b);
  if (!left || !right) throw new Error(`Not a release version: ${left ? b : a}`);
  for (const part of [1, 2, 3]) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  const ours = left[4].split(".");
  const theirs = right[4].split(".");
  for (let index = 0; index < Math.max(ours.length, theirs.length); index++) {
    const x = ours[index];
    const y = theirs[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function latestExtensionRelease(tags, name) {
  const prefix = `ext-${name}-v`;
  return tags
    .map(tag => tag.trim())
    .filter(tag => tag.startsWith(prefix))
    .map(tag => tag.slice(prefix.length))
    .filter(version => RELEASE_VERSION.test(version))
    .sort(compareReleaseVersions)
    .at(-1);
}
