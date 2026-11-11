import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { InstanceLockedError, InstanceLockLostError } from '../apps/server/src/db/index.js';
import { watchInstanceLock, type HeldLock } from '../apps/server/src/db/instance-lock.js';

interface FakeLock extends HeldLock { held: boolean; released: boolean }

function fakeDatabase() {
  const state = { owner: null as FakeLock | null, reachable: true, takes: 0, wake: undefined as (() => void) | undefined };
  const take = async (wake: () => void): Promise<HeldLock | null> => {
    state.takes++;
    state.wake = wake;
    if (!state.reachable) throw new Error('connect ECONNREFUSED');
    if (state.owner?.held) return null;
    const lock: FakeLock = {
      held: true, released: false,
      stillHeld: async () => { if (!state.reachable) throw new Error('connection terminated'); return lock.held; },
      release: async () => { lock.released = true; lock.held = false; if (state.owner === lock) state.owner = null; },
    };
    state.owner = lock;
    return lock;
  };
  return { state, take };
}

const quiet = { log: () => {} };
const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !condition(); i++) await sleep(5);
  assert.ok(condition(), what);
};

test('the instance lock refuses a second holder and is released once', async () => {
  const db = fakeDatabase();
  const lock = await watchInstanceLock(db.take, { intervalMs: 10, graceMs: 1000, ...quiet });
  await assert.rejects(watchInstanceLock(db.take, { intervalMs: 10, graceMs: 1000, ...quiet }), InstanceLockedError);
  const first = db.state.owner!;
  await lock.release();
  await lock.release();
  assert.equal(first.released, true);
  assert.equal(db.state.owner, null);
});

test('a lock whose connection dropped is taken again, and nobody hears it was lost', async () => {
  const db = fakeDatabase();
  const lock = await watchInstanceLock(db.take, { intervalMs: 10, graceMs: 1000, ...quiet });
  const lost: Error[] = [];
  lock.onLost?.(error => lost.push(error));
  const first = db.state.owner!;
  first.held = false;
  db.state.owner = null;
  await until(() => db.state.owner !== null && db.state.owner !== first, 'the lock is taken again');
  assert.equal(first.released, true, 'the dropped connection is closed');
  assert.deepEqual(lost, []);
  await lock.release();
});

test('a dropped connection wakes the watcher at once, without waiting for the heartbeat', async () => {
  const db = fakeDatabase();
  const lock = await watchInstanceLock(db.take, { intervalMs: 60_000, graceMs: 1000, ...quiet });
  const first = db.state.owner!;
  first.held = false;
  db.state.owner = null;
  db.state.wake!();
  await until(() => db.state.owner !== null && db.state.owner !== first, 'the lock is taken again');
  await lock.release();
});

test('another server taking the lock first means it is lost, and the listener hears it once', async () => {
  const db = fakeDatabase();
  const lock = await watchInstanceLock(db.take, { intervalMs: 10, graceMs: 1000, ...quiet });
  const lost: Error[] = [];
  lock.onLost?.(error => lost.push(error));
  db.state.owner!.held = false;
  db.state.owner = null;
  const other = await watchInstanceLock(db.take, { intervalMs: 60_000, graceMs: 1000, ...quiet });
  await until(() => lost.length > 0, 'the loss is reported');
  await sleep(40);
  assert.equal(lost.length, 1);
  assert.ok(lost[0] instanceof InstanceLockLostError);
  assert.match(lost[0].message, /another server took it/);
  const late: Error[] = [];
  lock.onLost?.(error => late.push(error));
  assert.equal(late.length, 1, 'a listener added after the loss hears it at once');
  await lock.release();
  assert.ok(db.state.owner?.held, 'releasing a lost lock leaves the other server\'s alone');
  await other.release();
});

test('an unreachable database is tolerated for the grace period, then the lock is lost', async () => {
  const db = fakeDatabase();
  let clock = 0;
  const lock = await watchInstanceLock(db.take, { intervalMs: 10, graceMs: 1000, now: () => clock, ...quiet });
  const lost: Error[] = [];
  lock.onLost?.(error => lost.push(error));
  db.state.reachable = false;
  const before = db.state.takes;
  await until(() => db.state.takes > before + 2, 'it keeps trying to take the lock again');
  assert.deepEqual(lost, []);
  clock = 999;
  db.state.reachable = true;
  db.state.owner = null;
  await until(() => db.state.owner?.held === true, 'a database back within the grace period gives the lock back');
  assert.deepEqual(lost, []);
  db.state.reachable = false;
  clock = 2000;
  await sleep(30);
  clock = 3100;
  await until(() => lost.length === 1, 'past the grace period the lock is lost');
  assert.match(lost[0].message, /unreachable/);
  await lock.release();
});
