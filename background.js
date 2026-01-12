// =====================================
// ApplySense Background Script
// Step 3: AI Embeddings + Similar JD
// =====================================

// ---- Constants ----
const DB_NAME = "applysense_db";
const DB_VERSION = 1;

const STORE_APPLICATIONS = "applications";
const STORE_EVENTS = "events";

const EMBEDDING_MODEL = "text-embedding-3-small";
const SIMILARITY_THRESHOLD = 0.85;

// ---- IndexedDB Initialization ----
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

// ---- Helpers ----
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

// ---- Storage ----
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
    const text = (a.jd_text || "").replace(/\s+/g, " ").trim();

    // Simple local “2–3 line” summary (no AI): first ~240 chars
    const summary = text.length > 240 ? text.slice(0, 240).trim() + "…" : text;

    return {
      id: a.id,
      job_title: a.job_title || "",
      applied_at: a.applied_at || null,
      jd_summary: summary,
      job_url: a.job_url || "",
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

// ---- OpenAI ----
function getOpenAIKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get("OPENAI_API_KEY", (res) => {
      resolve(res.OPENAI_API_KEY || null);
    });
  });
}

async function getEmbedding(text) {
  const apiKey = await getOpenAIKey();
  if (!apiKey) throw new Error("Missing OpenAI API key");

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
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

// ---- Similarity ----
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---- Decision Engine ----
// ---- Decision Engine ----
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

  let currentEmbedding;
  try {
    currentEmbedding = await getEmbedding(jd_text);
  } catch {
    return { status: "NEW_JOB" };
  }

  for (const app of apps) {
    let storedEmbedding = app.jd_embedding;

    if (!storedEmbedding) {
      try {
        storedEmbedding = await getEmbedding(app.jd_text);

        // IMPORTANT: do not write during VIEW checks
        if (opts.persistEmbeddings) {
          app.jd_embedding = storedEmbedding;
          await updateApplication(app);
        }
      } catch {
        continue;
      }
    }

    const similarity = cosineSimilarity(currentEmbedding, storedEmbedding);

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


// ---- Apply Logging ----
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

  const app = {
    id: applicationId,
    company_raw,
    company_normalized,
    job_title,
    jd_text,
    jd_hash,
    applied_at,
    job_url,
    linked_application_id:
        verdict.status === "SIMILAR_JD"
            ? verdict.previous_application_id
            : null,
  };

  await updateApplication(app);
  await logEvent("apply", { application_id: applicationId });
}

// ---- Event Logger ----
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

// ---- Message Router ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // 1️⃣ Duplicate check on job view
      if (message.type === "CHECK_DUPLICATE") {
        const result = await checkDuplicate(message.payload, { persistEmbeddings: false });
        sendResponse({ success: true, data: result });
        return;
      }
      
      // 1️⃣b Recent applications for ⓘ panel (company-scoped)
      if (message.type === "GET_RECENT_APPS") {
        const company_raw = message.payload?.company_raw || "";
        const company = normalizeCompanyName(company_raw);

        if (!company) {
          sendResponse({ success: true, data: [] });
          return;
        }

        const limit = Number(message.payload?.limit || 3);
        const recent = await getRecentApplicationsByCompany(company, limit);

        sendResponse({ success: true, data: recent });
        return;
      }

      // 2️⃣ Apply intent logging (revalidated)
      if (message.type === "APPLY_CLICKED") {
        const payload = message.payload;

        if (!payload || !payload.company_raw || !payload.jd_text) {
            console.warn("ApplySense: APPLY_CLICKED received without valid payload. Ignoring.");
            sendResponse({ success: false });
            return;
        }

        const verdict = await checkDuplicate(payload, { persistEmbeddings: true });

        await handleApplyLogging(payload, verdict);

        sendResponse({ success: true });
        return;
      }


      // 3️⃣ Fallback
      sendResponse({ success: false, error: "UNKNOWN_MESSAGE_TYPE" });
    } catch (err) {
      console.error("ApplySense error:", err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});


console.log("ApplySense background service worker loaded (Step 3)");
