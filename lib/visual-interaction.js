export async function dispatchClick(debuggee, params) {
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...params
  });
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...params
  });
}

export async function dispatchType(debuggee, text) {
  await chrome.debugger.sendCommand(debuggee, 'Input.insertText', { text });
}
