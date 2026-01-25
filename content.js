console.log("ApplySense LOCAL DEV version loaded", Date.now());
// ApplySense content script.

console.log("ApplySense content script loaded (Step 4)");

// Apply intent detection.

let applyIntentFiredForJobKey = "";
let lastExtractedJobData = null;
let lastProcessedJobSignature = "";
let waitingSimilarity = false;
let pendingStatusText = null;
let pendingUiTimer = null;

const STATUS_TEXT = {
  checking: "\u23F3 Checking job...",
  newJob: "\u2705 New job",
  similar: "\u26A0\uFE0F Similar to a job you applied earlier",
  duplicate: "\u26D4 Already applied",
};

function getStatusText(status, hasSimilar) {
  if (status === "EXACT_DUPLICATE") return STATUS_TEXT.duplicate;
  if (hasSimilar) return STATUS_TEXT.similar;
  if (status === "NEW_JOB") return STATUS_TEXT.newJob;
  return STATUS_TEXT.newJob;
}

function getStatusKind() {
  const lastStatus = window.__applySenseLastVerdict?.status;
  if (lastStatus === "EXACT_DUPLICATE") return "duplicate";
  if (window.__applySenseViewSimilarity?.hasSimilar) return "similar";
  if (lastStatus === "NEW_JOB") return "new";
  return "checking";
}

function getPanelBackground(statusKind) {
  if (statusKind === "duplicate") return "#fef2f2"; // light red
  if (statusKind === "similar") return "#fff7ed"; // light amber
  if (statusKind === "new") return "#ecfdf3"; // light green
  return "#ffffff";
}

// UI helpers.

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
  const btn = findRealApplyButton();
  if (!btn) return;

  if (btn.dataset.applysenseBound === "1") return;
  btn.dataset.applysenseBound = "1";

  btn.addEventListener("click", () => {
    const currentJobKey = getCurrentJobIdFromUrl() || window.location.href;
    if (!currentJobKey) return;
    if (applyIntentFiredForJobKey === currentJobKey) return;
    applyIntentFiredForJobKey = currentJobKey;

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

// Helpers.
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function buildJobSignature(jobData) {
  if (!jobData) return "";
  return [
    jobData.company_raw,
    jobData.job_title,
    jobData.jd_text?.length || 0
  ].join("::");
}

// Extract current job id from URL.
function getCurrentJobIdFromUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.get("currentJobId") || "";
}

// Return the first matching element.
function firstEl(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// Return the first element whose text content is non-empty.
function firstElWithText(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (cleanText(el.innerText)) return el;
  }
  return null;
}

// Get job description text.
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

  const companyEl = firstElWithText([
    'a[href*="/company/"]',
    '[data-test-company-name] a',
    '[data-test-company-name]',
    'a[data-tracking-control-name="public_jobs_topcard-org-name"]',
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
  ]);

  const jdEl =
    document.querySelector('[data-testid="expandable-text-box"]') ||
    document.querySelector('[data-test-job-description]') ||
    document.querySelector('.show-more-less-html__markup') ||
    document.querySelector('.jobs-description-content__text') ||
    document.querySelector('.jobs-box__html-content');

  const job_title = cleanText(titleEl?.innerText || (document.title || "").split("|")[0]);
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



function sendDuplicateCheck(jobData, jobSignature) {
  chrome.runtime.sendMessage(
    { type: "CHECK_DUPLICATE", payload: jobData },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error(
          "ApplySense message error:",
          chrome.runtime.lastError.message
        );
        return;
      }

      if (jobSignature !== lastProcessedJobSignature) return;

      console.log("ApplySense duplicate check result:", response);

      const status = response?.data?.status;
      const statusText = getStatusText(status, window.__applySenseViewSimilarity?.hasSimilar);

      // Save last verdict for info panel usage later
      window.__applySenseLastVerdict = response?.data || null;

      if (waitingSimilarity) {
        pendingStatusText = statusText;
        if (pendingUiTimer) clearTimeout(pendingUiTimer);
        pendingUiTimer = setTimeout(() => {
          if (!waitingSimilarity && pendingStatusText) return;
          ensureApplySenseFloatingUI(pendingStatusText || STATUS_TEXT.checking);
        }, 1200);
      } else {
        ensureApplySenseFloatingUI(statusText);
      }
    }
  );
}

function sendViewSimilarityCheck(jobData, jobSignature) {
  console.log("[ApplySense][DEBUG] sending CHECK_SIMILARITY_VIEW", {
    company: jobData.company_raw,
    title: jobData.job_title,
    jd_len: jobData.jd_text?.length
  });
  waitingSimilarity = true;
  chrome.runtime.sendMessage(
    { type: "CHECK_SIMILARITY_VIEW", payload: { jobData } },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("ApplySense similarity error:", chrome.runtime.lastError.message);
        waitingSimilarity = false;
        if (pendingUiTimer) clearTimeout(pendingUiTimer);
        if (pendingStatusText) ensureApplySenseFloatingUI(pendingStatusText);
        return;
      }
      if (jobSignature !== lastProcessedJobSignature) return;
      console.log("[ApplySense] view similarity result:", response);
      window.__applySenseViewSimilarity = response?.data || null;

      // Re-render status now that similarity data is available
      const lastStatus = window.__applySenseLastVerdict?.status;
      waitingSimilarity = false;
      if (pendingUiTimer) clearTimeout(pendingUiTimer);
      const statusText = getStatusText(lastStatus, window.__applySenseViewSimilarity?.hasSimilar);
      ensureApplySenseFloatingUI(statusText);
    }
  );
}


