/*
 * Bridge the Gap
 * Rebuilt for PewPlay from the original js13kGames 2015 entry
 * "Bridge The Gap!" by Varun Malhotra (MIT License, see LICENSE).
 *
 * Rules (unchanged from the original):
 *  - Press and hold to grow a bridge, release to lay it down.
 *  - If the far end lands on the next building you score +1 and move ahead.
 *  - Landing exactly on the red mid-point gives a bonus point (+2 in total).
 *  - Too short or too long and the bridge falls: game over.
 *  - Every one or two points the direction may flip ("REVERSED" mode) and
 *    you have to build from right to left.
 *
 * The play field keeps the original 500-unit width; it is scaled to fit the
 * screen and the city (previous buildings, water) extends to fill any shape.
 */
(function () {
  'use strict';

  var STORAGE = 'bridge-the-gap:';
  var FIELD = 500;          // play-field width in world units (original scene width)
  var MIN_W = 8;            // minimum building width
  var GROW_SPEED = 400;     // bridge growth, units per second (original: 2px every 5ms)
  var BRIDGE_T = 3;         // bridge thickness
  var SPOT = 6;             // red mid-point marker size
  var PAN_TIME = 0.51;      // building transition time of the original
  var COLORS = {
    bg: '#F5F5F5',
    building: '#999999',
    bridge: '#777777',
    spot: '#ff0000',
    water: '#7FC4F3',
    waterLight: '#C6E3FD',
    skyline: '#EAEAEA'
  };

  // ---------- helpers ----------
  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function rand(min, max) { return Math.random() * (max - min) + min; }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function easeIn(t) { return t * t; }
  function linear(t) { return t; }
  function hash(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function load(key, fallback) {
    try {
      var v = localStorage.getItem(STORAGE + key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(STORAGE + key, String(value)); } catch (e) { /* ignore */ }
  }

  // ---------- DOM ----------
  var root = document.getElementById('game');
  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');
  var hud = document.getElementById('hud');
  var titleEl = document.getElementById('title');
  var scoreEl = document.getElementById('score');
  var bestEl = document.getElementById('best');
  var bestBoard = document.getElementById('best-board');
  var soundBtn = document.getElementById('sound');
  var overlay = document.getElementById('overlay');
  var introEl = document.getElementById('intro');
  var reversedEl = document.getElementById('reversed');
  var bonusEl = document.getElementById('bonus');
  var gameOverEl = document.getElementById('game-over');
  var goScoreEl = document.getElementById('go-score');
  var goBestEl = document.getElementById('go-best');
  var goNewEl = document.getElementById('go-new');
  var restartBtn = document.getElementById('restart');

  // ---------- view / scaling ----------
  var view = { w: 0, h: 0, dpr: 1, s: 1, z: 1, hudH: 48, area: 0, BH: 100, overlayBottom: -1 };

  function resize() {
    var r = root.getBoundingClientRect();
    view.w = Math.max(1, r.width);
    view.h = Math.max(1, r.height);
    view.dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);

    // Header width follows the play field, like the original 500px frame.
    view.hudH = hud.offsetHeight || 48;
    view.area = Math.max(120, view.h - view.hudH);
    view.s = Math.min(view.w / 520, view.area / 440);
    var bhPx = clamp(view.area - 470 * view.s, 0.22 * view.area, 0.55 * view.area);
    view.BH = bhPx / view.s;

    var hudW = clamp(FIELD * view.s + 40, Math.min(view.w, 380), view.w);
    hud.style.width = hudW + 'px';
    view.hudH = hud.offsetHeight || 48;

    view.overlayBottom = -1;
    layoutOverlay();
    if (world) ensureFillers(true);
    draw();
  }

  function layoutOverlay() {
    var bottom = Math.round(view.BH * view.s * view.z + 6);
    if (Math.abs(bottom - view.overlayBottom) < 2) return;
    view.overlayBottom = bottom;
    overlay.style.top = view.hudH + 'px';
    overlay.style.bottom = bottom + 'px';
  }

  // ---------- game state ----------
  var world = null;
  var state = 'ready';     // ready | growing | laying | moving | falling | over
  var score = 0;
  var best = parseInt(load('best', '0'), 10) || 0;
  var bestAtStart = best;
  var soundOn = load('sound', '1') !== '0';
  var highSoundPlayed = false;
  var moveSoundOff = false;
  var reversalEvery = randInt(1, 2);
  var introHidden = false;
  var bridge = null;       // the bridge being built
  var tweens = [];
  var timers = [];
  var clock = 0;           // game time in seconds (pauses when the tab is hidden)
  var shakeUntil = 0;
  var activePointer = null;
  var keyHeld = false;
  var lastLength = 0;

  function tween(obj, prop, to, dur, ease, done) {
    tweens = tweens.filter(function (t) { return !(t.obj === obj && t.prop === prop); });
    tweens.push({ obj: obj, prop: prop, from: obj[prop], to: to, t0: clock, dur: dur, ease: ease || linear, done: done });
  }
  function after(delay, fn) { timers.push({ at: clock + delay, fn: fn }); }

  function makeBuilding(x, w, rise) {
    var b = { x: x, w: w, k: rise ? 0 : 1, dead: false, alpha: 1 };
    world.buildings.push(b);
    if (rise) tween(b, 'k', 1, 0.45, easeOut);
    return b;
  }

  function newWorld() {
    world = { buildings: [], bridges: [], camX: 0, stand: null, target: null, reversed: false };
    tweens = [];
    timers = [];
    world.stand = makeBuilding(0, randInt(MIN_W, FIELD / 2), false);
    world.target = makeTarget(false);
    ensureFillers(true);
  }

  // Create the next building to reach, relative to the current stand building.
  function makeTarget(rise) {
    var st = world.stand, tx, tw;
    if (!world.reversed) {
      tx = randInt(st.w + 5, FIELD - MIN_W);
      tw = randInt(MIN_W, FIELD - tx);
      return makeBuilding(world.camX + tx, tw, rise);
    }
    // Reversed: mirror image, the stand building sits on the right edge.
    var standLeft = FIELD - st.w;
    var right = randInt(MIN_W, standLeft - 5);
    tw = randInt(MIN_W, right);
    tx = right - tw;
    return makeBuilding(world.camX + tx, tw, rise);
  }

  function camFor(stand, reversed) {
    return reversed ? stand.x + stand.w - FIELD : stand.x;
  }

  // Keep the city behind the player filled with old buildings so that wide
  // screens never look empty.
  function ensureFillers(instant) {
    if (!world) return;
    var zMin = 0.55;
    var halfSpan = (view.w / 2) / (view.s * zMin) + 60;
    var cam = world.camTarget !== undefined ? world.camTarget : world.camX;
    var alive = world.buildings.filter(function (b) { return !b.dead; });
    if (!alive.length) return;
    if (!world.reversed) {
      var limit = cam + FIELD / 2 - halfSpan;
      var edge = alive.reduce(function (a, b) { return b.x < a.x ? b : a; });
      while (edge.x > limit) {
        var w = randInt(MIN_W + 6, 150), gap = randInt(30, 200);
        var f = makeBuilding(edge.x - gap - w, w, !instant);
        world.bridges.push({ x1: f.x + f.w, x2: edge.x + edge.w * rand(0.15, 0.85), alpha: 1 });
        edge = f;
      }
    } else {
      var limitR = cam + FIELD / 2 + halfSpan;
      var edgeR = alive.reduce(function (a, b) { return b.x + b.w > a.x + a.w ? b : a; });
      while (edgeR.x + edgeR.w < limitR) {
        var w2 = randInt(MIN_W + 6, 150), gap2 = randInt(30, 200);
        var f2 = makeBuilding(edgeR.x + edgeR.w + gap2, w2, !instant);
        world.bridges.push({ x1: edgeR.x + edgeR.w * rand(0.15, 0.85), x2: f2.x, alpha: 1 });
        edgeR = f2;
      }
    }
    // Forget things that are far away.
    var far = halfSpan + FIELD * 2;
    world.buildings = world.buildings.filter(function (b) { return Math.abs(b.x - cam - FIELD / 2) < far + b.w; });
    world.bridges = world.bridges.filter(function (br) { return Math.abs(br.x1 - cam - FIELD / 2) < far + 600; });
  }

  // ---------- scoring (ported from the original) ----------
  function setScore(v) {
    score = v;
    scoreEl.textContent = score;
  }

  function blinkBest() {
    bestBoard.classList.remove('blink');
    void bestBoard.offsetWidth;
    bestBoard.classList.add('blink');
  }

  function updateHighestScore(isGameOver) {
    if (!highSoundPlayed && score > bestAtStart) {
      play('highestScore');
      blinkBest();
      highSoundPlayed = true;
      moveSoundOff = true;
    } else if (isGameOver) {
      play('gameOver');
    }
    if (score >= best) {
      best = score;
      save('best', best);
      bestEl.textContent = best;
    }
  }

  function play(name) {
    if (window.Sfx) window.Sfx.play(name);
  }

  function setReversed(on) {
    world.reversed = on;
    if (on) {
      reversedEl.innerHTML = '<span class="arrow">&larr;</span> REVERSED';
      reversedEl.className = 'blink';
    } else {
      reversedEl.className = 'hidden';
    }
  }

  // ---------- round flow ----------
  function startBuilding(time) {
    if (state !== 'ready') return;
    if (!introHidden) {
      introHidden = true;
      introEl.classList.add('fade');
      after(1.5, function () { introEl.classList.add('hidden'); });
    }
    var st = world.stand;
    var dir = world.reversed ? -1 : 1;
    bridge = {
      pivot: dir > 0 ? st.x + st.w : st.x,
      dir: dir,
      L: 0,
      maxL: FIELD - st.w,
      angle: 0,
      alpha: 1,
      t0: time || performance.now()
    };
    state = 'growing';
  }

  function cancelBuilding() {
    if (state === 'growing') {
      bridge = null;
      state = 'ready';
    }
  }

  // Length depends on how long the press lasted (wall clock), so dropped
  // frames never shorten the bridge.
  function growBridge(time) {
    var t = Math.max(time || performance.now(), bridge.t0);
    bridge.L = Math.min(bridge.maxL, (t - bridge.t0) / 1000 * GROW_SPEED);
  }

  function stopBuilding(time) {
    if (state !== 'growing') return;
    growBridge(time);
    state = 'laying';
    var t = world.target;
    var end = bridge.pivot + bridge.dir * bridge.L;
    var mid = t.x + t.w / 2;
    var result;
    if (end < t.x || end > t.x + t.w) result = 'fail';
    else if (end > mid - 3 && end < mid + 3) result = 'bonus';
    else result = 'ok';
    bridge.end = end;
    lastLength = bridge.L;
    tween(bridge, 'angle', bridge.dir * Math.PI / 2, 0.2, easeIn, function () { landed(result); });
  }

  function landed(result) {
    if (result === 'fail') {
      state = 'falling';
      bridge.L = Math.min(bridge.L, view.BH - 1);
      tween(bridge, 'angle', bridge.dir * Math.PI, 0.3, easeIn, gameOver);
      return;
    }
    // The bridge stays in the city as part of the trail.
    world.bridges.push({ x1: Math.min(bridge.pivot, bridge.end), x2: Math.max(bridge.pivot, bridge.end), alpha: 1 });
    bridge = null;
    state = 'moving';

    if (result === 'bonus') {
      play('bonus');
      setScore(score + 2);
      bonusEl.classList.remove('show');
      void bonusEl.offsetWidth;
      bonusEl.classList.remove('hidden');
      bonusEl.classList.add('show');
      after(1.5, function () { bonusEl.classList.remove('show'); bonusEl.classList.add('hidden'); });
      updateHighestScore(false);
      moveAhead(true);
    } else {
      setScore(score + 1);
      updateHighestScore(false);
      if (score % reversalEvery === 0) {
        setReversed(!world.reversed);
        reversalEvery = randInt(1, 2);
      }
      moveAhead(false);
    }
  }

  function moveAhead(isBonus) {
    if (!isBonus && !moveSoundOff) play('moveAhead');
    moveSoundOff = false;
    after(0.3, advance);
  }

  // The building we landed on becomes the one we stand on; pan the city.
  function advance() {
    var landedOn = world.target;
    world.stand = landedOn;
    var cam = camFor(landedOn, world.reversed);
    world.camTarget = cam;

    // Buildings (and bridges) ahead of us sink into the water.
    var sL = landedOn.x, sR = landedOn.x + landedOn.w;
    world.buildings.forEach(function (b) {
      if (b === landedOn || b.dead) return;
      var ahead = world.reversed ? (b.x + b.w <= sL + 0.01) : (b.x >= sR - 0.01);
      if (ahead) {
        b.dead = true;
        tween(b, 'k', 0, 0.4, easeIn);
      }
    });
    world.bridges.forEach(function (br) {
      var ahead = world.reversed ? (br.x1 < sL - 1) : (br.x2 > sR + 1);
      if (ahead) { br.dead = true; tween(br, 'alpha', 0, 0.25, linear); }
    });

    // New target is placed relative to the final camera position.
    var oldCam = world.camX;
    world.camX = cam;
    world.target = makeTarget(true);
    world.camX = oldCam;
    tween(world, 'camX', cam, PAN_TIME, easeOut);

    ensureFillers(false);
    state = 'ready';
  }

  function gameOver() {
    state = 'over';
    shakeUntil = clock + 0.5;
    updateHighestScore(true);
    tween(bridge, 'alpha', 0, 0.35, linear);
    titleEl.classList.add('shimmer');
    reversedEl.className = 'hidden';
    goScoreEl.textContent = score;
    goBestEl.textContent = best;
    goNewEl.classList.toggle('hidden', !(highSoundPlayed && score > 0));
    gameOverEl.classList.remove('hidden');
  }

  function restart() {
    if (state !== 'over') return;
    gameOverEl.classList.add('hidden');
    titleEl.classList.remove('shimmer');
    bestBoard.classList.remove('blink');
    reversedEl.className = 'hidden';
    bonusEl.className = 'hidden';
    setScore(0);
    bestAtStart = best;
    highSoundPlayed = false;
    moveSoundOff = false;
    reversalEvery = randInt(1, 2);
    bridge = null;
    newWorld();
    state = 'ready';
    restartBtn.blur();
  }

  // ---------- update ----------
  function update(dt) {
    clock += dt;

    if (state === 'growing') growBridge();

    for (var i = 0; i < tweens.length; i++) {
      var t = tweens[i];
      var p = t.dur > 0 ? clamp((clock - t.t0) / t.dur, 0, 1) : 1;
      t.obj[t.prop] = t.from + (t.to - t.from) * t.ease(p);
      if (p >= 1) t.finished = true;
    }
    var finished = tweens.filter(function (t) { return t.finished; });
    tweens = tweens.filter(function (t) { return !t.finished; });
    finished.forEach(function (t) { if (t.done) t.done(); });

    var due = timers.filter(function (t) { return t.at <= clock; });
    timers = timers.filter(function (t) { return t.at > clock; });
    due.forEach(function (t) { t.fn(); });

    if (world) {
      world.buildings = world.buildings.filter(function (b) { return !(b.dead && b.k <= 0.001); });
      world.bridges = world.bridges.filter(function (br) { return !(br.dead && br.alpha <= 0.001); });
    }

    // Zoom out while a long bridge is growing so it always stays on screen.
    var need = 1;
    if (bridge && (state === 'growing' || state === 'laying' || state === 'falling' || state === 'over')) {
      need = Math.min(1, (view.area - 18) / ((view.BH + bridge.L) * view.s));
    }
    if (need < view.z) view.z = need;
    else view.z += (need - view.z) * Math.min(1, dt * 4);
    layoutOverlay();
  }

  // ---------- drawing ----------
  function draw() {
    var w = view.w, h = view.h, dpr = view.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    if (!world) return;

    var k = view.s * view.z;
    var shx = 0, shy = 0;
    if (clock < shakeUntil) {
      shx = rand(-2.5, 2.5);
      shy = rand(-2.5, 2.5);
    }
    var cam = world.camX;
    var cx = w / 2;
    function X(x) { return cx + (x - cam - FIELD / 2) * k + shx; }
    function Y(u) { return h - u * k + shy; }
    var BH = view.BH;

    // Faint distant skyline (parallax) so wide screens have some depth.
    ctx.fillStyle = COLORS.skyline;
    var par = 0.35, blk = 70;
    var pcam = cam * par;
    var b0 = Math.floor((pcam + FIELD / 2 - (cx + 40) / k) / blk);
    var b1 = Math.ceil((pcam + FIELD / 2 + (w - cx + 40) / k) / blk);
    for (var bi = b0; bi <= b1; bi++) {
      var r1 = hash(bi), r2 = hash(bi + 1000), r3 = hash(bi + 2000);
      if (r3 < 0.18) continue;
      var bw = blk * (0.45 + 0.5 * r1);
      var bx = bi * blk + (blk - bw) * r2;
      var bhgt = Math.min(BH * (1.25 + 1.1 * r3), BH + (view.area / k - BH) * (0.25 + 0.3 * r3));
      var sx0 = Math.round(cx + (bx - pcam - FIELD / 2) * k + shx);
      var sx1 = Math.round(cx + (bx + bw - pcam - FIELD / 2) * k + shx);
      ctx.fillRect(sx0, Y(bhgt), sx1 - sx0, bhgt * k + 4);
    }

    // Water: stepped waves like the original CSS effect (10-unit columns).
    var band = Math.max(BH * k * 0.5, h * 0.09);
    var grad = ctx.createLinearGradient(0, h, 0, h - band);
    grad.addColorStop(0, COLORS.waterLight);
    grad.addColorStop(0.5, COLORS.water);
    grad.addColorStop(1, COLORS.water);
    ctx.fillStyle = grad;
    var colW = 10;
    var firstCol = Math.floor((cam + FIELD / 2 - (cx + 20) / k) / colW);
    var lastCol = Math.ceil((cam + FIELD / 2 + (w - cx + 20) / k) / colW);
    for (var c = firstCol; c <= lastCol; c++) {
      var phase = (clock - c * 0.05) / 3;
      var wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);   // 0..1
      var top = h - band * (0.14 + 0.32 * (1 - wave)) + shy;
      var x0 = Math.floor(X(c * colW)), x1 = Math.floor(X((c + 1) * colW));
      ctx.fillRect(x0, top, x1 - x0, h - top + 4);
    }

    // Trail of bridges already crossed.
    ctx.fillStyle = COLORS.bridge;
    world.bridges.forEach(function (br) {
      ctx.globalAlpha = br.alpha;
      var bx0 = Math.round(X(br.x1)), bx1 = Math.round(X(br.x2));
      ctx.fillRect(bx0, Y(BH + BRIDGE_T), bx1 - bx0, BRIDGE_T * k);
    });
    ctx.globalAlpha = 1;

    // Buildings.
    ctx.fillStyle = COLORS.building;
    world.buildings.forEach(function (b) {
      var bx0 = Math.round(X(b.x)), bx1 = Math.round(X(b.x + b.w));
      var top = Y(BH * b.k);
      ctx.fillRect(bx0, top, Math.max(1, bx1 - bx0), h - top + 4);
    });

    // Red mid-point on the target building.
    var t = world.target;
    if (t && state !== 'over' && state !== 'falling') {
      ctx.fillStyle = COLORS.spot;
      var mid = t.x + t.w / 2;
      ctx.fillRect(X(mid - SPOT / 2), Y(BH * t.k + SPOT), SPOT * k, SPOT * k);
    }

    // The bridge being built / laid / falling.
    if (bridge && bridge.L > 0) {
      ctx.save();
      ctx.globalAlpha = bridge.alpha;
      ctx.translate(X(bridge.pivot), Y(BH));
      ctx.rotate(bridge.angle);
      ctx.fillStyle = COLORS.bridge;
      var th = Math.max(2, BRIDGE_T * k);
      ctx.fillRect(bridge.dir > 0 ? -th : 0, -bridge.L * k, th, bridge.L * k);
      ctx.restore();
    }
  }

  // ---------- main loop ----------
  var last = 0;
  function frame(now) {
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  // ---------- input ----------
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (state === 'ready' && activePointer === null) {
      activePointer = e.pointerId;
      startBuilding(e.timeStamp);
    }
    if (window.Sfx) window.Sfx.unlock();
  });
  function pointerEnd(e) {
    if (activePointer === null || e.pointerId !== activePointer) return;
    activePointer = null;
    stopBuilding(e.timeStamp);
  }
  window.addEventListener('pointerup', pointerEnd);
  window.addEventListener('pointercancel', pointerEnd);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  root.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  var HOLD_KEYS = { Space: 1, Enter: 1, ArrowUp: 1, ArrowRight: 1, ArrowLeft: 1 };
  window.addEventListener('keydown', function (e) {
    if (e.code === 'KeyM') { toggleSound(); return; }
    if (state === 'over') {
      if ((e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyR') && !e.repeat) {
        e.preventDefault();
        restart();
      }
      return;
    }
    if (!HOLD_KEYS[e.code]) return;
    e.preventDefault();
    if (e.repeat || keyHeld) return;
    if (state === 'ready' && activePointer === null) {
      keyHeld = true;
      startBuilding(e.timeStamp);
    }
    if (window.Sfx) window.Sfx.unlock();
  });
  window.addEventListener('keyup', function (e) {
    if (!HOLD_KEYS[e.code]) return;
    e.preventDefault();
    if (keyHeld) {
      keyHeld = false;
      stopBuilding(e.timeStamp);
    }
  });

  restartBtn.addEventListener('click', function () {
    if (window.Sfx) window.Sfx.unlock();
    restart();
  });

  function applySound() {
    soundBtn.classList.toggle('muted', !soundOn);
    soundBtn.setAttribute('aria-label', soundOn ? 'Mute sound' : 'Unmute sound');
    if (window.Sfx) window.Sfx.setEnabled(soundOn);
  }
  function toggleSound() {
    soundOn = !soundOn;
    save('sound', soundOn ? 1 : 0);
    if (window.Sfx) window.Sfx.unlock();
    applySound();
  }
  soundBtn.addEventListener('click', function () { toggleSound(); soundBtn.blur(); });

  // Pause cleanly when the page is hidden.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      cancelBuilding();
      activePointer = null;
      keyHeld = false;
      if (window.Sfx) window.Sfx.suspend();
    } else {
      last = 0;
      if (window.Sfx && soundOn) window.Sfx.resume();
    }
  });
  window.addEventListener('blur', function () {
    cancelBuilding();
    activePointer = null;
    keyHeld = false;
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 150); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

  // Small read-only hook, handy for automated testing.
  window.bridgeTheGap = {
    state: function () { return state; },
    score: function () { return score; },
    gap: function () {
      var st = world.stand, t = world.target;
      if (!world.reversed) return { min: t.x - (st.x + st.w), max: t.x + t.w - (st.x + st.w), mid: t.x + t.w / 2 - (st.x + st.w), reversed: false };
      return { min: st.x - (t.x + t.w), max: st.x - t.x, mid: st.x - (t.x + t.w / 2), reversed: true };
    },
    lastLength: function () { return lastLength; },
    speed: GROW_SPEED
  };

  // ---------- start ----------
  bestEl.textContent = best;
  setScore(0);
  applySound();
  newWorld();
  resize();
  requestAnimationFrame(frame);
})();
