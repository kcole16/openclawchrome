const portInput = document.getElementById('port');
const statusDiv = document.getElementById('status');
const saveBtn = document.getElementById('save');

async function loadSettings() {
  const stored = await chrome.storage.local.get(['relayPort']);
  portInput.value = stored.relayPort || 18792;
  statusDiv.textContent = '';
  statusDiv.className = 'status';
}

async function testConnection(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000)
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

saveBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);

  if (!port || port < 1 || port > 65535) {
    statusDiv.className = 'status error';
    statusDiv.textContent = 'Invalid port number';
    return;
  }

  await chrome.storage.local.set({ relayPort: port });
  const result = await testConnection(port);

  if (result.ok) {
    statusDiv.className = 'status ok';
    statusDiv.textContent = `Connected to relay at port ${port}`;
  } else {
    statusDiv.className = 'status error';
    statusDiv.textContent = `Cannot reach relay: ${result.error}`;
  }
});

loadSettings();
