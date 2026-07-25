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

  function startGame(diffKey) {
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

  function canPour(fromIdx, toIdx) {
    if (fromIdx === toIdx) return false;
    const src = bottles[fromIdx];
    const dst = bottles[toIdx];
    if (src.units.length === 0) return false;
    if (isCapped(src) || isCapped(dst)) return false;
    const destSpace = dst.capacity - dst.units.length;
    if (destSpace <= 0) return false;
    const topColor = src.units[src.units.length - 1];
    if (dst.units.length > 0 && dst.units[dst.units.length - 1] !== topColor) return false;

    // A long/goal bottle can't be completed (filled to full with one color)
    // until every OTHER small bottle is settled, and the source itself must
    // end up sorted too -- it may empty out as a direct result of this pour.
    if (dst.isLong) {
      const amount = Math.min(topRunLength(src), destSpace);
      if (dst.units.length + amount === dst.capacity) {
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
    if (history.length === 0 || won) return;
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
    if (won) return;
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
      pour(selected, idx);
      selected = -1;
      render();
      if (isWin()) {
        won = true;
        setTimeout(showWin, 250);
      }
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
