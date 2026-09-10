// Copying to the clipboard. Layer 0: imports nothing.

/**
 * Copy text, returning whether it worked.
 *
 * Umbrel serves its apps over plain HTTP on the LAN, which is not a secure context, so
 * `navigator.clipboard` is simply undefined there. The old panel called it unconditionally, so
 * every copy button on every Umbrel install threw into a void and did nothing visible. The hidden
 * textarea is the fallback that actually runs in practice.
 */
export async function copy(text) {
  const value = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* fall through to the fallback */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
