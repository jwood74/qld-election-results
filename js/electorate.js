let config;
let electorateStub;
let allRowsData = [];
let sortState = { key: null, direction: null };
let refreshTimer = null;
let tcpCandidates = [];
let selectedTcpCandidateKey = null;
let historicTcpTotals = {};
let historicTcpFormalVotes = null;
let historicExpectedFormalVotes = null;
let historicPrimaryTotals = {};
let currentTcpFormalVotes = null;
const ELECTORATE_SORT_STORAGE_KEY = "qld-electorate-table-sort";
const currentBoothDetailCache = new Map();
const historicBoothDetailCache = new Map();
let openBoothVenueId = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  electorateStub = new URLSearchParams(window.location.search).get("electorate");
  if (!electorateStub) {
    setStatus("Missing electorate query parameter.", true);
    return;
  }

  sortState = loadPersistedSortState();
  initSorting(sortState, () => {
    savePersistedSortState();
    renderCurrentRows();
  });
  updateSortIndicators(sortState);
  initBoothModal();

  try {
    config = await loadConfig();
    await loadAndRender();
    if (config.refreshSeconds > 0) {
      refreshTimer = setInterval(loadAndRender, config.refreshSeconds * 1000);
    }
  } catch (error) {
    setStatus(`Unable to load electorate detail: ${error.message}`, true);
  }
}

function loadPersistedSortState() {
  try {
    const value = JSON.parse(localStorage.getItem(ELECTORATE_SORT_STORAGE_KEY) || "null");
    if (!value || typeof value !== "object") return { key: null, direction: null };
    const key = value.key || null;
    const validKeys = [...document.querySelectorAll("thead th[data-sort-key]")].map(th => th.dataset.sortKey);
    if (key && !validKeys.includes(key)) return { key: null, direction: null };
    return {
      key,
      direction: value.direction === "asc" || value.direction === "desc" ? value.direction : null,
    };
  } catch {
    return { key: null, direction: null };
  }
}

function savePersistedSortState() {
  localStorage.setItem(ELECTORATE_SORT_STORAGE_KEY, JSON.stringify({
    key: sortState.key || null,
    direction: sortState.direction || null,
  }));
}

async function loadAndRender() {
  const checkedAt = new Date();
  const historicStub = getHistoricStub(config, electorateStub);
  currentBoothDetailCache.clear();

  const [metadata, current, historic] = await Promise.all([
    loadElectionMetadata(config.electionId).catch(() => null),
    fetchJson(endpoint(config.electionId, `table-booths-${electorateStub}.json`), { cacheBust: true }),
    config.historicElectionId
      ? fetchJson(endpoint(config.historicElectionId, `table-booths-${historicStub}.json`), { cacheBust: true }).catch(() => null)
      : Promise.resolve(null),
  ]);

  setElectionLabel(metadata ? `${metadata.electionName} (${config.electionId})` : config.electionId);
  document.getElementById("electorate-label").textContent = current.electorateName || electorateStub;

  configureTcpCandidates(current.indicative?.totals);
  configureHistoricTotals(historic?.indicative?.totals, historic?.preliminary?.totals);
  allRowsData = buildRows(current, historic);
  stampSelectedTcpValues(allRowsData);
  renderTcpCandidateDropdown();
  renderCurrentRows();
  renderPrediction();
  refreshOpenBoothModal();

  const latestEcqUpdate = maxTimestamp(allRowsData.map(row => row.lastUpdated));
  const matched = allRowsData.filter(row => row.historicMatched).length;
  const unmatchedBooths = allRowsData.filter(row => !row.historicMatched).map(row => row.venueName);
  const historicText = config.historicElectionId
    ? ` Historic matches: ${matched}/${allRowsData.length}.`
    : " No historic election configured.";
  setStatus(`${allRowsData.length} booth${allRowsData.length === 1 ? "" : "s"}. ECQ updated ${fmtDateTime(latestEcqUpdate)}. Last checked ${fmtDateTime(checkedAt)}.${historicText}`);
  const status = document.getElementById("status");
  if (status) {
    status.title = config.historicElectionId
      ? (unmatchedBooths.length ? `Unmatched booths: ${unmatchedBooths.join("; ")}` : "All booths matched to historic data")
      : "No historic election configured";
  }
}

function configureHistoricTcpTotals(indicativeTotals, preliminaryTotals) {
  configureHistoricTotals(indicativeTotals, preliminaryTotals);
}

