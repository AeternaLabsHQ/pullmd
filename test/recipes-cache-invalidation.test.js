import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeRecipesHash, applyRecipesInvalidation } from '../lib/recipes.js';
import { createCache } from '../lib/cache.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = (rel) => path.join(here, 'fixtures/recipes', rel);

describe('computeRecipesHash', () => {
  it('returns a stable hex string for the same content', () => {
    const a = computeRecipesHash([fix('default.json')]);
    const b = computeRecipesHash([fix('default.json')]);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('returns a different hash when content differs', () => {
    const a = computeRecipesHash([fix('default.json')]);
    const b = computeRecipesHash([fix('default.json'), fix('user.json')]);
    assert.notEqual(a, b);
  });

  it('handles missing files gracefully (treats as empty)', () => {
    const a = computeRecipesHash([fix('default.json'), fix('does-not-exist.json')]);
    const b = computeRecipesHash([fix('default.json')]);
    assert.equal(a, b);
  });
});

describe('applyRecipesInvalidation', () => {
  it('first boot: stores hash, leaves recipes_invalidated_at unset', () => {
    const c = createCache(':memory:');
    assert.equal(c.getMeta('recipes_hash'), null);
    applyRecipesInvalidation(c, 'hash-A');
    assert.equal(c.getMeta('recipes_hash'), 'hash-A');
    // Spec: on first boot, no invalidation stamp written (existing cache rows stay valid)
    assert.equal(c.getMeta('recipes_invalidated_at'), null);
  });

  it('reboot, hash unchanged: no invalidation timestamp update', () => {
    const c = createCache(':memory:');
    applyRecipesInvalidation(c, 'hash-A');  // first boot
    const stamp = c.getMeta('recipes_invalidated_at');
    applyRecipesInvalidation(c, 'hash-A');  // unchanged
    assert.equal(c.getMeta('recipes_invalidated_at'), stamp);
  });

  it('reboot, hash changed: invalidation timestamp updates to NOW', () => {
    const c = createCache(':memory:');
    applyRecipesInvalidation(c, 'hash-A');  // first boot, no stamp yet
    applyRecipesInvalidation(c, 'hash-B');  // change!
    const stamp = c.getMeta('recipes_invalidated_at');
    assert.ok(stamp, 'invalidation stamp should be set');
    assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
