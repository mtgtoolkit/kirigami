'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocks, busyError, assertNotMutating, SETUP_IN_PROGRESS_MESSAGE } = require('../../src/main/locks');

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('shared holders run concurrently', async () => {
  const locks = createLocks();
  let running = 0;
  let maxRunning = 0;
  const work = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await delay(30);
    running -= 1;
    return 'done';
  };
  const results = await Promise.all([locks.withPythonShared(work), locks.withPythonShared(work), locks.withPythonShared(work)]);
  assert.deepEqual(results, ['done', 'done', 'done']);
  assert.equal(maxRunning, 3);
  assert.deepEqual(locks.state(), { shared: 0, exclusive: false, pending: 0 });
});

test('exclusive waits for running shared holders, and new shared callers are rejected meanwhile', async () => {
  const locks = createLocks();
  const order = [];
  const gate = deferred();
  const shared = locks.withPythonShared(async () => {
    order.push('shared:start');
    await gate.promise;
    order.push('shared:end');
  });
  await delay(0);
  const exclusive = locks.withPythonExclusive(async () => {
    order.push('exclusive');
    return 42;
  });
  await delay(10);
  assert.deepEqual(order, ['shared:start'], 'exclusive must not start while a shared holder runs');
  assert.equal(locks.pythonBusy(), true, 'busy while the exclusive is pending');
  assert.deepEqual(locks.state(), { shared: 1, exclusive: false, pending: 1 });

  await assert.rejects(locks.withPythonShared(async () => 'never'), (err) => {
    assert.equal(err.message, 'Setting up the card maker components…');
    assert.equal(err.message, SETUP_IN_PROGRESS_MESSAGE);
    assert.equal(err.code, 'PYTHON_SETUP');
    return true;
  });

  gate.resolve();
  await shared;
  assert.equal(await exclusive, 42);
  assert.deepEqual(order, ['shared:start', 'shared:end', 'exclusive']);
  assert.equal(locks.pythonBusy(), false);
  assert.equal(await locks.withPythonShared(() => 'again'), 'again');
});

test('shared callers are rejected while an exclusive holder runs', async () => {
  const locks = createLocks();
  const gate = deferred();
  const exclusive = locks.withPythonExclusive(() => gate.promise);
  await delay(0);
  assert.equal(locks.state().exclusive, true);
  assert.equal(locks.pythonBusy(), true);
  await assert.rejects(locks.withPythonShared(() => 1), /Setting up the card maker components…/);
  gate.resolve('installed');
  assert.equal(await exclusive, 'installed');
  assert.equal(locks.pythonBusy(), false);
});

test('exclusive holders queue in FIFO order and never overlap', async () => {
  const locks = createLocks();
  const order = [];
  let inside = 0;
  const make = (name, ms) => async () => {
    inside += 1;
    assert.equal(inside, 1, 'exclusive holders overlap');
    order.push(`${name}:start`);
    await delay(ms);
    order.push(`${name}:end`);
    inside -= 1;
    return name;
  };
  const results = await Promise.all([
    locks.withPythonExclusive(make('a', 20)),
    locks.withPythonExclusive(make('b', 5)),
    locks.withPythonExclusive(make('c', 1)),
  ]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});

test('errors propagate and always release the lock', async () => {
  const locks = createLocks();
  await assert.rejects(locks.withPythonExclusive(async () => { throw new Error('install failed'); }), /install failed/);
  await assert.rejects(locks.withPythonExclusive(() => { throw new Error('sync throw'); }), /sync throw/);
  assert.equal(locks.pythonBusy(), false);
  await assert.rejects(locks.withPythonShared(async () => { throw new Error('helper failed'); }), /helper failed/);
  await assert.rejects(locks.withPythonShared(() => { throw new Error('sync helper'); }), /sync helper/);
  assert.deepEqual(locks.state(), { shared: 0, exclusive: false, pending: 0 });
  assert.equal(await locks.withPythonExclusive(() => 'ok'), 'ok');
});

test('invalid arguments are rejected', async () => {
  const locks = createLocks();
  await assert.rejects(locks.withPythonShared('nope'), TypeError);
  await assert.rejects(locks.withPythonExclusive(null), TypeError);
  assert.equal(locks.pythonBusy(), false);
});

test('busyError / assertNotMutating use the spec wording', () => {
  const err = busyError('Making the PDF');
  assert.equal(err.message, 'BUSY: wait until "Making the PDF" finishes');
  assert.equal(err.code, 'BUSY');
  const idle = { isMutating: () => false, active: () => null };
  assert.doesNotThrow(() => assertNotMutating(idle));
  const running = { isMutating: () => true, active: () => ({ title: 'Downloading cards' }) };
  assert.throws(() => assertNotMutating(running), { message: 'BUSY: wait until "Downloading cards" finishes', code: 'BUSY' });
});
