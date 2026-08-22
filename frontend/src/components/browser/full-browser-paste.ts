export const FULL_BROWSER_PASTE_MAX_CODE_UNITS = 4_096;
export const FULL_BROWSER_PASTE_MAX_UTF8_BYTES = 16_384;

export interface FullBrowserPasteTransport {
  clipboardPasteFrom(text: string): void;
  focus(options?: FocusOptions): void;
  sendKey(keysym: number, code: string, down?: boolean): void;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validateFullBrowserPasteText(text: string): void {
  if (!text) throw new Error("Full browser paste text is empty");
  if (text.length > FULL_BROWSER_PASTE_MAX_CODE_UNITS) {
    throw new Error("Full browser paste text exceeds the code-unit limit");
  }
  if (text.includes("\0") || hasUnpairedSurrogate(text)) {
    throw new Error("Full browser paste text is invalid");
  }
  if (new TextEncoder().encode(text).byteLength > FULL_BROWSER_PASTE_MAX_UTF8_BYTES) {
    throw new Error("Full browser paste text exceeds the byte limit");
  }
}

/**
 * Send one human-owned paste action through the already authenticated RFB
 * viewer. Clipboard text never crosses an HTTP/API/tool boundary and callers
 * must not retain it in component state, telemetry, or browser storage.
 */
export function sendFullBrowserPaste(transport: FullBrowserPasteTransport, text: string): void {
  validateFullBrowserPasteText(text);
  transport.focus({ preventScroll: true });
  // RFB preserves message order: install the remote clipboard before issuing
  // the single Ctrl+V chord to Chromium's currently focused field.
  transport.clipboardPasteFrom(text);
  let controlDown = false;
  try {
    transport.sendKey(0xffe3, "ControlLeft", true);
    controlDown = true;
    transport.sendKey(0x76, "KeyV");
  } finally {
    if (controlDown) transport.sendKey(0xffe3, "ControlLeft", false);
  }
}