function configureHistoricTotals(indicativeTotals, preliminaryTotals) {
  historicTcpTotals = {};
  historicPrimaryTotals = {};
  historicTcpFormalVotes = indicativeTotals?.totalFormalVotes ?? indicativeTotals?.totalVotes ?? null;
  historicExpectedFormalVotes = preliminaryTotals?.formalVotes ?? historicTcpFormalVotes;
  for (const candidate of selectedCandidateRows(indicativeTotals)) {
    if (candidate.pct !== null) historicTcpTotals[candidate.group] = candidate.pct;
  }
  const primary = aggregateCandidates(preliminaryTotals?.candidates || []);
  for (const group of PARTY_GROUPS) {
    historicPrimaryTotals[group] = primary[group].pct;
  }
}

function buildRows(current, historic) {
  const historicByVenueId = new Map();
  if (historic) {
    for (const booth of historic.preliminary?.booths || []) {
      historicByVenueId.set(String(booth.venueId), { preliminary: booth, indicative: null });
    }
    for (const booth of historic.indicative?.booths || []) {
      const key = String(booth.venueId);
      const existing = historicByVenueId.get(key) || { preliminary: null, indicative: null };
      existing.indicative = booth;
      historicByVenueId.set(key, existing);
    }
  }

  const indicativeByVenueId = new Map((current.indicative?.booths || []).map(booth => [String(booth.venueId), booth]));
  return (current.preliminary?.booths || []).map(preliminary => {
    const indicative = indicativeByVenueId.get(String(preliminary.venueId)) || null;
    const historicVenueId = getHistoricVenueId(config, electorateStub, preliminary.venueId);
    const historicRow = historicByVenueId.get(String(historicVenueId)) || null;
    return parseBoothRow(preliminary, indicative, historicRow, historicVenueId);
  });
}

function parseBoothRow(preliminary, indicative, historicRow, historicVenueId) {
  const primary = aggregateCandidates(preliminary.candidates);
  const historicPrimary = historicRow?.preliminary ? aggregateCandidates(historicRow.preliminary.candidates) : null;
  const currentTcp = leaderFromIndicative(indicative);
  const historicTcp = leaderFromIndicative(historicRow?.indicative);

  const row = {
    venueId: preliminary.venueId,
    venueName: preliminary.venueName,
    totalVotes: preliminary.totalVotes ?? null,
    formalVotes: preliminary.formalVotes ?? null,
    informalVotes: preliminary.informalVotes ?? null,
    informalPct: parsePct(preliminary.informalVotesPercentage),
    formalPct: parsePct(preliminary.formalVotesPercentage),
    lastUpdated: maxTimestamp([preliminary.lastUpdated, indicative?.lastUpdated]),
    preliminaryLastUpdated: preliminary.lastUpdated || null,
    indicativeLastUpdated: indicative?.lastUpdated || null,
    primaryCandidates: preliminary.candidates || [],
    indicativeVenueId: indicative?.venueId ?? preliminary.venueId,
    historicVenueId,
    historicMatched: Boolean(historicRow?.preliminary),
    leaderGroup: currentTcp.leader?.group || "oth",
    leaderName: currentTcp.leader?.name || null,
    leaderTcpPct: currentTcp.leader?.pct ?? null,
    leaderTcpSwing: null,
    selectedTcpPct: null,
    selectedTcpSwing: null,
    tcpByKey: {},
    tcpPctByGroup: {},
    historicTcpPctByGroup: {},
    historicTotalVotes: historicRow?.preliminary?.totalVotes ?? null,
    historicFormalVotes: historicRow?.preliminary?.formalVotes ?? null,
    historicInformalVotes: historicRow?.preliminary?.informalVotes ?? null,
    historicFormalPct: historicRow?.preliminary ? parsePct(historicRow.preliminary.formalVotesPercentage) : null,
    historicInformalPct: historicRow?.preliminary ? parsePct(historicRow.preliminary.informalVotesPercentage) : null,
    historicPrimaryCandidates: historicRow?.preliminary?.candidates || [],
  };

  for (const group of PARTY_GROUPS) row[`${group}Pct`] = primary[group].pct;
  for (const group of PARTY_GROUPS) row[`historic${group}Pct`] = historicPrimary?.[group]?.pct ?? null;
  for (const group of SWING_PARTY_GROUPS) {
    row[`${group}Swing`] = historicPrimary && primary[group].pct !== null && historicPrimary[group].pct !== null
      ? primary[group].pct - historicPrimary[group].pct
      : null;
  }

  if (currentTcp.leader && historicTcp.leader) {
    const historicCandidate = selectedCandidateRows(historicRow?.indicative).find(candidate => candidate.group === currentTcp.leader.group);
    if (historicCandidate?.pct !== null && historicCandidate?.pct !== undefined) {
      row.leaderTcpSwing = currentTcp.leader.pct - historicCandidate.pct;
    }
  }

  for (const candidate of selectedCandidateRows(indicative)) {
    row.tcpByKey[candidateKey(candidate)] = candidate;
    if (candidate.pct !== null) row.tcpPctByGroup[candidate.group] = candidate.pct;
  }
  for (const candidate of selectedCandidateRows(historicRow?.indicative)) {
    if (candidate.pct !== null) row.historicTcpPctByGroup[candidate.group] = candidate.pct;
  }

  return row;
}