// Main runner with retries while LinkedIn renders async.
let lastSeenJobKey = "";
let isProcessingJob = false;
let runOnceTimer = null;

function scheduleRunOnce(delayMs = 200) {
  if (runOnceTimer) clearTimeout(runOnceTimer);
  runOnceTimer = setTimeout(() => {
    runOnceTimer = null;
    runOnce();
  }, delayMs);
}

async function runOnce() {
  console.log("[ApplySense] runOnce triggered");
  const key = [
    window.location.href,
    document.title
  ].join("::");

  if (isProcessingJob) return;
  isProcessingJob = true;

  try {
    if (key && key === lastSeenJobKey) return;

    applyIntentFiredForJobKey = "";

    const start = Date.now();

    while (Date.now() - start < 8000) {
      const jobData = extractJobData();

      if (jobData && jobData._complete) {
        const jobSignature = buildJobSignature(jobData);
        console.log("[ApplySense] job signature computed:", {
          company: jobData.company_raw,
          title: jobData.job_title,
          jdLength: jobData.jd_text.length,
          signature: jobSignature
        });

        if (jobSignature === lastProcessedJobSignature) {
          console.log("[ApplySense] same job detected, skipping reprocessing");
          return;
        }

        lastProcessedJobSignature = jobSignature;
        console.log("[ApplySense] new job accepted for processing");
        lastSeenJobKey = key || jobData.job_url;

        console.log("ApplySense extracted job data:", {
          job_title: jobData.job_title,
          company_raw: jobData.company_raw,
          jd_chars: jobData.jd_text.length,
          currentJobId: jobData.currentJobId,
        });

        lastExtractedJobData = jobData;
        window.__applySenseLastExtractedJobData = jobData;

        console.log("ApplySense DEBUG lastExtractedJobData set:", {
          company: jobData.company_raw,
          jd_chars: jobData.jd_text.length,
        });

        attachApplyClickListenerForCurrentJob();

        // Reset ℹ️ panel on job change
        const existingUI = document.getElementById("applysense-floating-ui");
        if (existingUI) {
          const infoPanel = existingUI.querySelector("#as-info-panel");
          if (infoPanel) {
            infoPanel.style.display = "none";
            infoPanel.innerHTML = "";
          }
        }

        sendViewSimilarityCheck(jobData, jobSignature);
        sendDuplicateCheck(jobData, jobSignature);
        return;
      }

      await sleep(400);
    }

    if (key !== lastSeenJobKey) {
      console.warn("ApplySense: could not extract job data yet (will wait for next change).");
    }
  } finally {
    // ✅ Always unlock, even when we return early
    isProcessingJob = false;
  }
}



// Detect job changes in SPA.
function startObservers() {
  // Observe DOM changes in the right panel area.
  const target = document.querySelector("#main") || document.body;

  const mo = new MutationObserver(() => {
    scheduleRunOnce();
  });

  mo.observe(target, {
    subtree: true,
    childList: true,
    characterData: false,
  });

  // Detect URL changes (LinkedIn updates query params without reload).
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleRunOnce();
    }
  }, 500);

  // Initial run.
  scheduleRunOnce(0);
}

startObservers();

// Global apply intent capture (failsafe).

document.addEventListener(
  "click",
  (e) => {
    const el = e.target?.closest("button, a");
    if (!el) return;

    const text = (el.innerText || "").toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();

    const isApply =
      text === "apply" ||
      text === "easy apply" ||
      text.includes("apply") ||
      aria.includes("apply");

    if (!isApply) return;

    const jobKey = getCurrentJobIdFromUrl() || window.location.href;

    if (applyIntentFiredForJobKey === jobKey) return;
    applyIntentFiredForJobKey = jobKey;

    console.log("ApplySense: GLOBAL APPLY CLICK");

    if (!lastExtractedJobData || !lastExtractedJobData.company_raw || !lastExtractedJobData.jd_text) {
      console.warn("ApplySense: Apply clicked but job data not ready");
      return;
    }

    chrome.runtime.sendMessage({
      type: "APPLY_CLICKED",
      payload: lastExtractedJobData,
    });
  },
  true // capture phase is required
);


