import assert from 'node:assert/strict'
import test from 'node:test'
import { shareSnapshot } from '../src/snapshot.js'

test('structural sharing retains unchanged rows through reorder, nested changes and removals', () => {
  const first = { items: [{ id: 'a', quantity: 1.25 }, { id: 'b', quantity: 2 }], sale: { lines: [{ quantity: 0.25 }], note: 'old' } }
  assert.equal(shareSnapshot(first, JSON.parse(JSON.stringify(first))), first)
  const next = shareSnapshot(first, { items: [...first.items].reverse(), sale: { lines: [{ quantity: 0.5 }] } })
  assert.equal(next.items[0], first.items[1]); assert.equal(next.items[1], first.items[0])
  assert.equal(next.sale.lines[0].quantity, 0.5); assert.equal('note' in next.sale, false)
  assert.equal(first.sale.note, 'old'); assert.equal(first.sale.lines[0].quantity, 0.25)
  assert.deepEqual(shareSnapshot(first, null), null)
  assert.deepEqual(shareSnapshot({ a: 1 }, []), [])
})
