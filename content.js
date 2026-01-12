// =====================================
// ApplySense Content Script
// Step 4: LinkedIn Job Extraction (Robust)
// =====================================

console.log("ApplySense content script loaded (Step 4)");

// =====================================
// ApplySense Step 1: Apply Intent Detection
// =====================================

let applyIntentFiredForJobKey = "";
let lastExtractedJobData = null;

// Normalize helper
function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// ===============================
// ApplySense UI helpers
// ===============================

function findApplyButtonContainer() {
  // Find Apply / Easy Apply anchor by text
  const applyEl = [...document.querySelectorAll("a, button")].find(el => {
    const text = el.innerText?.trim().toLowerCase();
    return text === "apply" || text === "easy apply";
  });

  if (!applyEl) return null;

  // Walk up to a reasonable container (LinkedIn job action bar)
  let parent = applyEl.parentElement;
  for (let i = 0; i < 5 && parent; i++) {
    // Stop at first block-level container
    if (parent.tagName === "DIV") {
      return parent;
    }
    parent = parent.parentElement;
  }

  return applyEl.parentElement;
}

function ensureApplySenseUI() {
  // 1. Find the job title <p> (the one containing the job title link)
  const titleRow = document.querySelector(
    'p.c60ffaab._366d02d6'
  );

  if (!titleRow) return null;

  // 2. Avoid duplicate insertion
  let container = document.querySelector('#applysense-ui');
  if (container) return container;

  // 3. Create UI container
  container = document.createElement('div');
  container.id = 'applysense-ui';

  // 4. Native LinkedIn-like spacing
  container.style.display = 'none';
  container.style.marginTop = '8px';
  container.style.marginBottom = '8px';
  container.style.maxWidth = '520px';

  // 5. Insert right after the title row
  titleRow.insertAdjacentElement('afterend', container);

  return container;
}

