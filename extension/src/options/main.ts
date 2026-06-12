import { getApiBase, setApiBase } from '../lib/config';

const input = document.getElementById('apiBase') as HTMLInputElement;
const status = document.getElementById('status') as HTMLPreElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;

void getApiBase().then((url) => {
  input.value = url;
});

saveBtn.addEventListener('click', () => {
  void (async () => {
    const url = input.value.trim().replace(/\/$/, '');
    await setApiBase(url);
    status.textContent = 'Testing…';
    try {
      const r = await fetch(`${url}/extension/status`);
      const data = await r.json();
      status.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      status.textContent = `Error: ${e}`;
    }
  })();
});
