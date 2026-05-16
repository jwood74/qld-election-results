let config;
let electorateStub;
let refreshTimer = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  electorateStub = new URLSearchParams(window.location.search).get("electorate");
  if (!electorateStub) {
    setStatus("Missing electorate query parameter.", true);
    return;
  }

  const backLink = document.getElementById("back-link");
  if (backLink) backLink.href = `electorate.html?electorate=${encodeURIComponent(electorateStub)}`;

  try {
    config = await loadConfig();
    await loadAndRender();
    if (config.refreshSeconds > 0) {
      refreshTimer = setInterval(loadAndRender, config.refreshSeconds * 1000);
    }
  } catch (error) {
    setStatus(`Unable to load preference flows: ${error.message}`, true);
  }
}

async function loadAndRender() {
  const checkedAt = new Date();
  const [metadata, current] = await Promise.all([
    loadElectionMetadata(config.electionId).catch(() => null),
    fetchJson(endpoint(config.electionId, `table-booths-${electorateStub}.json`), { cacheBust: true }),
  ]);

  setElectionLabel(metadata ? `${metadata.electionName} (${config.electionId})` : config.electionId);
  document.getElementById("electorate-label").textContent = current.electorateName || electorateStub;

  const aggregate = await aggregatePreferenceFlows(current.indicative);
  renderSummary(aggregate);
  renderFlowChart(aggregate);
  renderFlowTable(aggregate);

  const latestEcqUpdate = maxTimestamp((current.indicative?.booths || []).map(booth => booth.lastUpdated));
  setStatus(`${aggregate.boothsCount} TCP booth${aggregate.boothsCount === 1 ? "" : "s"}. ECQ updated ${fmtDateTime(latestEcqUpdate)}. Last checked ${fmtDateTime(checkedAt)}.`);
}

async function aggregatePreferenceFlows(indicative) {
  const selected = selectedRows(indicative?.totals);
  const flows = new Map();
  let boothsCount = 0;
  let totalFormalVotes = Number(indicative?.totals?.totalFormalVotes ?? indicative?.totals?.totalVotes ?? 0) || 0;
  let flowPrimaryVotes = 0;

  const boothDetails = await Promise.all((indicative?.booths || []).map(fetchFlowDetail));
  for (const booth of boothDetails.filter(Boolean)) {
    boothsCount += 1;
    for (const candidate of booth.otherCandidates) {
      const row = flowRow(candidate);
      const existing = flows.get(row.key) || {
        ...row,
        primary: 0,
        toFirst: 0,
        toSecond: 0,
        exhausted: 0,
      };
      existing.primary += Number(candidate.primary ?? 0) || 0;
      existing.toFirst += Number(candidate.selectedCandidate1Preferences ?? 0) || 0;
      existing.toSecond += Number(candidate.selectedCandidate2Preferences ?? 0) || 0;
      existing.exhausted += Number(candidate.exhausted ?? 0) || 0;
      flows.set(row.key, existing);
    }
  }

  const rows = [...flows.values()].sort((a, b) => b.primary - a.primary);
  flowPrimaryVotes = rows.reduce((sum, row) => sum + row.primary, 0);
  if (!totalFormalVotes) {
    totalFormalVotes = selected.reduce((sum, candidate) => sum + candidate.votes, 0) + flowPrimaryVotes;
  }

  return {
    selected,
    rows,
    boothsCount,
    totalFormalVotes,
    flowPrimaryVotes,
  };
}

async function fetchFlowDetail(booth) {
  const venueId = booth.venueId;
  const preference = await fetchBoothCount("preference", venueId).catch(() => null);
  if (preference?.otherCandidates?.length) return preference;

  const indicative = await fetchBoothCount("indicative", venueId).catch(() => null);
  if (indicative?.otherCandidates?.length) return indicative;

  if (booth.otherCandidates?.length) return booth;
  return null;
}

function fetchBoothCount(type, venueId) {
  return fetchJson(endpoint(config.electionId, `${type}-count-booth-${electorateStub}-${venueId}.json`), { cacheBust: true });
}

function selectedRows(indicative) {
  const source = indicative?.selectedCandidates?.length ? indicative.selectedCandidates : indicative?.candidates;
  return (source || []).map(candidate => {
    const group = partyGroup(candidate.partyCode, candidate.party);
    const code = candidatePartyCode(candidate, group);
    const name = candidate.candidateName || candidate.ballotName || PARTY_LABELS[group] || "Candidate";
    return {
      label: `${code} ${name}`,
      code,
      name,
      group,
      votes: Number(candidate.total ?? candidate.count ?? candidate.preferences ?? 0) || 0,
      pct: parsePct(candidate.preferencesPercentage ?? candidate.percentage),
    };
  });
}

function flowRow(candidate) {
  const group = partyGroup(candidate.partyCode, candidate.party);
  const code = candidatePartyCode(candidate, group);
  const name = candidate.candidateName || candidate.ballotName || PARTY_LABELS[group] || "Candidate";
  return {
    key: `${candidate.candidateBallotOrder ?? candidate.ballotOrderNumber ?? name}:${candidate.partyCode || ""}:${name}`,
    label: `${code} ${name}`,
    code,
    name,
    group,
  };
}

