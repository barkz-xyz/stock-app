import assert from 'node:assert/strict'
import test from 'node:test'
import { copyText } from '../src/copyText.js'

test('copying uses the clipboard when permitted and falls back to selected text when denied', async () => {
  let copied, focused = false, selected = false
  assert.equal(await copyText('sample-key', { clipboard: { writeText: async value => { copied = value } }, document: null }), true)
  assert.equal(copied, 'sample-key')
  const field = { value: '', focus() { focused = true }, select() { selected = true }, setSelectionRange(start, end) { assert.equal(start, 0); assert.equal(end, 10) } }
  const denied = { writeText: async () => { throw new Error('Permission denied') } }
  assert.equal(await copyText('sample-key', { clipboard: denied, field, document: { execCommand: command => command === 'copy' } }), true)
  assert.equal(field.value, 'sample-key')
  assert.ok(focused && selected)
  selected = false
  assert.equal(await copyText('sample-key', { clipboard: denied, field, document: { execCommand: () => false } }), false)
  assert.ok(selected, 'When both copy methods fail the secret remains selected for manual copy')
  assert.equal(await copyText('sample-key', { clipboard: null, document: null }), false)
})
