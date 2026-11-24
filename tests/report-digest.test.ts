import assert from 'node:assert/strict';
import test from 'node:test';
import { ReportDigest } from '../apps/runner/src/connector/report-digest.js';
import { dropReport, holdReport, reportDigest, reportHeardAt, reportHeld, REPORT_FRESH_MS } from '../apps/server/src/report-digests.js';

const report = (title: string) => JSON.stringify([{ id: 'one', title }]);

test('a connector sends its whole report to a server that names no digest, every time it is due', async () => {
  const posted: unknown[] = [];
  const reports = new ReportDigest(60_000);
  const post = async (body: unknown) => { posted.push(body); return { ok: true }; };
  assert.equal(reports.due(report('Mine'), 1000), true);
  await reports.send(report('Mine'), post, 1000);
  assert.equal(reports.due(report('Mine'), 2000), false, 'not again until it changes or a minute passed');
  assert.equal(reports.due(report('Renamed'), 2000), true);
  assert.equal(reports.due(report('Mine'), 62_000), true);
  await reports.send(report('Mine'), post, 62_000);
  assert.deepEqual(posted, [{ sessions: [{ id: 'one', title: 'Mine' }] }, { sessions: [{ id: 'one', title: 'Mine' }] }]);
});

test('a connector sends only the digest of an unchanged report, and the report again when the server asks or it changed', async () => {
  const posted: unknown[] = [];
  let held: string | undefined;
  let refuse = false;
  const reports = new ReportDigest(60_000);
  const post = async (body: unknown) => {
    posted.push(body);
    const input = body as { sessions?: unknown[]; digest?: string };
    if (!input.sessions) {
      if (refuse) throw new Error('This server takes no digest');
      return input.digest === held ? { ok: true, digest: held } : { ok: true, resend: true };
    }
    held = `digest-of-${JSON.stringify(input.sessions).length}-${posted.length}`;
    return { ok: true, digest: held };
  };
  const sent = () => posted.splice(0).map(body => Object.keys(body as object)[0]);

  await reports.send(report('Mine'), post, 0);
  assert.deepEqual(sent(), ['sessions']);
  await reports.send(report('Mine'), post, 61_000);
  assert.deepEqual(sent(), ['digest'], 'an unchanged report goes as its digest');
  held = 'restarted';
  await reports.send(report('Mine'), post, 122_000);
  assert.deepEqual(sent(), ['digest', 'sessions'], 'a server that no longer holds it gets the report');
  await reports.send(report('Mine'), post, 183_000);
  assert.deepEqual(sent(), ['digest']);
  await reports.send(report('Renamed'), post, 184_000);
  assert.deepEqual(sent(), ['sessions'], 'a changed report is sent whole');
  refuse = true;
  await reports.send(report('Renamed'), post, 245_000);
  assert.deepEqual(sent(), ['digest', 'sessions'], 'a refused digest falls back to the report');
});

test('a server holds a report\'s digest for an hour, unless something changed what it stood for', async () => {
  const db = {};
  const other = {};
  const digest = await reportDigest([{ id: 'one' }]);
  assert.equal(digest, await reportDigest([{ id: 'one' }]));
  assert.notEqual(digest, await reportDigest([{ id: 'two' }]));
  assert.equal(reportHeld(db, 'private:host', digest, 1000), false);
  const applying = dropReport(db, 'private:host');
  assert.equal(holdReport(db, 'private:host', digest, applying, 1000), true);
  assert.equal(reportHeld(db, 'private:host', digest, 2000), true);
  assert.equal(reportHeardAt(db, 'private:host'), 2000);
  assert.equal(reportHeld(db, 'private:other', digest, 2000), false);
  assert.equal(reportHeld(other, 'private:host', digest, 2000), false, 'each database has its own');
  assert.equal(reportHeld(db, 'private:host', 'another', 2000), false);
  assert.equal(reportHeld(db, 'private:host', digest, 1000 + REPORT_FRESH_MS), false, 'after an hour the report is applied again');
  assert.equal(reportHeld(db, 'private:host', digest, 500), false, 'and when the clock went back');

  const first = dropReport(db, 'private:host');
  assert.equal(reportHeld(db, 'private:host', digest, 3000), false);
  assert.equal(reportHeardAt(db, 'private:host'), 2000, 'when the host was last heard from is kept');
  dropReport(db, 'private:host');
  assert.equal(holdReport(db, 'private:host', digest, first, 3000), false, 'a report that something changed while it was applied is not held');
  assert.equal(reportHeld(db, 'private:host', digest, 3000), false);
});