function candidateKey(candidate) {
  return `${candidate.ballotOrder ?? candidate.name}:${candidate.group}`;
}

function tcpStorageKey() {
  return `qld-tcp-candidate:${config.electionId}:${electorateStub}`;
}

function configureTcpCandidates(indicativeTotals) {
  currentTcpFormalVotes = indicativeTotals?.totalFormalVotes ?? indicativeTotals?.totalVotes ?? null;
  const candidates = selectedCandidateRows(indicativeTotals);
  candidates.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  tcpCandidates = candidates.map(candidate => ({
    ...candidate,
    key: candidateKey(candidate),
  }));

  const stored = localStorage.getItem(tcpStorageKey());
  if (stored && tcpCandidates.some(candidate => candidate.key === stored)) {
    selectedTcpCandidateKey = stored;
    return;
  }

  selectedTcpCandidateKey = tcpCandidates[0]?.key || null;
  if (selectedTcpCandidateKey) localStorage.setItem(tcpStorageKey(), selectedTcpCandidateKey);
}

function getSelectedTcpCandidate() {
  return tcpCandidates.find(candidate => candidate.key === selectedTcpCandidateKey) || tcpCandidates[0] || null;
}

function stampSelectedTcpValues(rows) {
  const selected = getSelectedTcpCandidate();
  for (const row of rows) {
    const candidate = selected ? row.tcpByKey[selected.key] : null;
    row.selectedTcpPct = candidate?.pct ?? null;
    const historicPct = selected ? row.historicTcpPctByGroup[selected.group] : null;
    row.selectedTcpSwing = row.selectedTcpPct !== null && historicPct !== null && historicPct !== undefined
      ? row.selectedTcpPct - historicPct
      : null;
  }
}

function tcpCandidateLabel(candidate, useCandidateNames) {
  if (!candidate) return "TCP";
  if (useCandidateNames) return candidate.name || PARTY_LABELS[candidate.group] || "TCP";
  return PARTY_LABELS[candidate.group] || candidate.group.toUpperCase();
}

function renderTcpCandidateDropdown() {
  const pickerBtn = document.getElementById("tcp-candidate-picker");
  const menu = document.getElementById("tcp-candidate-menu");
  if (!pickerBtn) return;

  const selected = getSelectedTcpCandidate();
  const groupCounts = tcpCandidates.reduce((counts, candidate) => {
    counts[candidate.group] = (counts[candidate.group] || 0) + 1;
    return counts;
  }, {});
  const useCandidateNames = tcpCandidates.some(candidate => groupCounts[candidate.group] > 1);

  if (menu) {
    menu.innerHTML = "";
    menu.setAttribute("aria-hidden", "true");
    menu.style.display = "none";
  }

  pickerBtn.innerHTML = selected
    ? `<span class="tcp-party-dot ${partyClass(selected.group)}"></span>${tcpCandidateLabel(selected, useCandidateNames)} TCP`
    : "TCP";
  pickerBtn.className = `tcp-picker-btn ${selected ? partyClass(selected.group) : ""}`.trim();
  pickerBtn.title = tcpCandidates.length > 1 ? "Click to switch TCP candidate" : "TCP candidate";

  pickerBtn.onclick = event => {
    event.stopPropagation();
    selectNextTcpCandidate();
  };
  pickerBtn.onkeydown = event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectNextTcpCandidate();
    }
  };
}

function selectNextTcpCandidate() {
  if (tcpCandidates.length <= 1) return;
  const currentIndex = tcpCandidates.findIndex(candidate => candidate.key === selectedTcpCandidateKey);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % tcpCandidates.length : 0;
  selectTcpCandidate(tcpCandidates[nextIndex].key);
}

function selectTcpCandidate(key) {
  selectedTcpCandidateKey = key;
  localStorage.setItem(tcpStorageKey(), key);
  stampSelectedTcpValues(allRowsData);
  renderTcpCandidateDropdown();
  renderCurrentRows();
  renderPrediction();
}

