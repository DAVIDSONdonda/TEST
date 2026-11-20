function render(captures) {
  const tbody = document.querySelector('#rows');
  tbody.innerHTML = '';
  for (const c of captures.slice().reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(c.timestamp).toLocaleString('fr-FR')}</td>
      <td>${c.title ?? '<em>—</em>'}</td>
      <td>${c.subtitle ?? '<em>—</em>'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function load() {
  chrome.storage.local.get({ captures: [] }, (stored) => render(stored.captures));
}

document.querySelector('#refresh').addEventListener('click', load);

document.querySelector('#clear').addEventListener('click', () => {
  if (!confirm('Vider tout l’historique des captures ?')) return;
  chrome.storage.local.set({ captures: [] }, load);
});

load();