function ensureApplySenseFloatingUI(statusText = "Checking job…") {
  // If UI already exists, update status text and return.
  const existing = document.getElementById("applysense-floating-ui");
  if (existing) {
    const statusEl = existing.querySelector("#as-status");
    if (statusEl) statusEl.textContent = statusText;
    existing.style.background = getPanelBackground(getStatusKind());
    return existing;
  }

  const panel = document.createElement("div");
  panel.id = "applysense-floating-ui";

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <strong style="font-size:14px;">ApplySense</strong>

      <div style="display:flex;gap:8px;align-items:center;">
        <button id="as-info-btn"
          style="border:1px solid #cbd5e1;background:transparent;font-size:12px;cursor:pointer;
                 border-radius:999px;width:20px;height:20px;display:inline-flex;
                 align-items:center;justify-content:center;color:#475569;"
          title="View details">i</button>

        <button id="as-close-btn"
          style="border:none;background:none;font-size:16px;cursor:pointer;">×</button>
      </div>
    </div>

    <div id="as-status"
      style="margin-top:8px;font-size:13px;line-height:1.4;">
      ${statusText}
    </div>

    <div id="as-info-panel"
      style="display:none;margin-top:8px;font-size:12px;
            border-top:1px solid #eee;padding-top:8px;">
    </div>
  `;

  Object.assign(panel.style, {
    position: "fixed",
    top: "96px",
    right: "16px",
    width: "300px",
    padding: "12px",
    background: getPanelBackground(getStatusKind()),
    borderRadius: "12px",
    border: "1px solid #e5e7eb",
    boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
    zIndex: "999999",
    fontFamily: "system-ui"
  });

  // Close button.
  panel.querySelector("#as-close-btn").onclick = () => panel.remove();

  const infoBtn = panel.querySelector("#as-info-btn");
  const setInfoBtnOpen = (isOpen) => {
    infoBtn.style.background = isOpen ? "#e2e8f0" : "transparent";
    infoBtn.style.borderColor = isOpen ? "#94a3b8" : "#cbd5e1";
    infoBtn.style.color = isOpen ? "#0f172a" : "#475569";
  };

  // ℹ️ button logic — Step 3 core
  infoBtn.onclick = () => {
    const infoPanel = panel.querySelector("#as-info-panel");

    // Toggle visibility.
    if (infoPanel.style.display === "block") {
      infoPanel.style.display = "none";
      setInfoBtnOpen(false);
      return;
    }
    setInfoBtnOpen(true);

    // Read last verdict.
    const verdict = window.__applySenseLastVerdict;

    if (!verdict) {
      infoPanel.innerHTML = "No application history available.";
      infoPanel.style.display = "block";
      return;
    }

    let html = "";

    const similarity = window.__applySenseViewSimilarity;

    if (verdict.status === "EXACT_DUPLICATE") {
      html += `<strong>\u26D4 Already applied</strong><br/>`;
    } 
    else if (similarity?.hasSimilar && similarity.mostSimilar) {
      html += `<strong>\u26A0\uFE0F Similar to a job you applied earlier</strong><br/>`;

      html += `<div style="margin-top:6px;">
        <strong>Most similar to:</strong><br/>
        ${similarity.mostSimilar.job_title}
      </div>`;

      html += `<div style="margin-top:4px;">
        <strong>Applied on:</strong><br/>
        ${new Date(similarity.mostSimilar.applied_at).toLocaleString()}
      </div>`;

      html += `<div style="margin-top:4px;">
        <strong>Similarity:</strong><br/>
        ${similarity.mostSimilar.similarityLevel} (${similarity.mostSimilar.similarityScore}%)
      </div>`;
    } 
    else {
      html += `<strong>\u2705 New job</strong><br/>`;
    }

    if (verdict.previous_job_title) {
      html += `<div style="margin-top:4px;">
        <strong>Previous title:</strong><br/>
        ${verdict.previous_job_title}
      </div>`;
    }

    if (verdict.applied_at) {
      html += `<div style="margin-top:4px;">
        <strong>Applied on:</strong><br/>
        ${new Date(verdict.applied_at).toLocaleString()}
      </div>`;
    }

    infoPanel.innerHTML = html;
    // Recent applications (lazy loaded).
    infoPanel.innerHTML += `<div style="margin-top:8px;"><em>Loading recent applications…</em></div>`;

    chrome.runtime.sendMessage(
      {
        type: "GET_RECENT_APPS",
        payload: {
          company_raw: window.__applySenseLastExtractedJobData?.company_raw
        }
      },
      (response) => {
        if (!response || !response.success) {
          infoPanel.innerHTML += `<div style="margin-top:6px;">Failed to load recent applications.</div>`;
          return;
        }

        const apps = response.data || [];

        if (apps.length === 0) {
          infoPanel.innerHTML += `<div style="margin-top:6px;">No recent applications found.</div>`;
          return;
        }

        let listHtml = `<div style="margin-top:8px;"><strong>Recent applications at ${window.__applySenseLastExtractedJobData?.company_raw || "this company"}</strong></div><ul style="margin:4px 0 0 16px;">`;

        for (const app of apps) {
          listHtml += `<li style="margin-bottom:4px;">
            ${app.job_title}<br/>
            <span style="font-size:11px;color:#666;">
              ${new Date(app.applied_at).toLocaleString()}
            </span>
          </li>`;
        }

        listHtml += `</ul>`;
        infoPanel.innerHTML += listHtml;
      }
    );

    infoPanel.style.display = "block";
      };

      document.body.appendChild(panel);
      return panel;
}


