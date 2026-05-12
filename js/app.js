let config;
let allRowsData = [];
let sortState = { key: null, direction: null };
let refreshTimer = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  initSorting(sortState, updateTableWithFilters);
  const filterInput = document.getElementById("filter-electorate");
  filterInput?.addEventListener("input", updateTableWithFilters);
  if (filterInput && window.matchMedia("(pointer: fine)").matches) {
    filterInput.focus();
  }

  try {
    config = await loadConfig();
    await loadAndRender();
    if (config.refreshSeconds > 0) {
      refreshTimer = setInterval(loadAndRender, config.refreshSeconds * 1000);
    }
  } catch (error) {
    setStatus(`Unable to load election config: ${error.message}`, true);
  }
}

async function loadAndRender() {
  const checkedAt = new Date();
  const warnings = [];
  try {
    const [metadata, electoratesData] = await Promise.all([
      loadElectionMetadata(config.electionId).catch(() => null),
      fetchJson(endpoint(config.electionId, "electorates.json"), { cacheBust: true }),
    ]);

    const electorates = (electoratesData.electorates || []).filter(e => e.contestType === "State");
    setElectionLabel(metadata ? `${metadata.electionName} (${config.electionId})` : config.electionId);

    const rows = await Promise.all(electorates.map(electorate => loadElectorateRow(electorate, warnings)));
    allRowsData = rows;
    updateTableWithFilters();

    const latestEcqUpdate = maxTimestamp(rows.map(row => row.lastUpdated));
    const warningText = warnings.length ? ` ${warnings.length} endpoint warning${warnings.length === 1 ? "" : "s"}.` : "";
    setStatus(`${rows.length} electorate${rows.length === 1 ? "" : "s"}. ECQ updated ${fmtDateTime(latestEcqUpdate)}. Last checked ${fmtDateTime(checkedAt)}.${warningText}`);
  } catch (error) {
    setStatus(`Unable to load electorate list: ${error.message}`, true);
  }
}

async function loadElectorateRow(electorate, warnings) {
  const stub = electorate.stub;
  const row = {
    electorateName: electorate.electorateName,
    electorateStub: stub,
    enrolment: electorate.enrolment ?? null,
    totalVotes: null,
    formalVotes: null,
    formalPct: null,
    leaderTcpPct: null,
    leaderGroup: "oth",
    lastUpdated: null,
    lastUpdatedTime: null,
    alpPct: null,
    lnpPct: null,
    kapPct: null,
    grnPct: null,
    onpPct: null,
    othPct: null,
  };

  const [preliminary, indicative] = await Promise.all([
    fetchJson(endpoint(config.electionId, `preliminary-count-district-${stub}.json`), { cacheBust: true }).catch(error => {
      warnings.push(`${stub} preliminary: ${error.message}`);
      return null;
    }),
    fetchJson(endpoint(config.electionId, `indicative-count-district-${stub}.json`), { cacheBust: true }).catch(error => {
      warnings.push(`${stub} indicative: ${error.message}`);
      return null;
    }),
  ]);

  if (preliminary) {
    const groups = aggregateCandidates(preliminary.candidates);
    row.totalVotes = preliminary.totalVotes ?? null;
    row.formalVotes = preliminary.formalVotes ?? null;
    row.formalPct = parsePct(preliminary.formalVotesPercentage);
    row.lastUpdated = preliminary.lastUpdated || null;
    for (const group of PARTY_GROUPS) row[`${group}Pct`] = groups[group].pct;
  }

  const tcp = leaderFromIndicative(indicative);
  if (tcp.leader) {
    row.leaderTcpPct = tcp.leader.pct;
    row.leaderGroup = tcp.leader.group;
    row.leaderName = tcp.leader.name;
    row.lastUpdated = maxTimestamp([row.lastUpdated, indicative.lastUpdated]);
  }
  row.lastUpdatedTime = row.lastUpdated ? new Date(row.lastUpdated).getTime() : null;
  return row;
}

function renderRow(row) {
  const tr = document.createElement("tr");

  const electorateCell = document.createElement("td");
  electorateCell.className = "col-electorate sticky-col";
  const link = document.createElement("a");
  link.href = `electorate.html?electorate=${encodeURIComponent(row.electorateStub)}`;
  link.textContent = row.electorateName;
  link.className = "contest-link";
  electorateCell.appendChild(link);
  tr.appendChild(electorateCell);

  tr.appendChild(makeCell(fmtInt(row.enrolment), "col-num"));
  tr.appendChild(makeCell(fmtInt(row.totalVotes), "col-num"));
  tr.appendChild(makeCell(fmtPct(row.formalPct), "col-num"));

  const leaderClass = partyClass(row.leaderGroup);
  const tcpCell = makeCell(fmtPct(row.leaderTcpPct), `col-num ${leaderClass}`);
  tcpCell.title = row.leaderName || PARTY_LABELS[row.leaderGroup] || "Leader";
  tr.appendChild(tcpCell);

  for (const group of PARTY_GROUPS) {
    tr.appendChild(makeCell(fmtPct(row[`${group}Pct`]), `col-num ${partyClass(group)}`));
  }

  tr.appendChild(makeCell(fmtDateTime(row.lastUpdated), "col-updated"));
  return tr;
}

function renderTable(rows) {
  const tbody = document.getElementById("results-body");
  tbody.innerHTML = "";
  for (const row of rows) tbody.appendChild(renderRow(row));
}

function filterRows(rows) {
  const filter = document.getElementById("filter-electorate")?.value.trim().toLowerCase() || "";
  return rows.filter(row => !filter || row.electorateName.toLowerCase().includes(filter));
}

function updateTableWithFilters() {
  const filtered = filterRows(getSortedRows(allRowsData, sortState));
  renderTable(filtered);
  updateTotals(filtered);
}

function updateTotals(rows) {
  const totals = Object.fromEntries(PARTY_GROUPS.map(group => [group, 0]));
  let formalVotes = 0;
  for (const row of rows) {
    if (!row.totalVotes || !row.formalPct) continue;
    const formal = row.formalVotes ?? row.totalVotes * (row.formalPct / 100);
    formalVotes += formal;
    for (const group of PARTY_GROUPS) {
      if (row[`${group}Pct`] !== null) totals[group] += formal * (row[`${group}Pct`] / 100);
    }
  }
  for (const group of PARTY_GROUPS) {
    const cell = document.getElementById(`total-${group}Pct`);
    if (cell) cell.textContent = formalVotes > 0 ? fmtPct((totals[group] / formalVotes) * 100) : "-";
  }
}
