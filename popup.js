const apiKey = document.querySelector('#apiKey');
const modelSelect = document.querySelector('#modelSelect');
const providerSelect = document.querySelector('#providerSelect');
const deepseekApiKey = document.querySelector('#deepseekApiKey');
const deepseekModelSelect = document.querySelector('#deepseekModelSelect');
const extensionActive = document.querySelector('#extensionActive');
const downloadImages = document.querySelector('#downloadImages');
const useRenderServer = document.querySelector('#useRenderServer');
const renderApiUrl = document.querySelector('#renderApiUrl');
const useLocalServer = document.querySelector('#useLocalServer');
const localApiUrl = document.querySelector('#localApiUrl');
const status = document.querySelector('#status');

chrome.storage.local.get({
  geminiApiKey: '',
  geminiModel: 'gemini-3.5-flash-lite',
  aiProvider: 'gemini',
  deepseekApiKey: '',
  deepseekModel: 'deepseek-flash',
  extensionActive: true,
  downloadImages: true,
  useRenderServer: false,
  renderApiUrl: 'https://only-faucet.onrender.com',
  useLocalServer: false,
  localApiUrl: 'http://127.0.0.1:3000'
}, (values) => {
  apiKey.value = values.geminiApiKey;
  modelSelect.value = values.geminiModel;
  providerSelect.value = values.aiProvider;
  deepseekApiKey.value = values.deepseekApiKey;
  deepseekModelSelect.value = values.deepseekModel;
  extensionActive.checked = values.extensionActive;
  downloadImages.checked = values.downloadImages;
  useRenderServer.checked = values.useRenderServer;
  renderApiUrl.value = values.renderApiUrl;
  useLocalServer.checked = values.useLocalServer;
  localApiUrl.value = values.localApiUrl;
});

document.querySelector('#save').addEventListener('click', () => {
  const useRender = useRenderServer.checked;
  const useLocal = useLocalServer.checked;
  const key = apiKey.value.trim();
  const deepseekKey = deepseekApiKey.value.trim();

  if (!useRender && !useLocal && providerSelect.value === 'gemini' && !key) {
    status.textContent = 'Veuillez coller la clé API Gemini ou activer un serveur (Render / Local).';
    status.style.color = '#dc2626';
    return;
  }

  if (!useRender && !useLocal && providerSelect.value === 'deepseek' && !deepseekKey) {
    status.textContent = 'Veuillez coller la clé API DeepSeek ou activer un serveur (Render / Local).';
    status.style.color = '#dc2626';
    return;
  }

  chrome.storage.local.set({
    geminiApiKey: key,
    geminiModel: modelSelect.value,
    aiProvider: providerSelect.value,
    deepseekApiKey: deepseekKey,
    deepseekModel: deepseekModelSelect.value,
    extensionActive: extensionActive.checked,
    downloadImages: downloadImages.checked,
    useRenderServer: useRender,
    renderApiUrl: renderApiUrl.value.trim() || 'https://only-faucet.onrender.com',
    useLocalServer: useLocal,
    localApiUrl: localApiUrl.value.trim() || 'http://127.0.0.1:3000'
  }, () => {
    if (chrome.runtime.lastError) {
      status.textContent = `Erreur : ${chrome.runtime.lastError.message}`;
      status.style.color = '#dc2626';
      return;
    }
    status.textContent = 'Configuration enregistrée avec succès !';
    status.style.color = '#059669';
  });
});