function findRealApplyButton() {
  const selectors = [
    'button.jobs-apply-button',
    'button[aria-label^="Easy Apply"]',
    'button[aria-label^="Apply"]',
    'a[aria-label^="Easy Apply"]',
    'a[aria-label^="Apply"]',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

function attachApplyClickListenerForCurrentJob() {
  const jobKey = getCurrentJobIdFromUrl() || window.location.href;
  if (!jobKey) return;

  const btn = findRealApplyButton();
  if (!btn) return;

  if (btn.dataset.applysenseBound === "1") return;
  btn.dataset.applysenseBound = "1";

  btn.addEventListener("click", () => {
    if (applyIntentFiredForJobKey === jobKey) return;
    applyIntentFiredForJobKey = jobKey;

    console.log("ApplySense: REAL APPLY CLICK");

    if (!lastExtractedJobData || !lastExtractedJobData.company_raw || !lastExtractedJobData.jd_text) {
      console.warn("ApplySense: Apply clicked before job data ready");
      return;
    }

    chrome.runtime.sendMessage({
      type: "APPLY_CLICKED",
      payload: lastExtractedJobData,
    });
  });
}

function renderApplySenseStatus(status) {
  const ui = ensureApplySenseUI();
  if (!ui) return;

  // Build shell once
  if (!ui.dataset.applysenseShellBuilt) {
    ui.dataset.applysenseShellBuilt = "1";

    ui.style.display = "block";
    ui.style.padding = "10px 12px";
    ui.style.borderRadius = "6px";
    ui.style.fontSize = "14px";
    ui.style.fontWeight = "600";
    ui.style.marginBottom = "8px";

    // Header row (status + info button)
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "10px";

    const statusEl = document.createElement("div");
    statusEl.id = "applysense-status-text";
    statusEl.style.flex = "1";

    const infoBtn = document.createElement("button");
    infoBtn.id = "applysense-info-btn";
    infoBtn.type = "button";
    infoBtn.textContent = "i";
    infoBtn.title = "Recent applications";
    infoBtn.style.cursor = "pointer";
    infoBtn.style.border = "1px solid #c7c9cc";
    infoBtn.style.background = "#ffffff";
    infoBtn.style.borderRadius = "50%";
    infoBtn.style.width = "22px";
    infoBtn.style.height = "22px";
    infoBtn.style.display = "inline-flex";
    infoBtn.style.alignItems = "center";
    infoBtn.style.justifyContent = "center";
    infoBtn.style.fontSize = "13px";
    infoBtn.style.fontWeight = "600";
    infoBtn.style.color = "#5f6368";
    infoBtn.style.lineHeight = "1";
    infoBtn.style.padding = "0";

    // Popup panel (hidden by default)
    const panel = document.createElement("div");
    panel.id = "applysense-info-panel";
    panel.style.display = "none";
    panel.style.marginTop = "10px";
    panel.style.paddingTop = "10px";
    panel.style.borderTop = "1px solid rgba(0,0,0,0.08)";
    panel.style.fontSize = "12px";
    panel.style.fontWeight = "500";
    panel.style.color = "#202124";

    header.appendChild(statusEl);
    header.appendChild(infoBtn);
    ui.appendChild(header);
    ui.appendChild(panel);

    const formatDateTime = (ms) => {
      if (!ms) return "Unknown time";
      try {
        return new Date(ms).toLocaleString();
      } catch {
        return "Unknown time";
      }
    };

    const escapeHtml = (s) =>
      (s || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    const renderPanel = (items) => {
      if (!items || items.length === 0) {
        panel.innerHTML = `<div>No past applications found for this company.</div>`;
        return;
      }

      panel.innerHTML = items
        .map((it) => {
          const title = escapeHtml(it.job_title || "(No title)");
          const time = escapeHtml(formatDateTime(it.applied_at));
          const sum = escapeHtml(it.jd_summary || "");
          const url = it.job_url || "";
          const link = url
            ? `<a href="${escapeHtml(url)}" target="_blank" style="text-decoration: underline; color: inherit;">Open</a>`
            : "";

          return `
            <div style="padding:8px 0;">
              <div style="display:flex; justify-content:space-between; gap:10px;">
                <div style="font-weight:700;">${title}</div>
                <div style="opacity:0.75; white-space:nowrap;">${time}</div>
              </div>
              <div style="opacity:0.85; margin-top:4px;">${sum}</div>
              ${link ? `<div style="margin-top:4px; opacity:0.85;">${link}</div>` : ""}
            </div>
          `;
        })
        .join(`<div style="border-top:1px solid rgba(0,0,0,0.06)"></div>`);
    };

    infoBtn.addEventListener("click", () => {
      const isOpen = panel.style.display === "block";

      // Toggle close
      if (isOpen) {
        panel.style.display = "none";
        return;
      }

      // Open + fetch
      panel.style.display = "block";

      const company_raw = lastExtractedJobData?.company_raw || "";
      if (!company_raw) {
        panel.innerHTML = `<div>Company not detected yet.</div>`;
        return;
      }

      panel.innerHTML = `<div>Loading…</div>`;

      chrome.runtime.sendMessage(
        { type: "GET_RECENT_APPS", payload: { company_raw, limit: 3 } },
        (resp) => {
          if (chrome.runtime.lastError) {
            panel.innerHTML = `<div>Could not load recent applications.</div>`;
            return;
          }
          const items = resp?.success ? resp.data : [];
          renderPanel(items);
        }
      );
    });
  }

  // Update status text + colors without destroying the shell
  const statusEl = ui.querySelector("#applysense-status-text");
  if (!statusEl) return;

  if (status === "NEW_JOB" || status === "NEW") {
    ui.style.background = "#e6f4ea";
    ui.style.border = "1px solid #1e8e3e";
    ui.style.color = "#1e8e3e";
    statusEl.textContent = "✅ New job. You haven’t applied to this company yet.";
  } else if (status === "SIMILAR_JD") {
    ui.style.background = "#fff4e5";
    ui.style.border = "1px solid #f29900";
    ui.style.color = "#b26a00";
    statusEl.textContent = "⚠️ Similar role found. You’ve applied to a similar job at this company.";
  } else if (status === "EXACT_DUPLICATE") {
    ui.style.background = "#fdecea";
    ui.style.border = "1px solid #d93025";
    ui.style.color = "#a50e0e";
    statusEl.textContent = "🚫 Exact duplicate. You’ve already applied to this job.";
  } else {
    ui.style.background = "#f1f3f4";
    ui.style.border = "1px solid #dadce0";
    ui.style.color = "#5f6368";
    statusEl.textContent = "ℹ️ Job status unknown.";
  }
}

// Determine if a node represents an Apply action
function isApplyLikeNode(node) {
  if (!node) return false;

  const text = normalizeText(node.innerText);
  const aria = normalizeText(node.getAttribute?.("aria-label"));

  if (text === "apply" || text.includes("easy apply")) return true;
  if (aria.includes("apply")) return true;

  return false;
}

// Global capture-phase listener



// ------- Helpers -------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Extract current job id from URL (works for search-results layout)
function getCurrentJobIdFromUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.get("currentJobId") || "";
}

// Try multiple selectors and return the first element that exists
function firstEl(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// Get JD text from the right panel (LinkedIn often uses show-more-less markup)
function extractJobDescriptionText() {
  const candidates = [
    '[data-testid="expandable-text-box"]',
    '[data-testid="job-details-description"]',
    '.show-more-less-html__markup',
    '.jobs-description-content__text',
    '.jobs-box__html-content',
  ];

  const el = firstEl(candidates);
  if (!el) return "";

  return cleanText(el.innerText);
}


function extractJobData() {
  const titleEl =
    document.querySelector('[data-test-job-title]') ||
    document.querySelector('h1[data-test-id="job-details-title"]') ||
    document.querySelector('h1');

  const companyEl =
    document.querySelector('a[href*="/company/"]') ||
    document.querySelector('[data-test-company-name] a') ||
    document.querySelector('[data-test-company-name]') ||
    document.querySelector('a[data-tracking-control-name="public_jobs_topcard-org-name"]') ||
    document.querySelector('.job-details-jobs-unified-top-card__company-name a') ||
    document.querySelector('.job-details-jobs-unified-top-card__company-name');

  const jdEl =
    document.querySelector('[data-testid="expandable-text-box"]') ||
    document.querySelector('[data-test-job-description]') ||
    document.querySelector('.show-more-less-html__markup') ||
    document.querySelector('.jobs-description-content__text') ||
    document.querySelector('.jobs-box__html-content');

  const job_title = cleanText((document.title || "").split("|")[0]);
  const company_raw = cleanText(companyEl?.innerText);
  const jd_text = cleanText(jdEl?.innerText);
  const job_url = window.location.href;
  const currentJobId = getCurrentJobIdFromUrl();

  const isComplete =
    Boolean(job_title) &&
    Boolean(company_raw) &&
    jd_text.length >= 100;

  return {
    job_title,
    company_raw,
    jd_text,
    job_url,
    currentJobId,
    _complete: isComplete
  };
}



function sendDuplicateCheck(jobData) {
  chrome.runtime.sendMessage(
    { type: "CHECK_DUPLICATE", payload: jobData },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("ApplySense message error:", chrome.runtime.lastError.message);
        return;
      }
      console.log("ApplySense duplicate check result:", response);

      // 🔗 UI wiring
      if (response && response.success && response.data?.status) {
        renderApplySenseStatus(response.data.status);
      }

    }
  );
}

// ------- Main runner (with retries because LinkedIn renders async) -------
let lastSeenJobKey = "";
let isProcessingJob = false;

async function runOnce() {

    // Make a stable key to avoid re-running on tiny DOM changes
    const currentJobId = getCurrentJobIdFromUrl();
    const key = currentJobId || window.location.href;
    if (isProcessingJob) return;

    if (key && key === lastSeenJobKey) return;
    applyIntentFiredForJobKey = "";
    isProcessingJob = true;

  // Intelligent retry window for LinkedIn SPA hydration
  const start = Date.now();

  while (Date.now() - start < 8000) {
    const jobData = extractJobData();

    if (jobData && jobData._complete) {
      lastSeenJobKey = key || jobData.job_url;
      document.querySelector("#applysense-info-panel")?.style && (document.querySelector("#applysense-info-panel").style.display = "none");
      console.log("ApplySense extracted job data:", {
        job_title: jobData.job_title,
        company_raw: jobData.company_raw,
        jd_chars: jobData.jd_text.length,
        currentJobId: jobData.currentJobId,
      });
      lastExtractedJobData = jobData;
      console.log("ApplySense DEBUG lastExtractedJobData set:", {
        company: jobData.company_raw,
        jd_chars: jobData.jd_text.length,
      });
  
      ensureApplySenseUI();
      attachApplyClickListenerForCurrentJob();

      sendDuplicateCheck(jobData);
      isProcessingJob = false;
      return;
    }

    await sleep(400);
  }

  // If we fail, log once per job key
  if (key !== lastSeenJobKey) {
    console.warn("ApplySense: could not extract job data yet (will wait for next change).");
  }
  isProcessingJob = false;
}


// ------- Detect job changes in SPA -------
function startObservers() {
  // 1) Observe DOM changes in the right panel area
  const target = document.querySelector("#main") || document.body;

  const mo = new MutationObserver(() => {
    runOnce();
  });

  mo.observe(target, {
    subtree: true,
    childList: true,
    characterData: false,
  });

  // 2) Detect URL changes (LinkedIn changes query params without reload)
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      runOnce();
    }
  }, 500);

  // 3) Initial run
  runOnce();
}

startObservers();
