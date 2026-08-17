import assert from 'node:assert/strict'
import test from 'node:test'
import { imageSize } from 'image-size'
import { DISABLED_UNSAFE_IMAGE_TYPES } from '../src/security/hardenImageSizeRuntime.js'

test('vulnerable image-size codecs fail closed before parser execution', () => {
  assert.deepEqual(DISABLED_UNSAFE_IMAGE_TYPES, ['icns', 'jxl', 'jxl-stream', 'heif'])

  const craftedIcns = Buffer.alloc(16)
  craftedIcns.write('icns', 0, 'ascii')
  craftedIcns.writeUInt32BE(16, 4)
  craftedIcns.write('is32', 8, 'ascii')
  craftedIcns.writeUInt32BE(0, 12)
  assert.throws(() => imageSize(craftedIcns), /disabled file type: icns/)
})
