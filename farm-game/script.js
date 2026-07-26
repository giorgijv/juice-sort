'use strict';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const PLOT_COUNT = 12;
const DAY_LENGTH_MS = 90 * 1000; // one in-game day
const SAVE_KEY = 'farmLifeSave_v1';

const CROPS = {
  wheat: { name: 'Wheat', emoji: '🌾', seedCost: 5, growTime: 15, yield: 3, sellPrice: 3 },
  corn: { name: 'Corn', emoji: '🌽', seedCost: 12, growTime: 30, yield: 3, sellPrice: 6 },
  carrot: { name: 'Carrot', emoji: '🥕', seedCost: 20, growTime: 50, yield: 3, sellPrice: 10 },
};

const CROP_ORDER = ['wheat', 'corn', 'carrot'];

const ANIMALS = {
  cow: {
    name: 'Cow', emoji: '🐄', buyBaseCost: 100, costIncrement: 70,
    feedAmount: 3, produceTime: 25, produceYield: 2,
    produceKey: 'milk', produceEmoji: '🥛',
  },
  chicken: {
    name: 'Chicken', emoji: '🐔', buyBaseCost: 40, costIncrement: 25,
    feedAmount: 1, produceTime: 15, produceYield: 1,
    produceKey: 'egg', produceEmoji: '🥚',
  },
};