function renderPrediction() {
  const predictionEl = document.getElementById("prediction");
  if (!predictionEl) return;

  const prediction = calculatePrediction(allRowsData);
  if (!prediction) {
    predictionEl.hidden = true;
    predictionEl.textContent = "";
    predictionEl.className = "prediction";
    return;
  }

  predictionEl.hidden = false;
  predictionEl.className = `prediction ${partyClass(prediction.group)}`;
  predictionEl.textContent = prediction.unavailableReason
    ? `Prediction unavailable: ${prediction.unavailableReason}`
    : `Prediction: ${prediction.label} projected TCP ${fmtPct(prediction.projectedPct)}% (${fmtSwing(prediction.swing)}%) | Win chance ${fmtWinChance(prediction.winChance)}`;
}

function calculatePrediction(rows) {
  const selected = getSelectedTcpCandidate();
  if (!selected) return null;

  const matchedRows = rows.filter(row => row.historicTcpPctByGroup?.[selected.group] !== undefined && row.selectedTcpPct !== null);
  if (matchedRows.length === 0) {
    return {
      unavailableReason: `${PARTY_LABELS[selected.group] || selected.group.toUpperCase()} was not in the historic TCP pair for any matched booth`,
      group: selected.group,
    };
  }

  const currentMatched = aggregateSelectedTcp(matchedRows, selected, false);
  const historicMatched = aggregateSelectedTcp(matchedRows, selected, true);
  const historicFull = aggregateHistoricFullTcp(rows, selected.group);
  if (currentMatched === null || historicMatched === null || historicFull === null) {
    return {
      unavailableReason: `${PARTY_LABELS[selected.group] || selected.group.toUpperCase()} was not in the historic TCP pair`,
      group: selected.group,
    };
  }

  const swing = currentMatched - historicMatched;
  const projectedPct = historicFull.pct + swing;
  const se = boothSwingStandardError(matchedRows, selected, swing);
  const currentFormal = currentTcpFormalVotes || sumCurrentFormalVotes(matchedRows);
  const expectedFormal = historicFull.expectedFormalVotes;
  const proportionCounted = expectedFormal > 0 ? Math.min(currentFormal / expectedFormal, 1) : 1;
  const adjustedSe = se * Math.sqrt(Math.max(0, 1 - proportionCounted));
  const winChance = winChanceFromProjection(projectedPct / 100, adjustedSe / 100);

  return {
    group: selected.group,
    label: PARTY_LABELS[selected.group] || selected.group.toUpperCase(),
    projectedPct,
    swing,
    winChance,
    matchedBooths: matchedRows.length,
    totalBooths: rows.length,
  };
}

function aggregateHistoricFullTcp(rows, group) {
  if (historicTcpTotals[group] === undefined || !historicTcpFormalVotes) return null;
  return { pct: historicTcpTotals[group], formalVotes: historicTcpFormalVotes, expectedFormalVotes: historicExpectedFormalVotes || historicTcpFormalVotes };
}

function boothSwingStandardError(rows, selected, overallSwing) {
  const totalCurrentFormal = sumCurrentFormalVotes(rows);
  if (totalCurrentFormal <= 0) return 0;

  let variance = 0;
  for (const row of rows) {
    if (row.selectedTcpPct === null || row.historicTcpPctByGroup?.[selected.group] === undefined) continue;
    const currentFormal = currentFormalVotes(row);
    if (currentFormal <= 0) continue;
    const boothSwing = row.selectedTcpPct - row.historicTcpPctByGroup[selected.group];
    const weight = currentFormal / totalCurrentFormal;
    variance += Math.pow(weight, 2) * Math.pow(boothSwing - overallSwing, 2);
  }
  return Math.sqrt(variance);
}

function currentFormalVotes(row) {
  return row.formalVotes ?? (row.formalPct !== null ? (row.totalVotes || 0) * (row.formalPct / 100) : 0);
}

function sumCurrentFormalVotes(rows) {
  return rows.reduce((sum, row) => sum + currentFormalVotes(row), 0);
}

