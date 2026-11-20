const DEFAULTS = {
  selector: 'span.mc-box',
  enabled: true,
  delayMs: 150,
  oncePerElement: true
};

const READY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 300;

let settings = { ...DEFAULTS };
const clicked = new WeakSet();
let observer;
let timer;
let challengePresent = false;
let captureTimestamp = null;

function showPageToast(message, type = 'info') {
  const id = 'auto-click-toast';
  document.getElementById(id)?.remove();

  const colors = {
    info:    { bg: '#1e3a8a', border: '#3b82f6' },
    success: { bg: '#065f46', border: '#10b981' },
    error:   { bg: '#7f1d1d', border: '#ef4444' },
    loading: { bg: '#4c1d95', border: '#a78bfa' }
  };
  const c = colors[type] ?? colors.info;

  const toast = document.createElement('div');
  toast.id = id;
  toast.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    max-width: 320px;
    padding: 12px 16px;
    background: ${c.bg};
    color: #fff;
    border-left: 4px solid ${c.border};
    border-radius: 6px;
    font: 14px/1.4 system-ui, sans-serif;
    box-shadow: 0 4px 12px rgba(0,0,0,.35);
    opacity: 0;
    transform: translateY(-8px);
    transition: opacity .18s ease, transform .18s ease;
    pointer-events: none;
  `;
  toast.textContent = message;
  document.documentElement.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  if (type !== 'loading') {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-8px)';
      setTimeout(() => toast.remove(), 200);
    }, 4000);
  }
}

function readPromptText() {
  const prompt = document.querySelector('div.mc-prompt');
  if (!prompt) return { title: null, subtitle: null };
  return {
    title: prompt.querySelector('b')?.innerText.trim() ?? null,
    subtitle: prompt.querySelector('span')?.innerText.trim() ?? null
  };
}

function isChallengeReady() {
  const card = document.querySelector('.mc-card');
  if (!card) return false;

  const expired = card.querySelector('.mc-expired');
  if (expired && !expired.hasAttribute('hidden')) return false;

  const ref = card.querySelector('.mc-ref');
  const stage = card.querySelector('.mc-stage');
  if (!ref || !stage) return false;

  const refRect = ref.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  if (refRect.width === 0 || refRect.height === 0) return false;
  if (stageRect.width === 0 || stageRect.height === 0) return false;

  const { title } = readPromptText();
  if (!title) return false;

  return true;
}

function waitForChallengeReady(onReady, onTimeout) {
  const start = Date.now();
  let cancelled = false;

  function poll() {
    if (cancelled) return;
    if (isChallengeReady()) { onReady(); return; }
    if (Date.now() - start > READY_TIMEOUT_MS) { onTimeout(); return; }
    setTimeout(poll, READY_POLL_MS);
  }

  poll();
  return () => { cancelled = true; };
}

function updateChallengeState() {
  const present = !!document.querySelector('.mc-card');
  if (present === challengePresent) return;
  challengePresent = present;

  if (present) {
    showPageToast('Challenge détecté, attente du chargement…', 'info');
  } else {
    showPageToast('Challenge terminé', 'success');
  }
}

function watchAndClaimReward() {
  const claimBtn = document.querySelector('button[aria-label="Claim reward"]') ||
                   Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('Claim Now'));

  if (claimBtn && !claimBtn.dataset.claimed) {
    claimBtn.dataset.claimed = "true";
    showPageToast('Bouton "Claim Now" détecté, clic dans 1s...', 'loading');

    setTimeout(async () => {
      const result = await clickElementLikeRealMouse(claimBtn);
      if (result.ok) {
        showPageToast('Bouton "Claim Now" cliqué avec succès !', 'success');
      } else {
        showPageToast(`Clic Claim impossible : ${result.error}`, 'error');
      }
    }, 1000);
  }
}

function requestCardsCapture() {
  const ref = document.querySelector('.mc-ref');
  const stage = document.querySelector('.mc-stage');
  if (!ref || !stage) return;

  const refRect = ref.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const needScroll =
    refRect.top < 0 || refRect.bottom > innerHeight ||
    stageRect.top < 0 || stageRect.bottom > innerHeight;

  const doCapture = () => {
    const payload = {};
    for (const [key, el] of [['ref', ref], ['stage', stage]]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        chrome.runtime.sendMessage({
          type: 'captureError',
          reason: `La zone ${key} a une taille nulle après attente.`
        });
        return;
      }
      payload[key] = {
        x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio
      };
    }
    if (!Object.keys(payload).length) return;

    const prompt = readPromptText();
    chrome.runtime.sendMessage({
      type: 'captureCards',
      rects: payload,
      title: prompt.title,
      subtitle: prompt.subtitle,
      timestamp: captureTimestamp
    });
  };

  if (needScroll) {
    stage.scrollIntoView({ block: 'center', behavior: 'instant' });
    setTimeout(doCapture, 250);
  } else {
    doCapture();
  }
}

function captureAfterClick() {
  captureTimestamp = Date.now();
  const prompt = readPromptText();

  chrome.storage.local.get({ captures: [] }, (stored) => {
    const captures = stored.captures;
    captures.push({ timestamp: captureTimestamp, ...prompt });
    if (captures.length > 50) captures.shift();
    chrome.storage.local.set({ captures });
  });

  waitForChallengeReady(
    () => {
      showPageToast('Capture en cours…', 'info');
      requestCardsCapture();
    },
    () => {
      showPageToast('Capture abandonnée : chargement incomplet après 15 s', 'error');
      chrome.runtime.sendMessage({
        type: 'captureError',
        reason: 'Le chargement ne s’est pas terminé complètement après 15 s.'
      });
    }
  );
}

function isEligible(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (!settings.enabled) return false;
  if (settings.oncePerElement && clicked.has(element)) return false;
  if (element.hidden || element.getAttribute('aria-disabled') === 'true') return false;
  return true;
}

function clickMatches(root = document) {
  let matches = [];
  try {
    matches = root.querySelectorAll(settings.selector);
  } catch (error) {
    console.error('[Auto Click] Sélecteur CSS invalide :', settings.selector, error);
    return;
  }

  for (const element of matches) {
    if (!isEligible(element)) continue;
    if (settings.oncePerElement) clicked.add(element);

    window.setTimeout(async () => {
      const result = await clickElementLikeRealMouse(element);
      if (!result.ok) {
        showPageToast(`Clic impossible : ${result.error}`, 'error');
        return;
      }
      window.setTimeout(captureAfterClick, 500);
    }, Math.max(0, Number(settings.delayMs) || 0));
  }
}

function sendTrustedClick(point) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'trustedClick', point }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: 'Réponse vide du service worker.' });
    });
  });
}

function getElementCenter(element) {
  const rect = element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

async function clickElementLikeRealMouse(element) {
  const point = getElementCenter(element);
  if (!point) {
    return { ok: false, error: 'Élément invisible ou sans dimensions.' };
  }
  return sendTrustedClick(point);
}

function getVerifyButton() {
  return document.querySelector('button.mc-btn.mc-primary') ||
         document.querySelector('button[id^="vf_"]') ||
         document.querySelector('form button[type="button"]');
}

function hasNewMcBox(previousBoxes) {
  const boxes = document.querySelectorAll(settings.selector);
  return Array.from(boxes).some((box) => !previousBoxes.has(box));
}

async function clickVerifyUntilNewChallenge(previousBoxes, attempt = 0) {
  const maxAttempts = 5;

  if (hasNewMcBox(previousBoxes)) {
    showPageToast('Nouveau challenge détecté, arrêt des clics Verify.', 'info');
    return;
  }

  const verifyBtn = getVerifyButton();
  if (!verifyBtn) {
    showPageToast('Bouton Verify introuvable.', 'error');
    return;
  }

  const result = await clickElementLikeRealMouse(verifyBtn);
  if (!result.ok) {
    showPageToast(`Clic Verify impossible : ${result.error}`, 'error');
    return;
  }

  showPageToast(`Bouton Verify cliqué (${attempt + 1}/${maxAttempts}).`, 'success');
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (hasNewMcBox(previousBoxes)) {
    showPageToast('Nouveau challenge détecté, arrêt des clics Verify.', 'info');
    return;
  }

  if (document.querySelectorAll(settings.selector).length === 0) return;

  if (attempt + 1 >= maxAttempts) {
    showPageToast('Verify réessayé 5 fois, attente d’un nouveau challenge.', 'info');
    return;
  }

  await clickVerifyUntilNewChallenge(previousBoxes, attempt + 1);
}

function handleGeminiClick(coords) {
  showPageToast(`Clic automatique sur ${coords.length} monstre(s)...`, 'info');
  const previousBoxes = new Set(document.querySelectorAll(settings.selector));

  let delay = 300;
  coords.forEach((coord, index) => {
    setTimeout(async () => {
      const result = await sendTrustedClick({ x: coord.x, y: coord.y });
      if (result.ok) {
        showPageToast(`Clic souris natif ${index + 1} effectué.`, 'success');
      } else {
        showPageToast(`Clic natif ${index + 1} impossible : ${result.error}`, 'error');
      }
    }, delay);
    delay += 400;
  });

  setTimeout(() => {
    clickVerifyUntilNewChallenge(previousBoxes);
  }, delay + 500);
}

function start() {
  updateChallengeState();
  clickMatches();
  watchAndClaimReward();

  observer = new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      updateChallengeState();
      clickMatches();
      watchAndClaimReward();
    }, 50);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'captureStatus') {
    showPageToast(msg.message, msg.statusType ?? 'info');
  }

  if (msg.type === 'clickMonsters') {
    handleGeminiClick(msg.coords);
  }
});

chrome.storage.local.get({
  extensionActive: true,
  selector: 'span.mc-box',
  enabled: true,
  delayMs: 150,
  oncePerElement: true
}, (stored) => {
  settings = { ...DEFAULTS, ...stored };

  if (!stored.extensionActive) {
    showPageToast('Extension actuellement désactivée.', 'error');
    return;
  }

  start();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extensionActive) {
    if (changes.extensionActive.newValue) {
      showPageToast('Extension activée !', 'success');
      location.reload();
    } else {
      showPageToast('Extension désactivée.', 'error');
      if (observer) observer.disconnect();
    }
  }
});