const GOODS = {
  wheat: { emoji: '🌾', name: 'Wheat', sellPrice: CROPS.wheat.sellPrice },
  corn: { emoji: '🌽', name: 'Corn', sellPrice: CROPS.corn.sellPrice },
  carrot: { emoji: '🥕', name: 'Carrot', sellPrice: CROPS.carrot.sellPrice },
  milk: { emoji: '🥛', name: 'Milk', sellPrice: 9 },
  egg: { emoji: '🥚', name: 'Egg', sellPrice: 5 },
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

function freshState() {
  return {
    coins: 50,
    day: 1,
    dayStartedAt: Date.now(),
    selectedSeed: null,
    plots: Array.from({ length: PLOT_COUNT }, () => ({ crop: null, plantedAt: null })),
    cows: [],
    chickens: [],
    nextAnimalId: 1,
    inventory: { wheat: 0, corn: 0, carrot: 0, milk: 0, egg: 0 },
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    const fresh = freshState();
    return Object.assign(fresh, parsed);
  } catch (e) {
    return freshState();
  }
}

let state = loadState();

function saveState() {
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function nowSec() {
  return Date.now() / 1000;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1600);
}

function pickCropToConsume(amount) {
  // Prefer consuming the cheapest crop first, spread across types if needed.
  const have = CROP_ORDER.reduce((sum, k) => sum + state.inventory[k], 0);
  if (have < amount) return null;
  const plan = {};
  let remaining = amount;
  for (const key of CROP_ORDER) {
    if (remaining <= 0) break;
    const take = Math.min(state.inventory[key], remaining);
    if (take > 0) {
      plan[key] = take;
      remaining -= take;
    }
  }
  return plan;
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                 */
/* ------------------------------------------------------------------ */

let activeTab = 'farm';

function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('farmTab').classList.toggle('hidden', tab !== 'farm');
  document.getElementById('animalsTab').classList.toggle('hidden', tab !== 'animals');
  document.getElementById('marketTab').classList.toggle('hidden', tab !== 'market');
  render();
}

/* ------------------------------------------------------------------ */
/* Farm tab                                                             */
/* ------------------------------------------------------------------ */

function renderSeedBar() {
  const bar = document.getElementById('seedBar');
  bar.innerHTML = '';
  CROP_ORDER.forEach((key) => {
    const crop = CROPS[key];
    const btn = document.createElement('button');
    btn.className = 'seed-btn' + (state.selectedSeed === key ? ' selected' : '');
    btn.disabled = state.coins < crop.seedCost;
    btn.innerHTML = `<span class="seed-emoji">${crop.emoji}</span><span>${crop.name}</span><span>${crop.seedCost}💰</span>`;
    btn.addEventListener('click', () => {
      state.selectedSeed = state.selectedSeed === key ? null : key;
      renderSeedBar();
    });
    bar.appendChild(btn);
  });
}

function renderPlots() {
  const grid = document.getElementById('plotsGrid');
  grid.innerHTML = '';
  state.plots.forEach((plot, idx) => {
    const cell = document.createElement('div');
    cell.className = 'plot';

    if (!plot.crop) {
      cell.classList.add('empty');
      cell.textContent = '➕';
      cell.title = 'Plant a seed here';
      cell.addEventListener('click', () => plantSeed(idx));
    } else {
      const crop = CROPS[plot.crop];
      const elapsed = nowSec() - plot.plantedAt;
      const progress = clamp01(elapsed / crop.growTime);
      const ready = progress >= 1;

      if (ready) {
        cell.classList.add('ready');
        cell.textContent = crop.emoji;
        cell.title = `Harvest ${crop.name}`;
        cell.addEventListener('click', () => harvestPlot(idx));
      } else {
        cell.textContent = progress < 0.4 ? '🌱' : progress < 0.75 ? '🌿' : crop.emoji;
        cell.style.opacity = String(0.55 + progress * 0.45);
        cell.title = `${crop.name} growing... ${Math.round(progress * 100)}%`;

        const bar = document.createElement('div');
        bar.className = 'plot-progress';
        const fill = document.createElement('div');
        fill.className = 'plot-progress-fill';
        fill.style.width = `${Math.round(progress * 100)}%`;
        bar.appendChild(fill);
        cell.appendChild(bar);
      }
    }

    grid.appendChild(cell);
  });
}

function plantSeed(idx) {
  const plot = state.plots[idx];
  if (plot.crop) return;
  if (!state.selectedSeed) {
    showToast('Pick a seed first!');
    return;
  }
  const crop = CROPS[state.selectedSeed];
  if (state.coins < crop.seedCost) {
    showToast('Not enough coins!');
    return;
  }
  state.coins -= crop.seedCost;
  plot.crop = state.selectedSeed;
  plot.plantedAt = nowSec();
  saveState();
  render();
}

function harvestPlot(idx) {
  const plot = state.plots[idx];
  if (!plot.crop) return;
  const crop = CROPS[plot.crop];
  const elapsed = nowSec() - plot.plantedAt;
  if (elapsed < crop.growTime) return;
  state.inventory[plot.crop] += crop.yield;
  showToast(`Harvested ${crop.yield}x ${crop.emoji} ${crop.name}`);
  plot.crop = null;
  plot.plantedAt = null;
  saveState();
  render();
}

/* ------------------------------------------------------------------ */
/* Animals tab                                                          */
/* ------------------------------------------------------------------ */

function renderAnimalList(kind) {
  const def = ANIMALS[kind];
  const list = state[kind + 's'];
  const container = document.getElementById(kind + 'List');
  container.innerHTML = '';

  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = `No ${def.name.toLowerCase()}s yet — buy one below!`;
    container.appendChild(empty);
  }

  list.forEach((animal) => {
    // Auto-flip producing -> ready is handled visually; collect checks time directly.
    const progress = animal.state === 'producing'
      ? clamp01((nowSec() - animal.feedAt) / def.produceTime)
      : 0;
    const ready = animal.state === 'producing' && progress >= 1;

    const card = document.createElement('div');
    card.className = 'animal-card';

    const emoji = document.createElement('div');
    emoji.className = 'animal-emoji';
    emoji.textContent = def.emoji;
    card.appendChild(emoji);

    const stateLabel = document.createElement('div');
    if (ready) {
      stateLabel.className = 'animal-state ready';
      stateLabel.textContent = `${def.produceEmoji} Ready!`;
      card.appendChild(stateLabel);
    } else if (animal.state === 'producing') {
      stateLabel.className = 'animal-state producing';
      stateLabel.textContent = 'Producing...';
      card.appendChild(stateLabel);

      const bar = document.createElement('div');
      bar.className = 'animal-progress';
      const fill = document.createElement('div');
      fill.className = 'animal-progress-fill';
      fill.style.width = `${Math.round(progress * 100)}%`;
      bar.appendChild(fill);
      card.appendChild(bar);
    } else {
      stateLabel.className = 'animal-state hungry';
      stateLabel.textContent = 'Hungry';
      card.appendChild(stateLabel);
    }

    const btn = document.createElement('button');
    btn.className = 'animal-btn';
    if (ready) {
      btn.textContent = `Collect ${def.produceEmoji}`;
      btn.addEventListener('click', () => collectAnimal(kind, animal.id));
    } else if (animal.state === 'producing') {
      btn.textContent = 'Producing...';
      btn.disabled = true;
    } else {
      const haveEnough = CROP_ORDER.reduce((sum, k) => sum + state.inventory[k], 0) >= def.feedAmount;
      btn.textContent = `Feed (${def.feedAmount} crops)`;
      btn.disabled = !haveEnough;
      btn.addEventListener('click', () => feedAnimal(kind, animal.id));
    }
    card.appendChild(btn);

    container.appendChild(card);
  });
}

function feedAnimal(kind, id) {
  const def = ANIMALS[kind];
  const animal = state[kind + 's'].find((a) => a.id === id);
  if (!animal || animal.state !== 'hungry') return;
  const plan = pickCropToConsume(def.feedAmount);
  if (!plan) {
    showToast('Not enough crops to feed!');
    return;
  }
  Object.entries(plan).forEach(([k, amt]) => { state.inventory[k] -= amt; });
  animal.state = 'producing';
  animal.feedAt = nowSec();
  saveState();
  render();
}