function winChanceFromProjection(projectedTpp, adjustedSe) {
  if (adjustedSe <= 0.000001) return projectedTpp > 0.5 ? 1 : projectedTpp < 0.5 ? 0 : 0.5;
  return 1 - normalCdf((0.5 - projectedTpp) / adjustedSe);
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function fmtWinChance(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  if (value > 0.995) return ">99%";
  if (value < 0.005) return "<1%";
  return `${Math.round(value * 100)}%`;
}

function renderCurrentRows() {
  stampSelectedTcpValues(allRowsData);
  const rows = getSortedRows(allRowsData, sortState);
  renderTable(rows);
  renderTotals(rows);
}

function renderRow(row) {
  const tr = document.createElement("tr");
  const boothCell = makeCell("", "col-booth sticky-col");
  const boothButton = document.createElement("button");
  boothButton.type = "button";
  boothButton.className = "booth-detail-btn";
  boothButton.textContent = row.venueName;
  boothButton.addEventListener("click", () => openBoothModal(row));
  boothCell.appendChild(boothButton);
  tr.appendChild(boothCell);
  tr.appendChild(makeCell(fmtInt(row.totalVotes), "col-num"));

  const selected = getSelectedTcpCandidate();
  const selectedClass = partyClass(selected?.group || "oth");
  const tcpCell = makeCell(fmtPct(row.selectedTcpPct), `col-num ${selectedClass}`);
  tcpCell.title = selected?.name || PARTY_LABELS[selected?.group] || "TCP";
  tr.appendChild(tcpCell);
  tr.appendChild(swingCell(row.selectedTcpSwing, `${selectedClass} col-swing`));

  for (const group of PARTY_GROUPS) {
    tr.appendChild(makeCell(fmtPct(row[`${group}Pct`]), `col-num ${partyClass(group)}`));
  }
  for (const group of SWING_PARTY_GROUPS) {
    tr.appendChild(swingCell(row[`${group}Swing`], `${partyClass(group)} col-swing`));
  }

  const updatedCell = makeCell(fmtTime(row.lastUpdated), "col-updated");
  updatedCell.title = fmtDateTime(row.lastUpdated);
  tr.appendChild(updatedCell);

  return tr;
}

function renderTable(rows) {
  const tbody = document.getElementById("results-body");
  tbody.innerHTML = "";
  for (const row of rows) tbody.appendChild(renderRow(row));
}

function renderTotals(rows) {
  const totalsRow = document.getElementById("totals-row");
  totalsRow.innerHTML = "";

  const current = aggregateTotals(rows, false);
  totalsRow.appendChild(makeCell("Total", "col-booth sticky-col"));
  totalsRow.appendChild(makeCell(fmtInt(current.totalVotes), "col-num"));
  const selected = getSelectedTcpCandidate();
  const selectedClass = partyClass(selected?.group || "oth");
  totalsRow.appendChild(makeCell(fmtPct(current.selectedTcpPct), `col-num ${selectedClass}`));
  totalsRow.appendChild(swingCell(current.selectedTcpSwing, `${selectedClass} col-swing`));

  for (const group of PARTY_GROUPS) {
    totalsRow.appendChild(makeCell(fmtPct(current[`${group}Pct`]), `col-num ${partyClass(group)}`));
  }
  for (const group of SWING_PARTY_GROUPS) {
    const swing = current[`${group}Pct`] !== null && historicPrimaryTotals[group] !== null && historicPrimaryTotals[group] !== undefined
      ? current[`${group}Pct`] - historicPrimaryTotals[group]
      : null;
    totalsRow.appendChild(swingCell(swing, `${partyClass(group)} col-swing`));
  }
  totalsRow.appendChild(makeCell("", "col-updated"));
}

function aggregateTotals(rows, historic) {
  const result = {
    totalVotes: 0,
    formalVotes: 0,
    formalPct: null,
    leaderGroup: "oth",
    leaderTcpPct: null,
    leaderTcpSwing: null,
    selectedTcpPct: null,
    selectedTcpSwing: null,
  };
  const groupVotes = Object.fromEntries(PARTY_GROUPS.map(group => [group, 0]));
  const tcpVotes = {};

  for (const row of rows) {
    const totalVotes = historic ? (row.historicTotalVotes || 0) : (row.totalVotes || 0);
    const formalPct = historic ? row.historicFormalPct : row.formalPct;
    const formalVotes = historic
      ? (row.historicFormalVotes ?? (formalPct !== null ? totalVotes * (formalPct / 100) : 0))
      : (row.formalVotes ?? (formalPct !== null ? totalVotes * (formalPct / 100) : 0));
    result.totalVotes += totalVotes;
    result.formalVotes += formalVotes;
    for (const group of PARTY_GROUPS) {
      const pct = historic ? row[`historic${group}Pct`] : row[`${group}Pct`];
      if (pct !== null && pct !== undefined) groupVotes[group] += formalVotes * (pct / 100);
    }
    const tcpByGroup = historic ? row.historicTcpPctByGroup : row.tcpPctByGroup;
    for (const [group, pct] of Object.entries(tcpByGroup || {})) {
      if (pct !== null && pct !== undefined) tcpVotes[group] = (tcpVotes[group] || 0) + formalVotes * (pct / 100);
    }
  }

  result.formalPct = result.totalVotes > 0 ? (result.formalVotes / result.totalVotes) * 100 : null;
  for (const group of PARTY_GROUPS) {
    result[`${group}Pct`] = result.formalVotes > 0 ? (groupVotes[group] / result.formalVotes) * 100 : null;
  }

  const selected = getSelectedTcpCandidate();
  if (!historic && selected) {
    const currentSelected = selected.pct ?? aggregateSelectedTcp(rows, selected, false);
    const historicTotal = historicTcpTotals[selected.group] ?? null;
    result.selectedTcpPct = currentSelected;
    result.selectedTcpSwing = currentSelected !== null && historicTotal !== null
      ? currentSelected - historicTotal
      : null;
  }
  for (const group of PARTY_GROUPS) {
    result[`${group}TcpPct`] = result.formalVotes > 0 && tcpVotes[group] !== undefined
      ? (tcpVotes[group] / result.formalVotes) * 100
      : null;
  }
  return result;
}

function aggregateSelectedTcp(rows, selected, historic) {
  let votes = 0;
  let formalVotesTotal = 0;
  for (const row of rows) {
    const totalVotes = historic ? (row.historicTotalVotes || 0) : (row.totalVotes || 0);
    const formalPct = historic ? row.historicFormalPct : row.formalPct;
    const formalVotes = historic
      ? (row.historicFormalVotes ?? (formalPct !== null ? totalVotes * (formalPct / 100) : 0))
      : (row.formalVotes ?? (formalPct !== null ? totalVotes * (formalPct / 100) : 0));
    const pct = historic ? row.historicTcpPctByGroup[selected.group] : row.selectedTcpPct;
    if (pct !== null && pct !== undefined) {
      votes += formalVotes * (pct / 100);
      formalVotesTotal += formalVotes;
    }
  }
  return formalVotesTotal > 0 ? (votes / formalVotesTotal) * 100 : null;
}

function initBoothModal() {
  const modal = document.getElementById("booth-modal");
  const closeBtn = document.getElementById("booth-modal-close");
  if (!modal || !closeBtn) return;

  closeBtn.addEventListener("click", closeBoothModal);
  modal.addEventListener("click", event => {
    if (event.target === modal) closeBoothModal();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !modal.hidden) closeBoothModal();
  });
}

