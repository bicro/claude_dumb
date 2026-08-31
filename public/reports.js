(() => {
  document.querySelectorAll('a[download]').forEach(link => {
    link.addEventListener('click', () => {
      window.posthog?.capture('daily_dispatch_downloaded', {
        report_day: location.pathname.split('/').pop(),
      });
    });
  });

  const rail = document.getElementById('dispatch-rail');
  if (!rail) return;

  const cards = [...rail.querySelectorAll('.dispatch-card')];
  const previous = document.getElementById('dispatch-prev');
  const next = document.getElementById('dispatch-next');
  const position = document.getElementById('dispatch-position');

  if (!cards.length) {
    if (position) position.textContent = '0 / 0';
    if (previous) previous.disabled = true;
    if (next) next.disabled = true;
    return;
  }

  function currentIndex() {
    const railLeft = rail.getBoundingClientRect().left;
    let closest = 0;
    let distance = Infinity;
    cards.forEach((card, index) => {
      const candidate = Math.abs(card.getBoundingClientRect().left - railLeft);
      if (candidate < distance) {
        closest = index;
        distance = candidate;
      }
    });
    return closest;
  }

  function updatePosition() {
    if (position) position.textContent = `${currentIndex() + 1} / ${cards.length}`;
  }

  function move(direction) {
    const target = Math.min(Math.max(currentIndex() + direction, 0), cards.length - 1);
    cards[target]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  }

  previous?.addEventListener('click', () => move(-1));
  next?.addEventListener('click', () => move(1));
  rail.addEventListener('scroll', () => requestAnimationFrame(updatePosition), { passive: true });
  updatePosition();

  const seen = new Set();
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.65) return;
      const day = entry.target.dataset.reportDay;
      if (!day || seen.has(day)) return;
      seen.add(day);
      window.posthog?.capture('daily_dispatch_viewed', { report_day: day });
    });
  }, { root: rail, threshold: [0.65] });
  cards.forEach(card => observer.observe(card));

})();