function renderSummary(aggregate) {
  const summary = document.getElementById("flow-summary");
  if (!summary) return;
  summary.innerHTML = "";
  appendStat(summary, "TCP Pair", aggregate.selected.map(candidate => candidate.label).join(" vs ") || "-");
  appendStat(summary, "TCP Booths", fmtInt(aggregate.boothsCount));
  appendStat(summary, "Formal Votes", fmtInt(aggregate.totalFormalVotes));
  appendStat(summary, "Flow Votes", fmtInt(aggregate.flowPrimaryVotes));
}

function renderFlowChart(aggregate) {
  const chart = document.getElementById("flow-chart");
  if (!chart) return;
  chart.innerHTML = "";

  if (!aggregate.rows.length) {
    chart.appendChild(makeEl("p", "modal-warning", "Preference flow data is unavailable until TCP counts are published."));
    return;
  }

  for (const row of aggregate.rows) {
    const total = row.primary || 0;
    const toFirstPct = total > 0 ? (row.toFirst / total) * 100 : 0;
    const toSecondPct = total > 0 ? (row.toSecond / total) * 100 : 0;
    const exhaustedPct = total > 0 ? (row.exhausted / total) * 100 : 0;
    const item = makeEl("div", "stacked-row flow-page-row");
    item.appendChild(renderCandidateLabel(row));
    const bar = makeEl("div", "stacked-bar");
    bar.appendChild(flowSegment(toFirstPct, aggregate.selected[0]?.group, `${aggregate.selected[0]?.label || "Candidate 1"}: ${fmtPct(toFirstPct)}%`));
    bar.appendChild(flowSegment(toSecondPct, aggregate.selected[1]?.group, `${aggregate.selected[1]?.label || "Candidate 2"}: ${fmtPct(toSecondPct)}%`));
    if (row.exhausted > 0) bar.appendChild(flowSegment(exhaustedPct, "oth", `Exhausted: ${fmtPct(exhaustedPct)}%`));
    item.appendChild(bar);
    item.appendChild(makeEl("div", "bar-value", flowText(row, aggregate.selected)));
    chart.appendChild(item);
  }
}

function renderFlowTable(aggregate) {
  const tbody = document.getElementById("flow-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const firstHeading = document.getElementById("flow-first-heading");
  const secondHeading = document.getElementById("flow-second-heading");
  if (firstHeading) firstHeading.textContent = aggregate.selected[0]?.label || "Candidate 1";
  if (secondHeading) secondHeading.textContent = aggregate.selected[1]?.label || "Candidate 2";

  for (const row of aggregate.rows) {
    const tr = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.className = "col-electorate sticky-col";
    labelCell.appendChild(renderCandidateLabel(row));
    tr.appendChild(labelCell);
    tr.appendChild(makeCell(fmtInt(row.primary), "col-num"));
    tr.appendChild(makeCell(flowCellText(row.toFirst, row.primary), "col-num"));
    tr.appendChild(makeCell(flowCellText(row.toSecond, row.primary), "col-num"));
    tr.appendChild(makeCell(flowCellText(row.exhausted, row.primary), "col-num"));
    tbody.appendChild(tr);
  }
}

function renderCandidateLabel(candidate) {
  const label = makeEl("div", "bar-label");
  label.appendChild(makeEl("span", "candidate-code", candidate.code));
  label.appendChild(document.createTextNode(" "));
  label.appendChild(makeEl("span", "candidate-name", candidate.name));
  return label;
}

function flowSegment(width, group, title) {
  const segment = makeEl("span", `flow-segment ${partyClass(group || "oth")}`);
  segment.style.width = `${Math.max(0, Math.min(100, width))}%`;
  segment.title = title;
  return segment;
}

function flowText(row, selected) {
  const total = row.primary || 0;
  const values = [
    `${selected[0]?.code || "1"} ${fmtPct(total > 0 ? (row.toFirst / total) * 100 : null)}%`,
    `${selected[1]?.code || "2"} ${fmtPct(total > 0 ? (row.toSecond / total) * 100 : null)}%`,
  ];
  if (row.exhausted > 0) values.push(`EXH ${fmtPct(total > 0 ? (row.exhausted / total) * 100 : null)}%`);
  return values.join(" | ");
}

function flowCellText(count, total) {
  const pct = total > 0 ? (count / total) * 100 : null;
  return `${fmtInt(count)} (${fmtPct(pct)}%)`;
}

function appendStat(grid, label, value) {
  grid.appendChild(makeEl("dt", "", label));
  grid.appendChild(makeEl("dd", "", value));
}

function candidatePartyCode(candidate, group) {
  if (group && group !== "oth") return PARTY_LABELS[group] || group.toUpperCase().slice(0, 3);
  const code = String(candidate.partyCode || "").trim().toUpperCase();
  if (code) return code.slice(0, 3);
  if (String(candidate.party || "").trim()) return "OTH";
  return "IND";
}

function makeEl(tag, className = "", text = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null) el.textContent = text;
  return el;
}