function closeBoothModal() {
  const modal = document.getElementById("booth-modal");
  if (modal) modal.hidden = true;
  openBoothVenueId = null;
}

function refreshOpenBoothModal() {
  if (!openBoothVenueId) return;
  const row = allRowsData.find(item => String(item.venueId) === String(openBoothVenueId));
  if (row) openBoothModal(row, { refresh: true });
}

async function openBoothModal(row, options = {}) {
  openBoothVenueId = row.venueId;
  const modal = document.getElementById("booth-modal");
  const title = document.getElementById("booth-modal-title");
  const subtitle = document.getElementById("booth-modal-subtitle");
  const content = document.getElementById("booth-modal-content");
  if (!modal || !title || !subtitle || !content) return;

  modal.hidden = false;
  title.textContent = row.venueName;
  subtitle.textContent = `Total votes ${fmtInt(row.totalVotes)} | Updated ${fmtDateTime(row.lastUpdated)}`;
  if (!options.refresh) content.textContent = "Loading booth details...";

  const [currentResult, historicResult] = await Promise.all([
    fetchBoothDetail(row, false).then(data => ({ data })).catch(error => ({ error })),
    fetchBoothDetail(row, true).then(data => ({ data })).catch(error => ({ error })),
  ]);

  if (openBoothVenueId !== row.venueId) return;
  renderBoothModal(row, currentResult, historicResult);
}

async function fetchBoothDetail(row, historic) {
  if (historic && (!config.historicElectionId || !row.historicMatched)) return null;
  const electionId = historic ? config.historicElectionId : config.electionId;
  const stub = historic ? getHistoricStub(config, electorateStub) : electorateStub;
  const venueId = historic ? row.historicVenueId : (row.indicativeVenueId || row.venueId);
  const cache = historic ? historicBoothDetailCache : currentBoothDetailCache;
  const key = `${electionId}:${stub}:${venueId}`;
  if (!cache.has(key)) {
    const request = fetchJson(endpoint(electionId, `indicative-count-booth-${stub}-${venueId}.json`), { cacheBust: !historic }).catch(error => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, request);
  }
  return cache.get(key);
}

function renderBoothModal(row, currentResult, historicResult) {
  const content = document.getElementById("booth-modal-content");
  if (!content) return;
  content.innerHTML = "";

  const sections = makeEl("div", "modal-section-grid");
  sections.appendChild(renderDetailSection("Current", row, currentResult, false));
  sections.appendChild(renderDetailSection("Historic", row, historicResult, true));
  content.appendChild(sections);

  const current = currentResult?.data || null;
  const historic = historicResult?.data || null;
  if (current && historic) {
    content.appendChild(renderFlowComparison(current, historic));
  }
}

