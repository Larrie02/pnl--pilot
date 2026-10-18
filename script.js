/* =========================================================
   PnL Pilot — script.js

   The file is split into two halves:

   PART A. "Pure logic": settings, validation, calculations and
           number formatting. These functions never touch the page,
           so they are easy to read and easy to test.

   PART B. "Page logic": reading inputs, showing results,
           saving trades, theme toggle and navigation.

   Everything is wrapped in one function so we do not create
   global variables that could clash with other scripts.
   ========================================================= */
(function () {
  'use strict';

  /* =======================================================
     PART A. PURE LOGIC
     ======================================================= */
  // BEGIN PURE LOGIC

  // ---------- Settings ----------
  const STORAGE_KEYS = {
    trades: 'pnlpilot.trades',
    theme: 'pnlpilot.theme'
  };

  const MAX_USD_VALUE = 1e12;      // Upper limit for amounts and prices
  const MIN_PRICE = 1e-12;         // Lowest price we can show without rounding it to zero
  const MAX_SAVED_TRADES = 100;    // Keeps LocalStorage small

  // Starting values shown in the calculator. They are text because they go into <input> boxes.
  const EXAMPLE_INPUTS = {
    positionType: 'long',
    investment: '1000',
    entryPrice: '64250',
    exitPrice: '68900',
    buyFee: '0.1',
    sellFee: '0.1',
    extraCosts: '5'
  };

  // The six number fields, in the order they appear on the page.
  const FIELD_NAMES = ['investment', 'entryPrice', 'exitPrice', 'buyFee', 'sellFee', 'extraCosts'];

  // Rules for each field. "kind" decides which checks are applied.
  const FIELD_RULES = {
    investment:  { kind: 'amount',      emptyMessage: 'Enter your investment amount.' },
    entryPrice:  { kind: 'price',       emptyMessage: 'Enter the entry price.' },
    exitPrice:   { kind: 'price',       emptyMessage: 'Enter the exit price.' },
    buyFee:      { kind: 'percent',     emptyMessage: 'Enter a fee percentage. Use 0 for no fee.' },
    sellFee:     { kind: 'percent',     emptyMessage: 'Enter a fee percentage. Use 0 for no fee.' },
    extraCosts:  { kind: 'optionalUsd', emptyMessage: '' }
  };

  // ---------- Validation ----------

  // Checks ONE field. Returns { value } when it is fine, or { error } with a message.
  function validateField(name, rawText) {
    const rule = FIELD_RULES[name];
    const text = String(rawText).trim();

    // An empty box: only "additional costs" may be empty (it counts as 0).
    if (text === '') {
      if (rule.kind === 'optionalUsd') {
        return { value: 0 };
      }
      return { error: rule.emptyMessage };
    }

    // Number('abc') is NaN and Number('Infinity') is Infinity. Neither is a usable number.
    const value = Number(text);
    if (!Number.isFinite(value)) {
      return { error: 'Enter a valid number.' };
    }

    if (rule.kind === 'amount') {
      if (value <= 0) return { error: 'Investment must be greater than 0.' };
      if (value > MAX_USD_VALUE) return { error: 'This value is too large.' };
    } else if (rule.kind === 'price') {
      if (value <= 0) return { error: 'Price must be greater than 0.' };
      if (value < MIN_PRICE) return { error: 'This price is too small to calculate.' };
      if (value > MAX_USD_VALUE) return { error: 'This value is too large.' };
    } else if (rule.kind === 'percent') {
      if (value < 0) return { error: 'Fee cannot be negative.' };
      if (value >= 100) return { error: 'Fee must be below 100%.' };
    } else if (rule.kind === 'optionalUsd') {
      if (value < 0) return { error: 'Additional costs cannot be negative.' };
      if (value > MAX_USD_VALUE) return { error: 'This value is too large.' };
    }

    return { value: value };
  }

  // Checks ALL fields. Returns { values, errors }.
  // "errors" only contains the fields that failed.
  function validateInputs(rawInputs) {
    const values = {};
    const errors = {};

    FIELD_NAMES.forEach(function (name) {
      const result = validateField(name, rawInputs[name]);
      if (result.error) {
        errors[name] = result.error;
      } else {
        values[name] = result.value;
      }
    });

    return { values: values, errors: errors };
  }

  // ---------- Calculations ----------
  // Letters used in the README formulas:
  //   I = investment, E = entry price, X = exit price,
  //   B = buy/entry fee (decimal), S = sell/exit fee (decimal), C = additional costs.

  // Returns an object with every result, or null if a number is not finite.
  function calculateTrade(positionType, values) {
    const I = values.investment;
    const E = values.entryPrice;
    const X = values.exitPrice;
    const B = values.buyFee / 100;   // 0.1 (%) becomes 0.001
    const S = values.sellFee / 100;
    const C = values.extraCosts;

    const quantity = I / E;                  // Q = I / E
    const entryFee = I * B;                  // Fbuy = I x B
    const exitValue = quantity * X;          // Vexit = Q x X
    const exitFee = exitValue * S;           // Fsell = Vexit x S

    let pnl;
    let breakEven;

    if (positionType === 'short') {
      const grossPnl = quantity * (E - X);                       // Gross PnL = Q x (E - X)
      pnl = grossPnl - entryFee - exitFee - C;
      breakEven = (I * (1 - B) - C) / (quantity * (1 + S));
    } else {
      pnl = exitValue - I - entryFee - exitFee - C;
      breakEven = (I + entryFee + C) / (quantity * (1 - S));
    }

    const returnPct = (pnl / I) * 100;
    const totalCosts = entryFee + exitFee + C;

    // Guard: if anything overflowed or divided by zero, do not show a result.
    const allFinite = [quantity, entryFee, exitValue, exitFee, pnl, returnPct, totalCosts].every(Number.isFinite);
    if (!allFinite) {
      return null;
    }

    return {
      positionType: positionType,
      quantity: quantity,
      entryNotional: I,
      exitValue: exitValue,
      entryFee: entryFee,
      exitFee: exitFee,
      extraCosts: C,
      totalCosts: totalCosts,
      pnl: pnl,
      returnPct: returnPct,
      // A break-even price of zero or less is not a real price, so we return null.
      breakEven: Number.isFinite(breakEven) && breakEven > 0 ? breakEven : null
    };
  }

  // 'profit', 'loss' or 'neutral'.
  // A result that rounds to $0.00 counts as neutral, so we never show a "+$0.00".
  function getPnlState(pnl) {
    if (Math.round(Math.abs(pnl) * 100) === 0) return 'neutral';
    return pnl > 0 ? 'profit' : 'loss';
  }

  // ---------- Number formatting ----------
  // Display only: the calculations above keep full precision.

  // Dollars with two decimals, e.g. $1,234.50. With showSign: +$1,234.50 or −$12.00.
  function formatUsd(value, showSign) {
    const rounded = Math.round(Math.abs(value) * 100) / 100;
    const text = '$' + rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (!showSign || rounded === 0) return text;
    return (value < 0 ? '\u2212' : '+') + text;
  }

  // Token prices. Small prices get more decimals so they never show as $0.00.
  function formatPrice(value) {
    const abs = Math.abs(value);
    let maxDecimals = 2;
    if (abs < 1000) maxDecimals = 4;
    if (abs < 1) maxDecimals = Math.min(20, 3 - Math.floor(Math.log10(abs)));
    return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maxDecimals });
  }

  // Percentages with two decimals, e.g. +6.53%.
  function formatPercent(value, showSign) {
    const rounded = Math.round(Math.abs(value) * 100) / 100;
    const text = rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
    if (!showSign || rounded === 0) return text;
    return (value < 0 ? '\u2212' : '+') + text;
  }

  // Token amounts: up to 6 decimals, or 6 significant digits for amounts below 1.
  function formatQuantity(value) {
    if (value >= 1) {
      return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
    }
    return value.toLocaleString('en-US', { maximumSignificantDigits: 6 });
  }

  // END PURE LOGIC

  /* =======================================================
     PART B. PAGE LOGIC
     ======================================================= */

  // ---------- Text that changes between Long and Short ----------
  const POSITION_TEXT = {
    long: {
      buyFeeLabel: 'Buy fee (%)',
      sellFeeLabel: 'Sell fee (%)',
      buyFeeName: 'Buy fee',
      sellFeeName: 'Sell fee',
      investmentHint: 'Amount allocated to the position, before the buy fee.',
      buyFeeHint: 'Percent of your investment amount. 0.1 means 0.1%.',
      sellFeeHint: 'Percent of the exit value. 0.1 means 0.1%.',
      breakEvenNote: 'Exit above this price to make a profit.'
    },
    short: {
      buyFeeLabel: 'Entry fee (%)',
      sellFeeLabel: 'Exit fee (%)',
      buyFeeName: 'Entry fee',
      sellFeeName: 'Exit fee',
      investmentHint: 'Reference notional of the position. Not your margin or collateral.',
      buyFeeHint: 'Percent of the entry notional. 0.1 means 0.1%.',
      sellFeeHint: 'Percent of the exit notional. 0.1 means 0.1%.',
      breakEvenNote: 'Exit below this price to make a profit.'
    }
  };

  const STATE_LABELS = {
    profit: 'Profit',
    loss: 'Loss',
    neutral: 'No gain or loss',
    empty: 'No result'
  };

  // ---------- App state ----------
  // These variables live inside this function, not on the window.
  let positionType = 'long';
  let touchedFields = new Set();   // Fields the user has edited (we only show errors for these)
  let lastCalculation = null;      // { inputs, result } for the current valid inputs, or null
  let savedTrades = [];
  let storageWorks = true;

  // Small shortcut: byId('saveBtn') instead of document.getElementById('saveBtn')
  function byId(id) {
    return document.getElementById(id);
  }

  // ---------- LocalStorage helpers ----------
  // Browsers can block LocalStorage (private mode, strict settings), so every
  // call is wrapped in try/catch. The app keeps working either way.

  function checkStorageWorks() {
    try {
      const testKey = 'pnlpilot.test';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return true;
    } catch (error) {
      return false;
    }
  }

  function readStoredText(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStoredText(key, text) {
    try {
      localStorage.setItem(key, text);
      return true;
    } catch (error) {
      return false;
    }
  }

  // A saved trade must have the right shape. Anything else is ignored.
  function isValidTrade(trade) {
    if (!trade || typeof trade !== 'object') return false;
    if (typeof trade.id !== 'string' || typeof trade.savedAt !== 'string') return false;
    if (trade.positionType !== 'long' && trade.positionType !== 'short') return false;
    return ['investment', 'entryPrice', 'exitPrice', 'pnl', 'returnPct'].every(function (key) {
      return typeof trade[key] === 'number' && Number.isFinite(trade[key]);
    });
  }

  // Returns { trades, unreadable }. "unreadable" is true if stored data was damaged.
  function loadTrades() {
    const text = readStoredText(STORAGE_KEYS.trades);
    if (text === null) return { trades: [], unreadable: false };

    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return { trades: [], unreadable: true };
      return { trades: parsed.filter(isValidTrade).slice(0, MAX_SAVED_TRADES), unreadable: false };
    } catch (error) {
      return { trades: [], unreadable: true };
    }
  }

  function persistTrades() {
    return writeStoredText(STORAGE_KEYS.trades, JSON.stringify(savedTrades));
  }

  // ---------- Reading and validating the form ----------

  function readRawInputs() {
    const raw = {};
    FIELD_NAMES.forEach(function (name) {
      const input = byId(name);
      // A <input type="number"> reports "" when the user typed something invalid like "1e".
      // We pass a marker so the user sees "Enter a valid number" instead of "Enter a value".
      raw[name] = input.validity.badInput ? 'not-a-number' : input.value;
    });
    return raw;
  }

  // Shows or clears the red message under each field.
  function showFieldErrors(errors) {
    FIELD_NAMES.forEach(function (name) {
      const input = byId(name);
      const errorBox = byId(name + 'Error');
      const wrap = input.closest('.input-wrap');
      const message = touchedFields.has(name) ? errors[name] : '';

      errorBox.textContent = message || '';
      wrap.classList.toggle('has-error', Boolean(message));
      if (message) {
        input.setAttribute('aria-invalid', 'true');
      } else {
        input.removeAttribute('aria-invalid');
      }
    });
  }

  // ---------- Showing results ----------

  function setText(id, text) {
    byId(id).textContent = text;
  }

  // Shown when inputs are missing or invalid. No numbers, so nothing can mislead.
  function renderEmptyResults(message) {
    byId('resultsPanel').dataset.state = 'empty';
    setText('resultPnl', '\u2014');
    setText('resultState', STATE_LABELS.empty);
    setText('resultsError', message);
    ['resultReturn', 'resultBreakEven', 'resultQuantity', 'resultEntryNotional', 'resultExitValue', 'resultCosts']
      .forEach(function (id) { setText(id, '\u2014'); });
    setText('resultBreakEvenNote', '');
    setText('resultCostsNote', '');
    byId('ruler').hidden = true;
    byId('saveBtn').disabled = true;
  }

  function renderResults(result, values) {
    const text = POSITION_TEXT[result.positionType];
    const state = getPnlState(result.pnl);

    byId('resultsPanel').dataset.state = state;
    setText('resultsError', '');
    setText('resultPnl', formatUsd(result.pnl, true));
    setText('resultState', STATE_LABELS[state]);
    setText('resultReturn', formatPercent(result.returnPct, true));
    setText('resultQuantity', formatQuantity(result.quantity) + ' tokens');
    setText('resultEntryNotional', formatUsd(result.entryNotional));
    setText('resultExitValue', formatUsd(result.exitValue));
    setText('resultCosts', formatUsd(result.totalCosts));
    setText('resultCostsNote',
      text.buyFeeName + ' ' + formatUsd(result.entryFee) +
      ' + ' + text.sellFeeName + ' ' + formatUsd(result.exitFee) +
      ' + additional ' + formatUsd(result.extraCosts));

    if (result.breakEven === null) {
      setText('resultBreakEven', 'Not reachable');
      setText('resultBreakEvenNote', 'The break-even price would be zero or negative, so no exit price covers your costs.');
    } else {
      setText('resultBreakEven', formatPrice(result.breakEven));
      setText('resultBreakEvenNote', text.breakEvenNote);
    }

    renderPriceRuler(values.entryPrice, values.exitPrice, result.breakEven);
    byId('saveBtn').disabled = false;
  }

  // Places entry, break-even and exit on one horizontal scale.
  function renderPriceRuler(entry, exit, breakEven) {
    const prices = [entry, exit];
    if (breakEven !== null) prices.push(breakEven);

    const low = Math.min.apply(null, prices);
    const high = Math.max.apply(null, prices);
    const span = high - low;
    const padding = span * 0.15;

    // Turns a price into a 0-100 position along the scale. If all prices are equal, use the middle.
    function toPercent(price) {
      if (span === 0) return 50;
      return ((price - (low - padding)) / (span + padding * 2)) * 100;
    }

    const entryPos = toPercent(entry);
    const exitPos = toPercent(exit);

    byId('dotEntry').style.left = entryPos + '%';
    byId('dotExit').style.left = exitPos + '%';

    const range = byId('rulerRange');
    range.style.left = Math.min(entryPos, exitPos) + '%';
    range.style.width = Math.abs(exitPos - entryPos) + '%';

    const breakEvenVisible = breakEven !== null;
    byId('dotBreakEven').hidden = !breakEvenVisible;
    byId('legendBreakEvenItem').hidden = !breakEvenVisible;
    if (breakEvenVisible) {
      byId('dotBreakEven').style.left = toPercent(breakEven) + '%';
      setText('legendBreakEven', formatPrice(breakEven));
    }

    setText('legendEntry', formatPrice(entry));
    setText('legendExit', formatPrice(exit));
    byId('ruler').hidden = false;
  }

  // Reads the form, validates, calculates and updates the page.
  // Returns true if the inputs were valid.
  function updateCalculator() {
    const check = validateInputs(readRawInputs());
    showFieldErrors(check.errors);
    byId('saveMessage').textContent = '';

    if (Object.keys(check.errors).length > 0) {
      lastCalculation = null;
      renderEmptyResults('Fix the highlighted fields to see your results.');
      return false;
    }

    const result = calculateTrade(positionType, check.values);
    if (result === null) {
      lastCalculation = null;
      renderEmptyResults('These numbers are too large to calculate. Try smaller values.');
      return false;
    }

    lastCalculation = { inputs: check.values, result: result };
    renderResults(result, check.values);
    return true;
  }

  // ---------- Long / Short ----------

  function applyPositionType(type) {
    positionType = type;
    const text = POSITION_TEXT[type];

    setText('buyFeeLabel', text.buyFeeLabel);
    setText('sellFeeLabel', text.sellFeeLabel);
    setText('investmentHint', text.investmentHint);
    setText('buyFeeHint', text.buyFeeHint);
    setText('sellFeeHint', text.sellFeeHint);
    byId('shortNote').hidden = type !== 'short';
  }

  // ---------- Calculator events ----------

  function handleInput(event) {
    touchedFields.add(event.target.id);
    byId('exampleNotice').hidden = true;
    updateCalculator();
  }

  function handleBlur(event) {
    // Leaving an empty required box should show its message.
    if (!touchedFields.has(event.target.id)) {
      touchedFields.add(event.target.id);
      updateCalculator();
    }
  }

  function handlePositionChange(event) {
    applyPositionType(event.target.value);
    updateCalculator();
  }

  function handleCalculate(event) {
    event.preventDefault();
    FIELD_NAMES.forEach(function (name) { touchedFields.add(name); });

    const isValid = updateCalculator();
    const announcer = byId('resultsAnnouncer');

    if (isValid) {
      const result = lastCalculation.result;
      const state = getPnlState(result.pnl);
      announcer.textContent = 'Calculated. ' + STATE_LABELS[state] + ': ' +
        formatUsd(result.pnl, true) + ', return ' + formatPercent(result.returnPct, true) + '.';
    } else {
      announcer.textContent = 'Some inputs need fixing. See the messages under the fields.';
      const firstInvalid = document.querySelector('#calcForm [aria-invalid="true"]');
      if (firstInvalid) firstInvalid.focus();
    }
  }

  function handleReset() {
    byId('posLong').checked = true;
    applyPositionType('long');

    FIELD_NAMES.forEach(function (name) {
      byId(name).value = EXAMPLE_INPUTS[name];
    });

    touchedFields = new Set();
    byId('exampleNotice').hidden = false;
    byId('resultsAnnouncer').textContent = 'Inputs reset to the example values.';
    updateCalculator();
  }

  // ---------- Trade history ----------

  function formatDate(isoText) {
    const date = new Date(isoText);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Makes one <td>. data-label is shown as a small caption on mobile.
  function createCell(label, text, className) {
    const cell = document.createElement('td');
    cell.dataset.label = label;
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function createTradeRow(trade) {
    const row = document.createElement('tr');
    const state = getPnlState(trade.pnl);
    const positionName = trade.positionType === 'short' ? 'Short' : 'Long';

    row.appendChild(createCell('Saved', formatDate(trade.savedAt)));
    row.appendChild(createCell('Position', positionName));
    row.appendChild(createCell('Investment', formatUsd(trade.investment), 'num'));
    row.appendChild(createCell('Entry', formatPrice(trade.entryPrice), 'num'));
    row.appendChild(createCell('Exit', formatPrice(trade.exitPrice), 'num'));
    row.appendChild(createCell('Net P&L', formatUsd(trade.pnl, true), 'num cell-' + state));
    row.appendChild(createCell('Return', formatPercent(trade.returnPct, true), 'num cell-' + state));

    const actionCell = document.createElement('td');
    actionCell.className = 'cell-actions num';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-danger btn-small';
    deleteButton.textContent = 'Delete';
    deleteButton.setAttribute('aria-label',
      'Delete ' + positionName + ' trade saved on ' + formatDate(trade.savedAt));
    deleteButton.addEventListener('click', function () { deleteTrade(trade.id); });
    actionCell.appendChild(deleteButton);
    row.appendChild(actionCell);

    return row;
  }

  function renderHistory() {
    const body = byId('historyBody');
    body.textContent = '';
    savedTrades.forEach(function (trade) {
      body.appendChild(createTradeRow(trade));
    });

    const hasTrades = savedTrades.length > 0;
    byId('historyTable').hidden = !hasTrades;
    byId('historyEmpty').hidden = hasTrades;
    byId('clearBtn').disabled = !hasTrades;

    const count = savedTrades.length;
    setText('historyCount', count === 0
      ? 'Your saved trades appear here.'
      : count + (count === 1 ? ' saved trade, newest first.' : ' saved trades, newest first.'));
  }

  function handleSave() {
    if (lastCalculation === null) return;   // Never save an invalid calculation
    const message = byId('saveMessage');

    if (savedTrades.length >= MAX_SAVED_TRADES) {
      message.textContent = 'History is full (' + MAX_SAVED_TRADES + ' trades). Delete a trade to save a new one.';
      return;
    }

    const inputs = lastCalculation.inputs;
    const result = lastCalculation.result;

    savedTrades.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      savedAt: new Date().toISOString(),
      positionType: result.positionType,
      investment: inputs.investment,
      entryPrice: inputs.entryPrice,
      exitPrice: inputs.exitPrice,
      pnl: result.pnl,
      returnPct: result.returnPct
    });

    const stored = persistTrades();
    renderHistory();
    message.textContent = stored
      ? 'Trade saved. You can see it in Trade History.'
      : 'Trade added for this visit only. Your browser blocked saving.';
  }

  function deleteTrade(id) {
    savedTrades = savedTrades.filter(function (trade) { return trade.id !== id; });
    persistTrades();
    renderHistory();
    byId('historyTitle').focus();   // Keeps keyboard users in the right place
  }

  function handleClearAll() {
    if (savedTrades.length === 0) return;
    const confirmed = window.confirm(
      'Delete all ' + savedTrades.length + ' saved trades? This cannot be undone.');
    if (!confirmed) return;

    savedTrades = [];
    persistTrades();
    renderHistory();
    byId('historyTitle').focus();
  }

  function showStorageNotice(unreadable) {
    const notice = byId('storageNotice');
    if (!storageWorks) {
      notice.textContent = 'Your browser is blocking local storage, so saved trades will be lost when you close or refresh this page.';
      notice.hidden = false;
    } else if (unreadable) {
      notice.textContent = 'Your saved history could not be read, so it was reset. New trades will save normally.';
      notice.hidden = false;
    } else {
      notice.hidden = true;
    }
  }

  // ---------- Theme ----------

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const toggle = byId('themeToggle');
    toggle.setAttribute('aria-label',
      theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }

  function handleThemeToggle() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    writeStoredText(STORAGE_KEYS.theme, next);
  }

  // ---------- Mobile navigation ----------

  function setMenuOpen(isOpen) {
    byId('siteHeader').classList.toggle('nav-open', isOpen);
    const button = byId('menuToggle');
    button.setAttribute('aria-expanded', String(isOpen));
    button.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
  }

  function setUpNavigation() {
    byId('menuToggle').addEventListener('click', function () {
      setMenuOpen(!byId('siteHeader').classList.contains('nav-open'));
    });

    // Close the menu after choosing a link
    byId('primaryNav').addEventListener('click', function (event) {
      if (event.target.closest('a')) setMenuOpen(false);
    });

    // Escape closes the menu and returns focus to the menu button
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && byId('siteHeader').classList.contains('nav-open')) {
        setMenuOpen(false);
        byId('menuToggle').focus();
      }
    });

    byId('themeToggle').addEventListener('click', handleThemeToggle);
  }

  // ---------- Start-up ----------

  function init() {
    // Theme: the <head> script already applied the saved one, we just sync the button label.
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

    // Footer year, generated so it never goes out of date
    setText('footerYear', String(new Date().getFullYear()));

    // Saved trades
    storageWorks = checkStorageWorks();
    const loaded = loadTrades();
    savedTrades = loaded.trades;
    showStorageNotice(loaded.unreadable);
    renderHistory();

    // Calculator events
    const form = byId('calcForm');
    form.addEventListener('submit', handleCalculate);
    FIELD_NAMES.forEach(function (name) {
      byId(name).addEventListener('input', handleInput);
      byId(name).addEventListener('blur', handleBlur);
    });
    byId('posLong').addEventListener('change', handlePositionChange);
    byId('posShort').addEventListener('change', handlePositionChange);
    byId('resetBtn').addEventListener('click', handleReset);
    byId('saveBtn').addEventListener('click', handleSave);
    byId('clearBtn').addEventListener('click', handleClearAll);

    setUpNavigation();

    // Make sure the page matches the selected radio button (browsers can restore it on refresh)
    applyPositionType(byId('posShort').checked ? 'short' : 'long');
    updateCalculator();
  }

  init();
})();
