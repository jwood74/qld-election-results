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

document.addEventListener("DOMContentLoaded", init);

async function init() {
  electorateStub = new URLSearchParams(window.location.search).get("electorate");
  if (!electorateStub) {
    setStatus("Missing electorate query parameter.", true);
    return;
  }

  initSorting(sortState, renderCurrentRows);

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

async function loadAndRender() {
  const checkedAt = new Date();
  const historicStub = getHistoricStub(config, electorateStub);

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
    return parseBoothRow(preliminary, indicative, historicRow);
  });
}

function parseBoothRow(preliminary, indicative, historicRow) {
  const primary = aggregateCandidates(preliminary.candidates);
  const historicPrimary = historicRow?.preliminary ? aggregateCandidates(historicRow.preliminary.candidates) : null;
  const currentTcp = leaderFromIndicative(indicative);
  const historicTcp = leaderFromIndicative(historicRow?.indicative);

  const row = {
    venueId: preliminary.venueId,
    venueName: preliminary.venueName,
    totalVotes: preliminary.totalVotes ?? null,
    formalVotes: preliminary.formalVotes ?? null,
    formalPct: parsePct(preliminary.formalVotesPercentage),
    lastUpdated: maxTimestamp([preliminary.lastUpdated, indicative?.lastUpdated]),
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
    historicFormalPct: historicRow?.preliminary ? parsePct(historicRow.preliminary.formalVotesPercentage) : null,
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
  tr.appendChild(makeCell(row.venueName, "col-booth sticky-col"));
  tr.appendChild(makeCell(fmtInt(row.totalVotes), "col-num"));
  tr.appendChild(makeCell(fmtPct(row.formalPct), "col-num"));

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
  totalsRow.appendChild(makeCell(fmtPct(current.formalPct), "col-num"));
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
