/* ==========================================================================
   圖片載入失敗的優雅退避
   （此函式需在全域，因 HTML 的 onerror 會直接呼叫）
   ========================================================================== */
function showFallbackLogo() {
  const img = document.getElementById('brandLogo');
  const fallback = document.getElementById('brandFallback');
  if (img && fallback) {
    img.style.display = 'none';
    fallback.style.display = 'flex';
  }
}

/* ==========================================================================
   主邏輯
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  /* ---------- 1. 自動填入目前網址 ---------- */
  const currentUrl = window.location.origin + window.location.pathname;
  const isLocalFile = window.location.protocol === 'file:';
  const baseUrl = (isLocalFile
    ? 'https://你的帳號.github.io/專案名稱/'
    : currentUrl
  ).replace(/\/$/, '');

  const tosUrlEl = document.getElementById('tosUrlText');
  const privacyUrlEl = document.getElementById('privacyUrlText');
  if (tosUrlEl) tosUrlEl.textContent = `${baseUrl}/#tos`;
  if (privacyUrlEl) privacyUrlEl.textContent = `${baseUrl}/#privacy`;

  /* ---------- 2. 複製功能 ---------- */
  const copyText = async (text) => {
    // 優先使用非同步剪貼簿 API（需安全上下文）
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* 落入 fallback */
    }

    // 回退方案（相容 file:// 與舊瀏覽器）
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);

    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  };

  const showToast = (message) => {
    const toast = document.getElementById('toastMessage');
    const toastText = document.getElementById('toastText');
    if (!toast || !toastText) return;

    toastText.textContent = message;
    toast.classList.add('show');

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2600);
  };

  document.querySelectorAll('.terminal-copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.target;
      const boxId = btn.dataset.box;
      const textEl = document.getElementById(targetId);
      const box = document.getElementById(boxId);
      const label = btn.querySelector('.btn-label');

      if (!textEl) return;

      const success = await copyText(textEl.textContent.trim());

      if (!success) {
        showToast('複製失敗，請手動選取複製。');
        return;
      }

      // 成功視覺回饋
      box?.classList.add('copied');
      btn.classList.add('copied');
      if (label) label.textContent = 'COPIED';

      showToast('連結已複製，可直接貼到 Discord 後台。');

      clearTimeout(btn._resetTimer);
      btn._resetTimer = setTimeout(() => {
        box?.classList.remove('copied');
        btn.classList.remove('copied');
        if (label) label.textContent = 'COPY';
      }, 2600);
    });
  });

  /* ---------- 3. 滾動進度條 ---------- */
  const progressBar = document.getElementById('scrollProgress');

  const updateProgress = () => {
    if (!progressBar) return;
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const ratio = max > 0 ? doc.scrollTop / max : 0;
    progressBar.style.transform = `scaleX(${ratio})`;
  };

  updateProgress();
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress);

  /* ---------- 4. 導覽列高亮（IntersectionObserver） ---------- */
  const navLinks = document.querySelectorAll('.nav-links a[data-nav]');
  const sections = Array.from(document.querySelectorAll('.doc-section'));

  const setActiveNav = (id) => {
    navLinks.forEach((link) => {
      link.classList.toggle('active', link.dataset.nav === id);
    });
  };

  if ('IntersectionObserver' in window && sections.length) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

        if (visible.length > 0) {
          setActiveNav(visible[0].target.id);
        }
      },
      {
        rootMargin: '-30% 0px -60% 0px',
        threshold: 0,
      }
    );

    sections.forEach((section) => observer.observe(section));
  }

  /* ---------- 5. 卡片滑鼠光斑 ---------- */
  const cards = document.querySelectorAll('.doc-section');

  cards.forEach((card) => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--x', `${e.clientX - rect.left}px`);
      card.style.setProperty('--y', `${e.clientY - rect.top}px`);
    });
  });
});