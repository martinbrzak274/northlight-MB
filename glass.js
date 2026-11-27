/*
 * Small touches for the glass design: the header settles as you scroll, sections ease in as they come into view,
 * and cards catch a soft light that follows the pointer.
 *
 * It only adds polish. Without it (or for anyone who prefers reduced motion) every part of every page is already
 * visible and works. It never writes HTML and never fetches anything.
 */
(function () {
  'use strict';

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // 1. The header gets a stronger surface once the page has moved.
  var header = document.querySelector('.site-header');
  if (header) {
    var queued = false;
    var settle = function () {
      queued = false;
      header.classList.toggle('scrolled', window.scrollY > 8);
    };
    window.addEventListener('scroll', function () {
      if (!queued) { queued = true; window.requestAnimationFrame(settle); }
    }, { passive: true });
    settle();
  }

  // 2. Reveal on scroll. Only things that start below the fold are hidden, and only by this script, so nothing
  //    flashes and nothing stays hidden if the script does not run.
  if (!reduceMotion && 'IntersectionObserver' in window) {
    var targets = document.querySelectorAll('[data-reveal], .cards > li, #faq details, .site-footer');
    var perParent = new Map();
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        observer.unobserve(el);
        el.classList.add('in');
        // Afterwards drop the helper classes, so hover effects on the element work normally again.
        window.setTimeout(function () {
          el.classList.remove('reveal', 'in');
          el.style.removeProperty('--d');
        }, 1300);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0 });

    Array.prototype.forEach.call(targets, function (el) {
      var box = el.getBoundingClientRect();
      if (box.top < window.innerHeight * 0.92) return; // already on screen (or above it): leave it alone
      var count = perParent.get(el.parentNode) || 0;
      perParent.set(el.parentNode, count + 1);
      el.style.setProperty('--d', Math.min(count * 90, 360) + 'ms');
      el.classList.add('reveal');
      observer.observe(el);
    });
  }

  // 3. The hero picture leans towards the pointer, and its orbs drift at other depths. Nothing moves until the
  //    pointer does, so it costs nothing while the page is idle.
  var canHover = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var hero = document.querySelector('.hero');
  var visual = hero && hero.querySelector('.hero-visual');
  if (visual && !reduceMotion && canHover) {
    var heroFrame = 0;
    var lean = { x: 0, y: 0 };
    var apply = function () {
      heroFrame = 0;
      visual.style.setProperty('--px', lean.x.toFixed(3));
      visual.style.setProperty('--py', lean.y.toFixed(3));
    };
    hero.addEventListener('pointermove', function (event) {
      var box = hero.getBoundingClientRect();
      lean.x = ((event.clientX - box.left) / box.width - 0.5) * 2;
      lean.y = ((event.clientY - box.top) / box.height - 0.5) * 2;
      if (!heroFrame) heroFrame = window.requestAnimationFrame(apply);
    }, { passive: true });
    hero.addEventListener('pointerleave', function () {
      lean.x = 0;
      lean.y = 0;
      if (!heroFrame) heroFrame = window.requestAnimationFrame(apply);
    });
  }

  // 4. A soft light that follows the pointer over cards and panels (mouse and pen only).
  if (!reduceMotion && canHover) {
    Array.prototype.forEach.call(document.querySelectorAll('.card, .panel, .hero-visual'), function (el) {
      var frame = 0;
      var x = 0;
      var y = 0;
      el.addEventListener('pointermove', function (event) {
        var box = el.getBoundingClientRect();
        x = event.clientX - box.left;
        y = event.clientY - box.top;
        if (!frame) {
          frame = window.requestAnimationFrame(function () {
            frame = 0;
            el.style.setProperty('--mx', x + 'px');
            el.style.setProperty('--my', y + 'px');
          });
        }
      }, { passive: true });
    });
  }
})();
