(function () {
  "use strict";

  // ---------- Config ----------
  const PALETTE = [
    "#8b5cf6", // purple
    "#14b8a6", // teal
    "#a3e635", // lime
    "#f97316", // orange
    "#e11d48", // crimson
    "#3b82f6", // blue
    "#eab308", // yellow
    "#f472b6", // pink
    "#78350f", // brown
  ];

  // Each tier scales three things at once: how much juice each small bottle
  // holds, how many bottles/colors are in play, and (for Expert) how many
  // goal bottles must be filled.
  const DIFFICULTY = {
    easy:   { smallCapacity: 4, longCapacity: 8,  smallColors: 4, buffers: 3, longBottles: 1, iterations: 70 },
    medium: { smallCapacity: 5, longCapacity: 10, smallColors: 6, buffers: 3, longBottles: 1, iterations: 150 },
    hard:   { smallCapacity: 6, longCapacity: 12, smallColors: 8, buffers: 3, longBottles: 1, iterations: 240 },
    expert: { smallCapacity: 6, longCapacity: 12, smallColors: 6, buffers: 3, longBottles: 2, iterations: 280 },
  };

  // ---------- State ----------
  let bottles = [];       // array of {capacity, units:[colors], isLong}
  let initialBottles = []; // deep copy of bottles as first dealt, for Restart
  let longIndices = [];
  let selected = -1;
  let moves = 0;
  let history = [];       // {from, to, amount, color}
  let currentDifficulty = null;
  let won = false;
  let animating = false;
  let pendingPourTimeouts = [];
  let activeAnimations = [];
  let activeRaf = 0;
  // Bumped whenever a pour is superseded (new game, restart, menu). In-flight
  // callbacks compare against it and bail rather than mutating a fresh board.
  let pourToken = 0;

  // ---------- DOM ----------
  const menuScreen = document.getElementById("menuScreen");
  const gameScreen = document.getElementById("gameScreen");
  const bottleGrid = document.getElementById("bottleGrid");
  const longBottleWrap = document.getElementById("longBottleWrap");
  const movesLabel = document.getElementById("movesLabel");
  const difficultyLabel = document.getElementById("difficultyLabel");
  const winOverlay = document.getElementById("winOverlay");
  const winStats = document.getElementById("winStats");
  const undoBtn = document.getElementById("undoBtn");
  const pourLayer = document.getElementById("pourLayer");

  document.querySelectorAll(".diff-card").forEach((btn) => {
    btn.addEventListener("click", () => startGame(btn.dataset.diff));
  });
  document.getElementById("restartBtn").addEventListener("click", restartSame);
  document.getElementById("newGameBtn").addEventListener("click", () => startGame(currentDifficulty));
  document.getElementById("menuBtn").addEventListener("click", showMenu);
  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("winNextBtn").addEventListener("click", () => {
    winOverlay.classList.add("hidden");
    startGame(currentDifficulty);
  });
  document.getElementById("winMenuBtn").addEventListener("click", () => {
    winOverlay.classList.add("hidden");
    showMenu();
  });

  function showMenu() {
    clearAnimationArtifacts();
    gameScreen.classList.add("hidden");
    menuScreen.classList.remove("hidden");
    difficultyLabel.textContent = "";
  }

  // ---------- Puzzle generation ----------
  function randInt(n) { return Math.floor(Math.random() * n); }

  function buildSolvedBottles(diffKey) {
    const cfg = DIFFICULTY[diffKey];
    const longBottles = cfg.longBottles || 1;
    const totalColors = cfg.smallColors + longBottles;
    const palette = PALETTE.slice(0, totalColors);
    const longColors = palette.slice(cfg.smallColors); // last `longBottles` colors

    const list = [];
    for (let i = 0; i < cfg.smallColors; i++) {
      list.push({ capacity: cfg.smallCapacity, units: Array(cfg.smallCapacity).fill(palette[i]), isLong: false });
    }
    for (let i = 0; i < cfg.buffers; i++) {
      list.push({ capacity: cfg.smallCapacity, units: [], isLong: false });
    }
    for (let i = 0; i < longBottles; i++) {
      list.push({ capacity: cfg.longCapacity, units: Array(cfg.longCapacity).fill(longColors[i]), isLong: true, designatedColor: longColors[i] });
    }
    return { list, iterations: cfg.iterations };
  }

  function topRunLengthOf(units) {
    if (!units.length) return 0;
    const c = units[units.length - 1];
    let cnt = 0;
    for (let k = units.length - 1; k >= 0; k--) { if (units[k] === c) cnt++; else break; }
    return cnt;
  }

  // One safe reverse-pour step: peels a color run off some bottle allowed by
  // `eligibleD` and pushes it onto some bottle allowed by `eligibleS`. This is
  // always the exact inverse of a real legal forward pour (see `scramble` doc
  // below), restricted to a subset of bottles so callers can control ordering.
  function reverseStep(list, eligibleD, eligibleS) {
    const n = list.length;
    for (let attempt = 0; attempt < 40; attempt++) {
      const dCandidates = [];
      for (let i = 0; i < n; i++) {
        if (list[i].units.length > 0 && (!eligibleD || eligibleD(i))) dCandidates.push(i);
      }
      if (dCandidates.length === 0) return false;
      const d = dCandidates[randInt(dCandidates.length)];
      const dUnits = list[d].units;
      const color = dUnits[dUnits.length - 1];
      const run = topRunLengthOf(dUnits);

      let amount;
      if (run === dUnits.length) {
        amount = 1 + randInt(run); // whole bottle is one color: any amount is safe
      } else {
        if (run < 2) continue; // can't safely peel without exposing a mismatched top
        amount = 1 + randInt(run - 1);
      }

      const sCandidates = [];
      for (let j = 0; j < n; j++) {
        if (j === d) continue;
        if (eligibleS && !eligibleS(j)) continue;
        const sUnits = list[j].units;
        if (list[j].capacity - sUnits.length < amount) continue;
        if (sUnits.length > 0 && sUnits[sUnits.length - 1] === color) continue;
        // Never fill an empty bottle to exactly full in one push: it could
        // never receive this color again, so it would lock permanently.
        if (sUnits.length === 0 && amount === list[j].capacity) continue;
        sCandidates.push(j);
      }
      if (sCandidates.length === 0) continue;
      const s = sCandidates[randInt(sCandidates.length)];

      for (let a = 0; a < amount; a++) list[s].units.push(list[d].units.pop());
      return true;
    }
    return false;
  }

  // Scrambles `list` by repeatedly undoing a hypothetical legal pour, starting
  // from the fully solved layout. Each step is the exact inverse of a real
  // forward pour, so the resulting layout is always solvable (solve it by
  // replaying the recorded steps in reverse as forward pours).
  //
  // Runs in two phases so the derived solve order always finishes by pouring
  // into the long bottle(s) last, matching the in-game rule that a long
  // bottle can't be completed until every small bottle is sorted:
  //   Phase A only peels FROM long bottles, pushing onto currently-empty
  //   small bottles -- so undoing it last (in the real solve) is always the
  //   final act, once nothing else needs sorting.
  //   Phase B scrambles everything else (small bottles + buffers), never
  //   touching the long bottle(s).
  function scramble(list, iterations) {
    // Guarantee every long bottle gets peeled at least once, so none of them
    // can end up already complete before the game even starts.
    list.forEach((b, idx) => {
      if (!b.isLong) return;
      const emptyExists = list.some((x) => !x.isLong && x.units.length === 0);
      if (!emptyExists) return;
      reverseStep(
        list,
        (i) => i === idx,
        (j) => !list[j].isLong && list[j].units.length === 0
      );
    });

    for (let guard = 0; guard < list.length * 2; guard++) {
      const emptyExists = list.some((b) => !b.isLong && b.units.length === 0);
      if (!emptyExists) break;
      reverseStep(
        list,
        (i) => list[i].isLong,
        (j) => !list[j].isLong && list[j].units.length === 0
      );
    }

    for (let t = 0; t < iterations; t++) {
      reverseStep(
        list,
        (i) => !list[i].isLong,
        (j) => !list[j].isLong
      );
    }
    return list;
  }

  function clearAnimationArtifacts() {
    pourToken++;
    animating = false;
    pendingPourTimeouts.forEach((id) => clearTimeout(id));
    pendingPourTimeouts = [];
    activeAnimations.forEach((a) => { try { a.cancel(); } catch (e) { /* already gone */ } });
    activeAnimations = [];
    if (activeRaf) { cancelAnimationFrame(activeRaf); activeRaf = 0; }
    if (pourLayer) pourLayer.textContent = "";
    document.querySelectorAll(".bottle.in-flight, .bottle.pouring").forEach((el) => {
      el.classList.remove("in-flight", "pouring");
    });
  }

  function startGame(diffKey) {
    clearAnimationArtifacts();
    currentDifficulty = diffKey;
    won = false;
    moves = 0;
    history = [];
    selected = -1;

    const { list, iterations } = buildSolvedBottles(diffKey);
    bottles = scramble(list, iterations);
    longIndices = [];
    bottles.forEach((b, i) => { if (b.isLong) longIndices.push(i); });
    initialBottles = bottles.map((b) => ({ capacity: b.capacity, units: b.units.slice(), isLong: b.isLong, designatedColor: b.designatedColor }));

    menuScreen.classList.add("hidden");
    gameScreen.classList.remove("hidden");
    winOverlay.classList.add("hidden");
    difficultyLabel.textContent = "Difficulty: " + diffKey[0].toUpperCase() + diffKey.slice(1);
    updateMovesLabel();
    render();
  }

  function restartSame() {
    if (!currentDifficulty || initialBottles.length === 0) return;
    // Reset the current puzzle back to its original dealt state (no reshuffle).
    clearAnimationArtifacts();
    won = false;
    moves = 0;
    history = [];
    selected = -1;
    bottles = initialBottles.map((b) => ({ capacity: b.capacity, units: b.units.slice(), isLong: b.isLong, designatedColor: b.designatedColor }));
    winOverlay.classList.add("hidden");
    updateMovesLabel();
    render();
  }

  // ---------- Game logic ----------
  function isCapped(bottle) {
    if (bottle.units.length !== bottle.capacity) return false;
    const first = bottle.units[0];
    return bottle.units.every((c) => c === first);
  }

  function isMono(bottle) {
    return bottle.units.length > 0 && bottle.units.every((c) => c === bottle.units[0]);
  }

  // A small (non-long) bottle counts as "settled" -- and so never blocks a
  // long bottle from completing -- once it's empty, capped, or purely holding
  // a staged fragment of some OTHER (not yet delivered) long bottle's color.
  function isSettled(bottle) {
    if (bottle.units.length === 0) return true;
    if (isCapped(bottle)) return true;
    if (isMono(bottle) && longIndices.some((idx) => bottles[idx].designatedColor === bottle.units[0])) return true;
    return false;
  }

  function isWin() {
    for (let i = 0; i < bottles.length; i++) {
      if (bottles[i].isLong) continue;
      if (bottles[i].units.length === 0) continue;
      if (!isCapped(bottles[i])) return false;
    }
    return longIndices.every((idx) => isCapped(bottles[idx]));
  }

  function topRunLength(bottle) {
    if (bottle.units.length === 0) return 0;
    const topColor = bottle.units[bottle.units.length - 1];
    let cnt = 0;
    for (let k = bottle.units.length - 1; k >= 0; k--) {
      if (bottle.units[k] === topColor) cnt++; else break;
    }
    return cnt;
  }

  // Colour is not a constraint: juice may be poured into any bottle that has
  // room, whatever is already in it. The top run of matching colour still
  // travels together, and simply stacks on top of whatever it lands on.
  function canPour(fromIdx, toIdx) {
    if (fromIdx === toIdx) return false;
    const src = bottles[fromIdx];
    const dst = bottles[toIdx];
    if (src.units.length === 0) return false;
    if (isCapped(src) || isCapped(dst)) return false;
    const destSpace = dst.capacity - dst.units.length;
    if (destSpace <= 0) return false;

    // A long/goal bottle can't be *completed* until every OTHER small bottle
    // is settled, and the source itself must end up sorted too (it may empty
    // out as a direct result of this pour). Completing means the pour caps the
    // bottle -- fills it to the brim with a single colour. Merely filling it
    // with a mix isn't finishing the goal, so that stays allowed.
    if (dst.isLong) {
      const topColor = src.units[src.units.length - 1];
      const amount = Math.min(topRunLength(src), destSpace);
      const wouldFill = dst.units.length + amount === dst.capacity;
      const wouldBeMono = dst.units.every((c) => c === topColor);
      if (wouldFill && wouldBeMono) {
        for (let k = 0; k < bottles.length; k++) {
          if (k === fromIdx || bottles[k].isLong) continue;
          if (!isSettled(bottles[k])) return false;
        }
        if (src.units.length - amount !== 0) return false;
      }
    }
    return true;
  }

  function pour(fromIdx, toIdx) {
    const src = bottles[fromIdx];
    const dst = bottles[toIdx];
    const topColor = src.units[src.units.length - 1];
    const cnt = topRunLength(src);
    const destSpace = dst.capacity - dst.units.length;
    const amount = Math.min(cnt, destSpace);
    for (let a = 0; a < amount; a++) dst.units.push(src.units.pop());
    history.push({ from: fromIdx, to: toIdx, amount, color: topColor });
    moves++;
    updateMovesLabel();
  }

  function undo() {
    if (history.length === 0 || won || animating) return;
    const last = history.pop();
    const src = bottles[last.to];
    const dst = bottles[last.from];
    for (let a = 0; a < last.amount; a++) dst.units.push(src.units.pop());
    moves = Math.max(0, moves - 1);
    updateMovesLabel();
    selected = -1;
    render();
  }

  function updateMovesLabel() {
    movesLabel.textContent = "Moves: " + moves;
  }

  function flashInvalid(idx) {
    const el = bottleGrid.querySelector(`[data-index="${idx}"]`) ||
      (longBottleWrap.querySelector(`[data-index="${idx}"]`));
    if (!el) return;
    el.classList.add("invalid");
    setTimeout(() => el.classList.remove("invalid"), 350);
  }

  function handleBottleClick(idx) {
    if (won || animating) return;
    const bottle = bottles[idx];

    if (selected === -1) {
      if (bottle.units.length === 0 || isCapped(bottle)) return;
      selected = idx;
      render();
      return;
    }

    if (selected === idx) {
      selected = -1;
      render();
      return;
    }

    if (canPour(selected, idx)) {
      animatePourThenCommit(selected, idx);
    } else {
      flashInvalid(idx);
      // If clicked bottle itself has liquid and isn't capped, switch selection to it instead
      if (bottle.units.length > 0 && !isCapped(bottle)) {
        selected = idx;
      } else {
        selected = -1;
      }
      render();
    }
  }

  // Fraction of the timeline where liquid is actually in the air. Before this
  // the bottle is lifting and travelling; after it, righting and returning.
  const POUR_FROM = 0.5;
  const POUR_TO = 0.79;
  const TILT_DEG = 58;

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // Commits the logical pour and re-renders. Shared by the animated path and
  // the no-animation fallback so both end in exactly the same state.
  function commitPour(fromIdx, toIdx) {
    pour(fromIdx, toIdx);
    animating = false;
    render();
    settleTopUnit(toIdx);
    if (isWin()) {
      won = true;
      setTimeout(showWin, 260);
    }
  }

  // Gives the liquid that just landed a short wobble, so it reads as settling
  // rather than snapping into place.
  function settleTopUnit(idx) {
    const body = document.querySelector(`.bottle[data-index="${idx}"] .bottle-body`);
    const top = body && body.lastElementChild;
    if (!top) return;
    top.classList.add("settle");
    pendingPourTimeouts.push(setTimeout(() => top.classList.remove("settle"), 640));
  }

  // Draws the falling stream for the duration of the pour. Runs off rAF and
  // re-reads both necks every frame: the source bottle is still being animated
  // underneath, so a path computed once would visibly detach from the mouth.
  function runStream(srcEl, dstEl, color, duration, token) {
    if (!pourLayer) return;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const body = document.createElementNS(SVG_NS, "path");
    body.setAttribute("class", "stream-body");
    body.setAttribute("stroke", color);
    const gloss = document.createElementNS(SVG_NS, "path");
    gloss.setAttribute("class", "stream-gloss");
    pourLayer.appendChild(body);
    pourLayer.appendChild(gloss);

    const srcNeck = srcEl.querySelector(".bottle-neck");
    const dstNeck = dstEl.querySelector(".bottle-neck");
    const started = performance.now();

    const frame = (now) => {
      if (token !== pourToken) return;
      const t = Math.min(1, (now - started) / duration);

      const s = srcNeck.getBoundingClientRect();
      const d = dstNeck.getBoundingClientRect();
      const x1 = s.left + s.width / 2;
      const y1 = s.top + s.height / 2;
      const x2 = d.left + d.width / 2;
      const y2 = d.top + 5;
      const dir = x2 >= x1 ? 1 : -1;

      // Liquid leaves the lip sideways, then gravity pulls it into a near
      // vertical drop just above the receiving mouth.
      const drop = Math.max(30, (y2 - y1) * 0.55);
      const path = `M ${x1} ${y1} C ${x1 + dir * 34} ${y1 + 12}, ${x2} ${y2 - drop}, ${x2} ${y2}`;
      body.setAttribute("d", path);
      gloss.setAttribute("d", path);

      // Stream reaches downward at the start and thins out at the end.
      const grow = Math.min(1, t / 0.16);
      const fade = t > 0.84 ? Math.max(0, 1 - (t - 0.84) / 0.16) : 1;
      const len = body.getTotalLength() || 1;
      const dash = len * (1 - grow);
      body.style.strokeDasharray = len;
      body.style.strokeDashoffset = dash;
      gloss.style.strokeDasharray = len;
      gloss.style.strokeDashoffset = dash;
      body.style.strokeWidth = 5.5 + 2 * fade;
      body.style.opacity = fade;
      gloss.style.opacity = fade * 0.8;

      if (t < 1) {
        activeRaf = requestAnimationFrame(frame);
      } else {
        body.remove();
        gloss.remove();
        activeRaf = 0;
      }
    };
    activeRaf = requestAnimationFrame(frame);
  }

  // Choreographs a pour as one continuous motion: the bottle lifts out of its
  // slot, carries over to the target, tips, empties (tipping a little further
  // as it drains, the way a real bottle does), then rights itself and glides
  // back. The logical state change is committed only once the motion ends, so
  // the final render matches exactly where the animation left the board.
  function animatePourThenCommit(fromIdx, toIdx) {
    const src = bottles[fromIdx];
    const dst = bottles[toIdx];
    const color = src.units[src.units.length - 1];
    const amount = Math.min(topRunLength(src), dst.capacity - dst.units.length);

    animating = true;
    selected = -1;
    render();

    const token = ++pourToken;
    const srcEl = document.querySelector(`.bottle[data-index="${fromIdx}"]`);
    const dstEl = document.querySelector(`.bottle[data-index="${toIdx}"]`);
    if (!srcEl || !dstEl || typeof srcEl.animate !== "function") {
      commitPour(fromIdx, toIdx);
      return;
    }

    const total = prefersReducedMotion() ? 260 : Math.min(2300, 1450 + amount * 170);
    const pourStart = total * POUR_FROM;
    const pourDur = total * (POUR_TO - POUR_FROM);

    const srcRect = srcEl.getBoundingClientRect();
    const dstRect = dstEl.getBoundingClientRect();
    const dstNeckRect = dstEl.querySelector(".bottle-neck").getBoundingClientRect();

    // Approach from whichever side the source already sits on, and tip toward
    // the target: pouring "outward" past the target would look wrong.
    const sign = (srcRect.left + srcRect.width / 2) <= (dstRect.left + dstRect.width / 2) ? 1 : -1;
    const rot = sign * TILT_DEG;
    const rad = (TILT_DEG * Math.PI) / 180;

    // Place the bottle so that, once tipped, its mouth hangs over the target
    // opening. The mouth sits `reach` from the pivot; rotating swings it by
    // (sin, cos) of the tilt, so we solve backwards for the pivot position.
    const reach = srcRect.height * 0.88;
    const mouthX = dstNeckRect.left + dstNeckRect.width / 2;
    const mouthY = dstNeckRect.top;
    const pivotX = srcRect.left + srcRect.width / 2;
    const pivotY = srcRect.top + srcRect.height * 0.88;
    let dx = mouthX - sign * reach * Math.sin(rad) - pivotX;
    let dy = mouthY - 70 + reach * Math.cos(rad) - pivotY;

    // Keep the tipped bottle on screen -- pouring between two bottles in the
    // leftmost column would otherwise swing it past the viewport edge. Nudging
    // it back is safe because the stream is recomputed per frame and stays
    // attached even when the mouth is no longer perfectly over the target.
    const margin = 10;
    const halfW = srcRect.width / 2;
    const spanLeft = Math.min(pivotX + dx, mouthX) - halfW;
    const spanRight = Math.max(pivotX + dx, mouthX) + halfW;
    if (spanLeft < margin) dx += margin - spanLeft;
    else if (spanRight > window.innerWidth - margin) dx -= spanRight - (window.innerWidth - margin);
    const spanTop = pivotY + dy - reach * Math.cos(rad);
    if (spanTop < margin) dy += margin - spanTop;

    srcEl.classList.add("in-flight", "pouring");

    const glide = "cubic-bezier(0.33, 0.02, 0.24, 1)";
    const bottleAnim = srcEl.animate([
      { offset: 0, transform: "translate(0px, 0px) rotate(0deg) scale(1)", easing: "cubic-bezier(0.3, 0, 0.2, 1)" },
      { offset: 0.13, transform: `translate(${dx * 0.06}px, -28px) rotate(0deg) scale(1.04)`, easing: glide },
      { offset: 0.36, transform: `translate(${dx * 0.64}px, ${dy * 0.64 - 20}px) rotate(${rot * 0.24}deg) scale(1.04)`, easing: glide },
      { offset: 0.5, transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(1.03)`, easing: "linear" },
      { offset: 0.79, transform: `translate(${dx}px, ${dy}px) rotate(${rot + sign * 8}deg) scale(1.03)`, easing: glide },
      { offset: 0.89, transform: `translate(${dx * 0.7}px, ${dy * 0.7 - 16}px) rotate(${rot * 0.32}deg) scale(1.03)`, easing: glide },
      { offset: 1, transform: "translate(0px, 0px) rotate(0deg) scale(1)", easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
    ], { duration: total, fill: "both" });
    activeAnimations.push(bottleAnim);

    // The receiving bottle gives a little as the liquid lands.
    const dstAnim = dstEl.animate([
      { transform: "translateY(0) scale(1)" },
      { transform: "translateY(2px) scale(1.02)" },
      { transform: "translateY(0) scale(1)" },
    ], { duration: pourDur, delay: pourStart, easing: "ease-in-out" });
    activeAnimations.push(dstAnim);

    // Kick off the liquid itself at the moment the bottle reaches full tilt.
    pendingPourTimeouts.push(setTimeout(() => {
      if (token !== pourToken) return;
      runStream(srcEl, dstEl, color, pourDur, token);

      const srcBody = srcEl.querySelector(".bottle-body");
      const dstBody = dstEl.querySelector(".bottle-body");
      const step = pourDur / amount;
      const unitDur = step * 1.1;

      // Drain top-down and fill bottom-up, one band at a time, so the levels
      // move together instead of the whole column jumping at once.
      const draining = Array.from(srcBody.children).slice(-amount);
      draining.forEach((el, i) => {
        el.style.setProperty("--pour-dur", unitDur + "ms");
        el.style.animationDelay = (amount - 1 - i) * step + "ms";
        el.classList.add("pour-unit-exit");
      });
      for (let i = 0; i < amount; i++) {
        const unit = document.createElement("div");
        unit.className = "unit pour-unit-enter";
        unit.style.background = color;
        unit.style.setProperty("--pour-dur", unitDur + "ms");
        unit.style.animationDelay = i * step + "ms";
        dstBody.appendChild(unit);
      }
    }, pourStart));

    bottleAnim.finished.then(() => {
      if (token !== pourToken) return;
      srcEl.classList.remove("in-flight", "pouring");
      bottleAnim.cancel();
      activeAnimations = [];
      if (activeRaf) { cancelAnimationFrame(activeRaf); activeRaf = 0; }
      if (pourLayer) pourLayer.textContent = "";
      commitPour(fromIdx, toIdx);
    }).catch(() => { /* cancelled by a reset -- nothing to commit */ });
  }

  function showWin() {
    winStats.textContent = `Solved in ${moves} moves on ${currentDifficulty} difficulty.`;
    winOverlay.classList.remove("hidden");
  }

  // ---------- Rendering ----------
  function createBottleEl(bottle, idx) {
    const wrap = document.createElement("div");
    wrap.className = "bottle" + (bottle.isLong ? " long-bottle" : "");
    wrap.dataset.index = idx;
    wrap.dataset.capacity = bottle.capacity;
    wrap.style.setProperty("--capacity", bottle.capacity);
    if (selected === idx) wrap.classList.add("selected");

    const neck = document.createElement("div");
    neck.className = "bottle-neck";

    const body = document.createElement("div");
    body.className = "bottle-body";

    bottle.units.forEach((color) => {
      const unit = document.createElement("div");
      unit.className = "unit";
      unit.style.background = color;
      body.appendChild(unit);
    });

    wrap.appendChild(neck);
    wrap.appendChild(body);

    if (isCapped(bottle)) {
      const cork = document.createElement("div");
      cork.className = "cork";
      wrap.appendChild(cork);
    }

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = bottle.isLong ? "Goal" : "";
    wrap.appendChild(label);

    wrap.addEventListener("click", () => handleBottleClick(idx));
    return wrap;
  }

  function render() {
    bottleGrid.innerHTML = "";
    longBottleWrap.innerHTML = "";
    bottles.forEach((bottle, idx) => {
      const el = createBottleEl(bottle, idx);
      if (bottle.isLong) {
        longBottleWrap.appendChild(el);
      } else {
        bottleGrid.appendChild(el);
      }
    });
    undoBtn.disabled = history.length === 0;
  }

  // Start on the menu screen by default.
  showMenu();
})();
