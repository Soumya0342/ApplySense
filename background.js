// ApplySense background script.

// Constants.
const DB_NAME = "applysense_db";
const DB_VERSION = 1;

const STORE_APPLICATIONS = "applications";
const STORE_EVENTS = "events";

const EMBEDDING_MODEL = "text-embedding-3-small";
const SIMILARITY_THRESHOLD = 0.85;
const MAX_VIEW_COMPARISONS = 25;
const EMBEDDING_PROXY_URL = "https://applysense-proxy.soumyachatterjee033.workers.dev/";

// IndexedDB setup.
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_APPLICATIONS)) {
        const store = db.createObjectStore(STORE_APPLICATIONS, { keyPath: "id" });
        store.createIndex("company_normalized", "company_normalized", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        db.createObjectStore(STORE_EVENTS, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Helpers.
function generateUUID() {
  return crypto.randomUUID();
}

function normalizeCompanyName(raw) {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/\b(ltd|limited|pvt|private|inc|llc|corp)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function hashText(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Storage.
async function getApplicationsByCompany(company) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_APPLICATIONS, "readonly");
    const index = tx.objectStore(STORE_APPLICATIONS).index("company_normalized");
    const req = index.getAll(company);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ---- Recent Applications (for ⓘ panel) ----
async function getRecentApplicationsByCompany(company, limit = 3) {
  const apps = await getApplicationsByCompany(company);

  // newest first
  apps.sort((a, b) => (b.applied_at || 0) - (a.applied_at || 0));

  return apps.slice(0, limit).map((a) => {

    return {
      id: a.id,
      job_title: a.job_title || "",
      applied_at: a.applied_at || null,
    };
  });
}


async function updateApplication(app) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_APPLICATIONS, "readwrite");
    tx.objectStore(STORE_APPLICATIONS).put(app);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// Embeddings.
async function getEmbedding(text) {
  const response = await fetch(EMBEDDING_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error("Embedding request failed");
  }

  const data = await response.json();
  return data.data[0].embedding;
}

// Similarity.
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    return 0;
  }
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// Decision engine.
async function checkDuplicate(payload, opts = { persistEmbeddings: false }) {
  const { company_raw, job_title, jd_text } = payload;

  const company = normalizeCompanyName(company_raw);
  if (!company || !jd_text) return { status: "NEW_JOB" };

  const apps = await getApplicationsByCompany(company);
  if (apps.length === 0) return { status: "NEW_JOB" };

  const currentHash = await hashText(jd_text);

  for (const app of apps) {
    if (app.jd_hash === currentHash) {
      return {
        status: "EXACT_DUPLICATE",
        previous_application_id: app.id,
        previous_job_title: app.job_title,
        applied_at: app.applied_at,
      };
    }
  }

  // Semantic similarity handled in view checks.
  return { status: "NEW_JOB" };

  let currentEmbedding;
  try {
    currentEmbedding = await getEmbedding(jd_text);
  } catch {
    return { status: "NEW_JOB" };
  }

  for (const app of apps) {
    let storedEmbedding = app.jd_embedding;

    if (!storedEmbedding && app.jd_text) {
      try {
        storedEmbedding = await getEmbedding(app.jd_text);

        // Do not persist during view checks.
        if (opts.persistEmbeddings) {
          app.jd_embedding = storedEmbedding;
          await updateApplication(app);
        }
      } catch {
        continue;
      }
    }

    const similarity = cosineSimilarity(currentEmbedding, storedEmbedding);

    // 🔍 DEBUG: semantic similarity score
    console.log("[ApplySense][SIMILARITY CHECK]", {
      company: company,
      current_job: job_title,
      previous_job: app.job_title,
      similarity: Number(similarity.toFixed(4)),
      threshold: SIMILARITY_THRESHOLD
    });

    if (similarity >= SIMILARITY_THRESHOLD) {
      return {
        status: "SIMILAR_JD",
        previous_application_id: app.id,
        previous_job_title: app.job_title,
        applied_at: app.applied_at,
      };
    }
  }

  return { status: "NEW_JOB" };
}


// Apply logging.
async function handleApplyLogging(payload, verdict) {
  const { company_raw, job_title, jd_text, job_url } = payload;

  const company_normalized = normalizeCompanyName(company_raw);
  const jd_hash = await hashText(jd_text);
  const applied_at = Date.now();

    // EXACT DUPLICATE → reapply event only (linked to original application)
    if (verdict.status === "EXACT_DUPLICATE") {
    await logEvent("reapply", {
        application_id: verdict.previous_application_id,
    });
    return;
    }

  // NEW_JOB or SIMILAR_JD → create application
  const applicationId = generateUUID();
  let jd_embedding = null;
  try {
    jd_embedding = await getEmbedding(jd_text);
  } catch {
    jd_embedding = null;
  }
  const app = {
    id: applicationId,
    company_raw,
    company_normalized,
    job_title,
    jd_text,
    jd_hash,
    applied_at,
    job_url,
    jd_embedding,
  };

  await updateApplication(app);
  await logEvent("apply", { application_id: applicationId });
}

// Event logging.
async function logEvent(type, meta) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_EVENTS, "readwrite");
    tx.objectStore(STORE_EVENTS).add({
      id: generateUUID(),
      event_type: type,
      timestamp: Date.now(),
      ...meta,
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// Message router.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    let responded = false;
    const safeSend = (payload) => {
      if (responded) return;
      responded = true;
      sendResponse(payload);
    };
    try {
      // 1️⃣ Duplicate check on job view
      if (message.type === "CHECK_DUPLICATE") {
        const result = await checkDuplicate(message.payload, { persistEmbeddings: false });
        safeSend({ success: true, data: result });
        return;
      } else if (message.type === "CHECK_SIMILARITY_VIEW") {
        console.log("[ApplySense][DEBUG] CHECK_SIMILARITY_VIEW received", message.payload);

        const { jobData } = message.payload;
        const { company_raw, jd_text, job_title } = jobData;

        const company = normalizeCompanyName(company_raw);
        if (!company || !jd_text || jd_text.length < 100) {
          safeSend({ success: true, data: { hasSimilar: false } });
          console.log("[ApplySense][DEBUG] similarity skipped: invalid JD", {
            company,
            jd_len: jd_text?.length
          });
          return;
        }

        // Fetch previously applied jobs at same company.
        const applications = await getApplicationsByCompany(company);

        if (!applications || applications.length === 0) {
          safeSend({ success: true, data: { hasSimilar: false } });
          return;
        }

        // Limit comparisons on view to reduce API calls.
        applications.sort((a, b) => (b.applied_at || 0) - (a.applied_at || 0));
        const candidates = applications.slice(0, MAX_VIEW_COMPARISONS);

        // Get embedding for current JD.
        let currentEmbedding;
        try {
          currentEmbedding = await getEmbedding(jd_text);
          console.log("[ApplySense][DEBUG] current JD embedding generated", {
            length: currentEmbedding?.length,
            job_title,
            company
          });
        } catch (e) {
          safeSend({ success: true, data: { hasSimilar: false } });
          return;
        }

        let bestMatch = null;
        let bestScore = 0;

        for (const app of candidates) {
          let emb = app.jd_embedding;

          if (!emb) continue;

          console.log("[ApplySense][DEBUG] comparing against previous application", {
            previous_job_title: app.job_title,
            has_jd_embedding: !!app.jd_embedding,
            has_jd_text: !!app.jd_text
          });
          const score = cosineSimilarity(currentEmbedding, emb);

          if (score > bestScore) {
            bestScore = score;
            bestMatch = app;
          }
        }
        console.log("[ApplySense][VIEW_SIMILARITY_TOP]", {
          company,
          current_job: job_title,
          compared_against: candidates.length,
          best_match_title: bestMatch?.job_title || null,
          best_score: Number(bestScore.toFixed(4)),
          best_score_pct: Math.round(bestScore * 100)
        });

        if (!bestMatch || bestScore < 0.8) {
          safeSend({ success: true, data: { hasSimilar: false } });
          return;
        }

        let similarityLevel = "Low";
        if (bestScore >= 0.85) similarityLevel = "High";
        else if (bestScore >= 0.8) similarityLevel = "Medium";

        safeSend({
          success: true,
          data: {
            hasSimilar: true,
            mostSimilar: {
              job_title: bestMatch.job_title,
              applied_at: bestMatch.applied_at,
              similarityScore: Math.round(bestScore * 100),
              similarityLevel,
            },
          },
        });

        return true;
      }

      // 1️⃣b Recent applications for ⓘ panel (company-scoped)
      if (message.type === "GET_RECENT_APPS") {
        const company_raw = message.payload?.company_raw || "";
        const company = normalizeCompanyName(company_raw);

        if (!company) {
          safeSend({ success: true, data: [] });
          return;
        }

        const recentRaw = await getRecentApplicationsByCompany(company, 2);

        // Sanitize response at API boundary.
        const recent = recentRaw.map(app => ({
          job_title: app.job_title,
          applied_at: app.applied_at
        }));

        safeSend({ success: true, data: recent });
        return;
      }

      // 2️⃣ Apply intent logging (revalidated)
      if (message.type === "APPLY_CLICKED") {
        const payload = message.payload;

        if (!payload || !payload.company_raw || !payload.jd_text) {
          console.warn("ApplySense: APPLY_CLICKED received without valid payload. Ignoring.");
          safeSend({ success: false });
          return;
        }

        const verdict = await checkDuplicate(payload, { persistEmbeddings: true });

        await handleApplyLogging(payload, verdict);

        safeSend({ success: true });
        return;
      }

      // 3️⃣ Fallback
      safeSend({ success: false, error: "UNKNOWN_MESSAGE_TYPE" });
    } catch (err) {
      console.error("ApplySense error:", err);
      safeSend({ success: false, error: err.message });
    }
  })();

  return true;
});


console.log("ApplySense background service worker loaded (Step 3)");
