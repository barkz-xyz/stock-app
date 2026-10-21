// Keep selected text available when the browser denies clipboard permissions.
export async function copyText(value, { field, clipboard = globalThis.navigator?.clipboard, document = globalThis.document } = {}) {
  try {
    if (typeof clipboard?.writeText === 'function') {
      await clipboard.writeText(value)
      return true
    }
  } catch { /* Try copying the selected text instead. */ }
  if (!document) return false
  const previous = document.activeElement
  const target = field || document.createElement('textarea')
  let copied = false
  try {
    if (!field) {
      target.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
      target.readOnly = true
      document.body.append(target)
    }
    target.value = value
    target.focus({ preventScroll: true })
    target.select()
    target.setSelectionRange(0, value.length)
    copied = document.execCommand?.('copy') === true
    return copied
  } catch { return false }
  finally {
    if (!field) target.remove()
    if ((!field || copied) && previous?.isConnected) previous.focus({ preventScroll: true })
  }
}
