const ECQ_BASE_URL = "https://resultsdata.elections.qld.gov.au";
const PARTY_GROUPS = ["alp", "lnp", "kap", "grn", "onp", "oth"];
const SWING_PARTY_GROUPS = ["alp", "lnp", "kap", "grn", "onp"];

const PARTY_LABELS = {
  alp: "ALP",
  lnp: "LNP",
  kap: "KAP",
  grn: "GRN",
  onp: "ONP",
  oth: "OTH",
};

function partyGroup(code, party) {
  const value = String(code || party || "").trim().toLowerCase();
  if (!value || value === "ind" || value === "independent") return "oth";
  if (value === "lnp" || value.includes("liberal national")) return "lnp";
  if (value === "kap" || value.includes("katter")) return "kap";
  if (value === "the greens" || value.includes("greens")) return "grn";
  if (value === "one nation" || value.includes("one nation")) return "onp";
  if (value === "australian labor party" || value.includes("labor")) return "alp";
  return "oth";
}

function partyClass(group) {
  return `col-party-${group || "oth"}`;
}

function fmt(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(decimals);
}

function fmtPct(value) {
  return fmt(value);
}

function fmtInt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Math.round(Number(value)).toLocaleString("en-AU");
}

function fmtSwing(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${fmt(value)}`;
}

function fmtDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parsePct(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const parsed = parseFloat(String(value).replace("%", ""));
  return Number.isNaN(parsed) ? null : parsed;
}

function endpoint(electionId, suffix) {
  return `${ECQ_BASE_URL}/${electionId}-${suffix}`;
}

function withCacheBust(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}t=${Date.now()}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(options.cacheBust ? withCacheBust(url) : url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function loadConfig() {
  const config = await fetchJson("config.json", { cacheBust: true });
  if (!config.electionId) throw new Error("config.json must define electionId");
  return {
    refreshSeconds: 60,
    electorateMappings: {},
    boothMappings: {},
    ...config,
  };
}

async function loadElectionMetadata(electionId) {
  const data = await fetchJson(`${ECQ_BASE_URL}/elections.json`, { cacheBust: true });
  return data.elections?.find(e => e.stub === electionId) || null;
}

function aggregateCandidates(candidates = []) {
  const groups = {};
  for (const group of PARTY_GROUPS) groups[group] = { votes: 0, pct: null, found: false };

  for (const candidate of candidates) {
    const group = partyGroup(candidate.partyCode, candidate.party);
    const votes = Number(candidate.count ?? candidate.primary ?? 0) || 0;
    groups[group].votes += votes;
    groups[group].found = true;
  }

  const total = Object.values(groups).reduce((sum, group) => sum + group.votes, 0);
  for (const group of PARTY_GROUPS) {
    groups[group].pct = total > 0 && groups[group].found ? (groups[group].votes / total) * 100 : null;
  }
  if (total > 0) {
    groups.oth.pct = (groups.oth.votes / total) * 100;
  }
  return groups;
}

function selectedCandidateRows(indicative) {
  if (!indicative) return [];
  const source = indicative.selectedCandidates?.length ? indicative.selectedCandidates : indicative.candidates;
  return (source || []).map(candidate => ({
    name: candidate.candidateName || candidate.ballotName,
    ballotOrder: candidate.candidateBallotOrder ?? candidate.ballotOrderNumber ?? null,
    party: candidate.party,
    partyCode: candidate.partyCode,
    group: partyGroup(candidate.partyCode, candidate.party),
    votes: Number(candidate.total ?? candidate.count ?? candidate.preferences ?? 0) || 0,
    pct: parsePct(candidate.preferencesPercentage ?? candidate.percentage),
  }));
}

function leaderFromIndicative(indicative) {
  const candidates = selectedCandidateRows(indicative).filter(candidate => candidate.pct !== null);
  if (candidates.length === 0) return { leader: null, runnerUp: null, margin: null };
  candidates.sort((a, b) => b.pct - a.pct);
  const leader = candidates[0];
  const runnerUp = candidates[1] || null;
  return {
    leader,
    runnerUp,
    margin: runnerUp ? leader.pct - runnerUp.pct : null,
  };
}

function getHistoricStub(config, currentStub) {
  return config.electorateMappings?.[currentStub] || currentStub;
}

function getHistoricVenueId(config, electorateStub, currentVenueId) {
  const map = config.boothMappings?.[electorateStub] || {};
  const key = String(currentVenueId);
  return map[key] ?? currentVenueId;
}

function updateSortIndicators(sortState) {
  document.querySelectorAll("thead th[data-sort-key]").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sortKey === sortState.key && sortState.direction) {
      th.classList.add(`sort-${sortState.direction}`);
    }
  });
}

function initSorting(sortState, onSort) {
  document.querySelectorAll("thead th[data-sort-key]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (sortState.key !== key) {
        sortState.key = key;
        sortState.direction = "asc";
      } else if (sortState.direction === "asc") {
        sortState.direction = "desc";
      } else {
        sortState.key = null;
        sortState.direction = null;
      }
      updateSortIndicators(sortState);
      onSort();
    });
  });
}

function getSortedRows(rows, sortState) {
  if (!sortState.key || !sortState.direction) return rows;
  return [...rows].sort((a, b) => {
    const va = a[sortState.key];
    const vb = b[sortState.key];
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    const cmp = typeof va === "string" ? va.localeCompare(vb, "en-AU") : va - vb;
    return sortState.direction === "desc" ? -cmp : cmp;
  });
}

function makeCell(text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function swingCell(value, className = "") {
  const cell = makeCell(fmtSwing(value), `col-num ${className}`.trim());
  if (value === null || value === undefined || Number.isNaN(value) || value === 0) {
    cell.classList.add("swing-zero");
  } else {
    cell.classList.add(value > 0 ? "swing-pos" : "swing-neg");
  }
  return cell;
}

function maxTimestamp(values) {
  const times = values
    .filter(Boolean)
    .map(value => new Date(value).getTime())
    .filter(value => !Number.isNaN(value));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function setElectionLabel(text) {
  const label = document.getElementById("election-label");
  if (label) label.textContent = text || "";
}
