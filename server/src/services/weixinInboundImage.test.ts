import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import test from 'node:test'
import {
  decodeWeixinImageAesKey,
  downloadWeixinInboundImages,
  weixinInboundImageCount,
  weixinInboundImageReferenceHash,
} from './weixinInboundImage.js'

test('decodes all observed Weixin AES key encodings', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  assert.deepEqual(decodeWeixinImageAesKey(key.toString('hex')), key)
  assert.deepEqual(decodeWeixinImageAesKey(key.toString('base64')), key)
  assert.deepEqual(decodeWeixinImageAesKey(Buffer.from(key.toString('hex')).toString('base64')), key)
})

test('downloads and decrypts a Weixin image into an Agent image block', async () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const image = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('test-image-content'),
  ])
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const ciphertext = Buffer.concat([cipher.update(image), cipher.final()])
  const message = {
    item_list: [{
      type: 2,
      image_item: {
        aeskey: key.toString('hex'),
        media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?ticket=test' },
      },
    }],
  }
  const fetchImpl = (async () => new Response(ciphertext, {
    status: 200,
    headers: { 'content-length': String(ciphertext.length) },
  })) as typeof fetch

  const images = await downloadWeixinInboundImages(message, fetchImpl)
  assert.equal(images.length, 1)
  assert.equal(images[0].mediaType, 'image/png')
  assert.equal(images[0].byteSize, image.length)
  assert.equal(images[0].dataBase64, image.toString('base64'))
  assert.equal(images[0].sha256, createHash('sha256').update(image).digest('hex'))
  assert.equal(weixinInboundImageCount(message), 1)
  assert.equal(weixinInboundImageReferenceHash(message).length, 64)
})

test('rejects image download URLs outside the Weixin HTTPS allowlist', async () => {
  await assert.rejects(
    downloadWeixinInboundImages({
      item_list: [{ type: 2, image_item: { media: { full_url: 'https://example.com/image.png' } } }],
    }, async () => new Response('not-called') as never),
    /不在允许列表/,
  )
})