function renderDetailSection(label, row, result, historic) {
  const section = makeEl("section", "booth-detail-section");
  section.appendChild(makeEl("h3", "", label));

  if (result?.error) {
    section.appendChild(makeEl("p", "modal-warning", `Unable to load ${label.toLowerCase()} preference detail: ${result.error.message}`));
  }
  if (!result?.data) {
    if (!result?.error) section.appendChild(makeEl("p", "modal-warning", `${label} preference detail is unavailable.`));
    section.appendChild(renderStatsGrid(row, null, historic));
    return section;
  }

  const detail = result.data;
  section.appendChild(renderStatsGrid(row, detail, historic));
  section.appendChild(renderPrimaryChart(detail));
  section.appendChild(renderTcpChart(detail));
  section.appendChild(renderFlowChart(detail));
  section.appendChild(renderFlowTable(detail));
  return section;
}

function renderStatsGrid(row, detail, historic) {
  const totalVotes = historic ? row.historicTotalVotes : row.totalVotes;
  const formalVotes = historic ? row.historicFormalVotes : row.formalVotes;
  const formalPct = historic ? row.historicFormalPct : row.formalPct;
  const informalVotes = historic ? row.historicInformalVotes : row.informalVotes;
  const informalPct = historic ? row.historicInformalPct : row.informalPct;
  const updated = detail?.lastUpdated || (historic ? null : row.lastUpdated);
  const grid = makeEl("dl", "stats-grid");
  appendStat(grid, "Total", fmtInt(totalVotes));
  appendStat(grid, "Formal", `${fmtInt(formalVotes)} (${fmtPct(formalPct)}%)`);
  appendStat(grid, "Informal", `${fmtInt(informalVotes)} (${fmtPct(informalPct)}%)`);
  appendStat(grid, "Updated", fmtDateTime(updated));
  return grid;
}

function appendStat(grid, label, value) {
  grid.appendChild(makeEl("dt", "", label));
  grid.appendChild(makeEl("dd", "", value));
}

function renderPrimaryChart(detail) {
  const rows = primaryRows(detail);
  const chart = makeChartBlock("Primary Vote");
  for (const candidate of rows) {
    chart.appendChild(renderSingleBar(candidate.label, candidate.pct, candidate.group, `${fmtInt(candidate.votes)} (${fmtPct(candidate.pct)}%)`));
  }
  return chart;
}

function renderTcpChart(detail) {
  const chart = makeChartBlock("TCP / Final Count");
  for (const candidate of selectedRows(detail)) {
    const gain = candidate.preferences - candidate.primary;
    chart.appendChild(renderSingleBar(candidate.label, candidate.pct, candidate.group, `${fmtInt(candidate.preferences)} (${fmtPct(candidate.pct)}%), gain ${fmtInt(gain)}`));
  }
  return chart;
}

function renderFlowChart(detail) {
  const selected = selectedRows(detail);
  const chart = makeChartBlock("Preference Flows");
  for (const candidate of otherRows(detail)) {
    const total = candidate.primary || 0;
    const toFirstPct = total > 0 ? (candidate.toFirst / total) * 100 : 0;
    const toSecondPct = total > 0 ? (candidate.toSecond / total) * 100 : 0;
    const exhaustedPct = total > 0 ? (candidate.exhausted / total) * 100 : 0;
    const row = makeEl("div", "stacked-row");
    row.appendChild(makeEl("div", "bar-label", candidate.label));
    const bar = makeEl("div", "stacked-bar");
    bar.appendChild(flowSegment(toFirstPct, selected[0]?.group, `${selected[0]?.label || "Candidate 1"}: ${fmtPct(toFirstPct)}%`));
    bar.appendChild(flowSegment(toSecondPct, selected[1]?.group, `${selected[1]?.label || "Candidate 2"}: ${fmtPct(toSecondPct)}%`));
    bar.appendChild(flowSegment(exhaustedPct, "oth", `Exhausted: ${fmtPct(exhaustedPct)}%`));
    row.appendChild(bar);
    chart.appendChild(row);
  }
  return chart;
}

function flowSegment(width, group, title) {
  const segment = makeEl("span", `flow-segment ${partyClass(group || "oth")}`);
  segment.style.width = `${Math.max(0, Math.min(100, width))}%`;
  segment.title = title;
  return segment;
}

