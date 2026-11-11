import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCapabilities } from '../packages/shared/src/connector.js';
import { connectorTooOld, DEVELOPMENT_CONNECTOR_VERSION, FIRST_REPORTING_CONNECTOR_VERSION, MINIMUM_CONNECTOR_VERSION } from '../packages/shared/src/version.js';

test('only a release older than the minimum is too old; development builds and other version lines are left to their capabilities', () => {
  assert.equal(connectorTooOld(MINIMUM_CONNECTOR_VERSION), false);
  for (const [version, minimum, tooOld] of [
    ['0.23.9', '0.24.0', true], ['0.24.0', '0.24.0', false], ['0.24.0-beta.1', '0.24.0', false], ['0.9.12', '0.10.0', true],
    ['1.0.0', '0.24.0', false], ['0.24.1', '0.24.2', true], ['0.25.0', '0.24.2', false],
    ['desktop 0.8.1', '0.24.0', false], ['not a version', '0.24.0', false], [DEVELOPMENT_CONNECTOR_VERSION, '9.0.0', false],
  ] as const) assert.equal(connectorTooOld(version, minimum), tooOld, `${version} against ${minimum}`);
});

test('a connector that reports no version is older than the first release that reports one: too old once the minimum is above it', () => {
  assert.equal(FIRST_REPORTING_CONNECTOR_VERSION, '0.24.0');
  for (const missing of [undefined, null, '']) {
    assert.equal(connectorTooOld(missing, '0.24.0'), false, 'at the first reporting release, as today, nothing is refused');
    assert.equal(connectorTooOld(missing, '0.23.0'), false);
    assert.equal(connectorTooOld(missing, '0.24.1'), true, 'raising the minimum refuses connectors from before versions were reported');
    assert.equal(connectorTooOld(missing, '1.0.0'), true);
  }
  assert.equal(connectorTooOld(undefined), connectorTooOld(undefined, MINIMUM_CONNECTOR_VERSION));
});

test('stored capabilities that are missing or not an object read as none', () => {
  assert.equal(parseCapabilities('{"chatOptions":true,"platform":"linux"}').chatOptions, true);
  for (const stored of [null, undefined, '', 'null', '[]', '"text"', '{broken']) assert.deepEqual(parseCapabilities(stored), {}, String(stored));
});
