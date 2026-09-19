import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyModelAvailability, changeModelAvailability, reconcileSessionModel } from '../modules/modelAvailability.js';

const catalog = { all_models_by_provider: { a: [{ value: 'one' }, { value: 'two' }], b: [{ value: 'one' }, { value: 'new' }] } };
test('model changes are provider scoped and preserve disabled models in the admin catalog', () => {
  const saved = changeModelAvailability(catalog, {}, { profile: 'a', model: 'one', enabled: false });
  const options = applyModelAvailability(catalog, saved);
  assert.deepEqual(options.models_by_provider.a.map(m => m.value), ['two']);
  assert.equal(options.models_by_provider.b.length, 2);
  assert.equal(options.all_models_by_provider.a[0].enabled, false);
  assert.equal(applyModelAvailability(catalog, changeModelAvailability(catalog, saved, { profile: 'a', model: 'one', enabled: true })).models_by_provider.a.length, 2);
});
test('rejects unknown input without mutating saved state', () => {
  const saved = { a: ['one'] };
  for (const body of [ { profile: 'a', model: 'invented', enabled: true }, { profile: 'unknown', model: 'one', enabled: true }, { profile: 'a', model: 'one', enabled: 'true' }]) {
    assert.throws(() => changeModelAvailability(catalog, saved, body));
  }
  assert.deepEqual(saved, { a: ['one'] });
  assert.deepEqual(applyModelAvailability(catalog, saved).models_by_provider.a.map(m => m.value), ['one']);
});

test('last model and entire providers can be disabled and restored, including new catalog providers', () => {
  let saved = changeModelAvailability(catalog, { a: ['one'] }, { profile: 'a', model: 'one', enabled: false });
  assert.deepEqual(saved.a, []);
  saved = changeModelAvailability(catalog, saved, { profile: 'b', enabled: false });
  assert.deepEqual(applyModelAvailability(catalog, saved).models_by_provider, { a: [], b: [] });
  saved = changeModelAvailability(catalog, saved, { profile: 'b', enabled: true });
  assert.deepEqual(saved, { a: [], b: ['one', 'new'] });
});

test('repairs stale models and profiles without enabling disabled models', () => {
  const available = applyModelAvailability(catalog, { a: ['two'], b: [] });
  assert.deepEqual(reconcileSessionModel({ activeProfile: 'a', model: 'one' }, available), { activeProfile: 'a', model: 'two' });
  assert.equal(reconcileSessionModel({ activeProfile: 'removed', model: 'new' }, available).model, 'two');
  assert.equal(reconcileSessionModel({ activeProfile: 'b' }, available).activeProfile, 'a');
  assert.equal(reconcileSessionModel({ activeProfile: 'a', model: 'two' }, available).model, 'two');
  assert.throws(() => reconcileSessionModel({}, applyModelAvailability(catalog, { a: [], b: [] })), { status: 409 });
});