function renderFlowTable(detail) {
  const selected = selectedRows(detail);
  const table = makeEl("table", "detail-table");
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  ["Candidate", "Primary", selected[0]?.label || "Candidate 1", selected[1]?.label || "Candidate 2", "Exhausted"].forEach(text => header.appendChild(makeEl("th", "", text)));
  thead.appendChild(header);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const candidate of otherRows(detail)) {
    const total = candidate.primary || 0;
    const tr = document.createElement("tr");
    tr.appendChild(makeEl("td", "", candidate.label));
    tr.appendChild(makeEl("td", "col-num", fmtInt(candidate.primary)));
    tr.appendChild(makeEl("td", "col-num", flowCellText(candidate.toFirst, total)));
    tr.appendChild(makeEl("td", "col-num", flowCellText(candidate.toSecond, total)));
    tr.appendChild(makeEl("td", "col-num", flowCellText(candidate.exhausted, total)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function renderFlowComparison(current, historic) {
  const section = makeEl("section", "flow-comparison");
  section.appendChild(makeEl("h3", "", "Current vs Historic Preference Flow"));
  const table = makeEl("table", "detail-table");
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  ["Current candidate", "Current flow", "Historic match", "Historic flow"].forEach(text => header.appendChild(makeEl("th", "", text)));
  thead.appendChild(header);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  const historicByKey = new Map(otherRows(historic).map(candidate => [alignmentKey(candidate), candidate]));
  for (const candidate of otherRows(current)) {
    const historicCandidate = historicByKey.get(alignmentKey(candidate));
    const tr = document.createElement("tr");
    tr.appendChild(makeEl("td", "", candidate.label));
    tr.appendChild(makeEl("td", "", compactFlowText(candidate)));
    tr.appendChild(makeEl("td", "", historicCandidate?.label || "-"));
    tr.appendChild(makeEl("td", "", historicCandidate ? compactFlowText(historicCandidate) : "-"));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

function makeChartBlock(title) {
  const block = makeEl("div", "chart-block");
  block.appendChild(makeEl("h4", "", title));
  return block;
}

function renderSingleBar(label, pct, group, valueText) {
  const row = makeEl("div", "bar-row");
  row.appendChild(makeEl("div", "bar-label", label));
  const track = makeEl("div", "bar-track");
  const fill = makeEl("div", `bar-fill ${partyClass(group)}`);
  fill.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(makeEl("div", "bar-value", valueText));
  return row;
}

function selectedRows(detail) {
  return (detail.selectedCandidates || []).map(candidate => {
    const group = partyGroup(candidate.partyCode, candidate.party);
    return {
      label: candidate.candidateName || candidate.ballotName || PARTY_LABELS[group] || "Candidate",
      group,
      primary: Number(candidate.primary ?? 0) || 0,
      preferences: Number(candidate.preferences ?? candidate.total ?? 0) || 0,
      pct: parsePct(candidate.preferencesPercentage ?? candidate.percentage),
    };
  });
}

function otherRows(detail) {
  return (detail.otherCandidates || []).map(candidate => {
    const group = partyGroup(candidate.partyCode, candidate.party);
    return {
      label: candidate.candidateName || PARTY_LABELS[group] || "Candidate",
      party: candidate.party || "",
      partyCode: candidate.partyCode || "",
      group,
      primary: Number(candidate.primary ?? 0) || 0,
      toFirst: Number(candidate.selectedCandidate1Preferences ?? 0) || 0,
      toSecond: Number(candidate.selectedCandidate2Preferences ?? 0) || 0,
      exhausted: Number(candidate.exhausted ?? 0) || 0,
    };
  });
}

function primaryRows(detail) {
  const selected = selectedRows(detail).map(candidate => ({
    label: candidate.label,
    group: candidate.group,
    votes: candidate.primary,
  }));
  const others = otherRows(detail).map(candidate => ({
    label: candidate.label,
    group: candidate.group,
    votes: candidate.primary,
  }));
  const total = Number(detail.totalFormalVotes ?? detail.totalVotes ?? 0) || selected.concat(others).reduce((sum, candidate) => sum + candidate.votes, 0);
  return selected.concat(others).map(candidate => ({
    ...candidate,
    pct: total > 0 ? (candidate.votes / total) * 100 : null,
  })).sort((a, b) => b.votes - a.votes);
}

function flowCellText(count, total) {
  const pct = total > 0 ? (count / total) * 100 : null;
  return `${fmtInt(count)} (${fmtPct(pct)}%)`;
}

function compactFlowText(candidate) {
  const total = candidate.primary || 0;
  return `1: ${flowCellText(candidate.toFirst, total)} | 2: ${flowCellText(candidate.toSecond, total)} | Exh: ${flowCellText(candidate.exhausted, total)}`;
}

function alignmentKey(candidate) {
  if (candidate.group !== "oth") return `party:${candidate.group}`;
  return `name:${String(candidate.label || "").trim().toLowerCase()}`;
}

function makeEl(tag, className = "", text = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null) el.textContent = text;
  return el;
}
