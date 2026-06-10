/**
 * ui.js - Shared SyncBeat UI helpers.
 */

(function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function confirm(options = {}) {
    const {
      title = 'Confirmar ação',
      message = 'Deseja continuar?',
      confirmLabel = 'Confirmar',
      cancelLabel = 'Cancelar',
      tone = 'default',
    } = options;

    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'sb-modal-backdrop';
      backdrop.innerHTML = `
        <section class="sb-modal sb-modal-${escapeHtml(tone)}" role="dialog" aria-modal="true" aria-labelledby="sb-modal-title">
          <div class="sb-modal-mark" aria-hidden="true"></div>
          <div class="sb-modal-copy">
            <h2 id="sb-modal-title">${escapeHtml(title)}</h2>
            <p>${escapeHtml(message)}</p>
          </div>
          <div class="sb-modal-actions">
            <button type="button" class="btn btn-ghost sb-modal-cancel">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn btn-primary sb-modal-confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </section>
      `;

      const close = (value) => {
        backdrop.classList.add('is-closing');
        document.removeEventListener('keydown', onKeydown);
        setTimeout(() => backdrop.remove(), 180);
        resolve(value);
      };

      const onKeydown = (event) => {
        if (event.key === 'Escape') close(false);
      };

      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) close(false);
      });
      backdrop.querySelector('.sb-modal-cancel').addEventListener('click', () => close(false));
      backdrop.querySelector('.sb-modal-confirm').addEventListener('click', () => close(true));

      document.body.appendChild(backdrop);
      document.addEventListener('keydown', onKeydown);
      backdrop.querySelector('.sb-modal-confirm').focus();
    });
  }

  function registerServiceWorker() {
    const isSupported = 'serviceWorker' in navigator;
    const canRegister = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSupported || !canRegister) return;

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // The app remains fully usable without PWA cache support.
      });
    });
  }

  registerServiceWorker();

  window.SyncBeatUI = { confirm, registerServiceWorker };
})();
