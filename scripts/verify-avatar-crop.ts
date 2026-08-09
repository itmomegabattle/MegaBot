import assert from 'node:assert/strict';
import { avatarCropRect } from '../src/avatarCrop.js';

assert.deepEqual(avatarCropRect(1200, 800, 1, -100, -100), { sourceX: 0, sourceY: 0, size: 800 });
assert.deepEqual(avatarCropRect(1200, 800, 1, 100, 100), { sourceX: 400, sourceY: 0, size: 800 });
assert.deepEqual(avatarCropRect(1200, 800, 2, 100, 100), { sourceX: 800, sourceY: 400, size: 400 });
assert.deepEqual(avatarCropRect(800, 1200, 2, -100, 100), { sourceX: 0, sourceY: 800, size: 400 });
assert.deepEqual(avatarCropRect(1000, 1000, 2, 0, 0), { sourceX: 250, sourceY: 250, size: 500 });

console.log('Avatar crop geometry checks passed.');