function collectAnimal(kind, id) {
  const def = ANIMALS[kind];
  const animal = state[kind + 's'].find((a) => a.id === id);
  if (!animal || animal.state !== 'producing') return;
  const progress = (nowSec() - animal.feedAt) / def.produceTime;
  if (progress < 1) return;
  state.inventory[def.produceKey] += def.produceYield;
  showToast(`Collected ${def.produceYield}x ${def.produceEmoji}`);
  animal.state = 'hungry';
  animal.feedAt = null;
  saveState();
  render();
}

function buyAnimalCost(kind) {
  const def = ANIMALS[kind];
  const owned = state[kind + 's'].length;
  return def.buyBaseCost + owned * def.costIncrement;
}

function renderBuyButtons() {
  ['cow', 'chicken'].forEach((kind) => {
    const def = ANIMALS[kind];
    const cost = buyAnimalCost(kind);
    const btn = document.getElementById('buy' + kind[0].toUpperCase() + kind.slice(1) + 'Btn');
    btn.textContent = `Buy ${def.name} (${cost}💰)`;
    btn.disabled = state.coins < cost;
    btn.onclick = () => buyAnimal(kind);
  });
}

function buyAnimal(kind) {
  const cost = buyAnimalCost(kind);
  if (state.coins < cost) {
    showToast('Not enough coins!');
    return;
  }
  state.coins -= cost;
  state[kind + 's'].push({ id: state.nextAnimalId++, state: 'hungry', feedAt: null });
  showToast(`Bought a new ${ANIMALS[kind].name}!`);
  saveState();
  render();
}

/* ------------------------------------------------------------------ */
/* Market tab                                                           */
/* ------------------------------------------------------------------ */

function renderMarket() {
  const sellList = document.getElementById('sellList');
  sellList.innerHTML = '';
  Object.entries(GOODS).forEach(([key, good]) => {
    const qty = state.inventory[key];
    const item = document.createElement('div');
    item.className = 'market-item';
    item.innerHTML = `
      <div class="item-emoji">${good.emoji}</div>
      <div>${good.name}</div>
      <div>Have: ${qty}</div>
      <div>${good.sellPrice}💰 each</div>
    `;
    const btn = document.createElement('button');
    btn.textContent = `Sell All (${qty * good.sellPrice}💰)`;
    btn.disabled = qty <= 0;
    btn.addEventListener('click', () => sellAll(key));
    item.appendChild(btn);
    sellList.appendChild(item);
  });

  const invList = document.getElementById('inventoryList');
  invList.innerHTML = '';
  const overview = [
    { emoji: '💰', name: 'Coins', value: state.coins },
    { emoji: '🐄', name: 'Cows', value: state.cows.length },
    { emoji: '🐔', name: 'Chickens', value: state.chickens.length },
    { emoji: '🌱', name: 'Plots planted', value: state.plots.filter((p) => p.crop).length + ' / ' + PLOT_COUNT },
  ];
  overview.forEach((o) => {
    const item = document.createElement('div');
    item.className = 'inventory-item';
    item.innerHTML = `<div class="item-emoji">${o.emoji}</div><div>${o.name}</div><div>${o.value}</div>`;
    invList.appendChild(item);
  });
}

function sellAll(key) {
  const qty = state.inventory[key];
  if (qty <= 0) return;
  const good = GOODS[key];
  const earned = qty * good.sellPrice;
  state.coins += earned;
  state.inventory[key] = 0;
  showToast(`Sold ${qty}x ${good.emoji} for ${earned}💰`);
  saveState();
  render();
}

/* ------------------------------------------------------------------ */
/* Top bar / day cycle                                                  */
/* ------------------------------------------------------------------ */

function renderTopbar() {
  document.getElementById('coinsLabel').textContent = `💰 ${state.coins}`;
  document.getElementById('dayLabel').textContent = `☀️ Day ${state.day}`;
}

function updateDay() {
  const elapsed = Date.now() - state.dayStartedAt;
  if (elapsed >= DAY_LENGTH_MS) {
    state.day += 1;
    state.dayStartedAt = Date.now();
  }
}

/* ------------------------------------------------------------------ */
/* Render / loop                                                        */
/* ------------------------------------------------------------------ */

function render() {
  renderTopbar();
  if (activeTab === 'farm') {
    renderSeedBar();
    renderPlots();
  } else if (activeTab === 'animals') {
    renderAnimalList('cow');
    renderAnimalList('chicken');
    renderBuyButtons();
  } else if (activeTab === 'market') {
    renderMarket();
  }
}

function tick() {
  updateDay();
  render();
  saveState();
}

/* ------------------------------------------------------------------ */
/* Init                                                                  */
/* ------------------------------------------------------------------ */

function init() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });

  render();
  setInterval(tick, 1000);
}

init();
