import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, query, orderBy, limit,
  onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Konfigurasi ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyAigrVbxd0TAGgLol6qwB5OK44POzi6fkE",
  authDomain: "tracker-mhs-hnds.firebaseapp.com",
  projectId: "tracker-mhs-hnds",
  storageBucket: "tracker-mhs-hnds.firebasestorage.app",
  messagingSenderId: "706899788955",
  appId: "1:706899788955:web:4802315006b89d1de3323e",
};
const COLLECTION = "detections";
const SAVE_THROTTLE_MS = 5000;   // simpan data maksimal tiap 5 detik
const MIN_CONFIDENCE = 0.6;
const TARGET_CLASSES = ["mouse", "keyboard", "cell phone", "book", "scissors", "laptop", "person", "bottle", "cup"];
const db = getFirestore(initializeApp(firebaseConfig));

/* ---------- DOM & state ---------- */
const $ = (id) => document.getElementById(id);
const video = $("camera"), canvas = $("canvas"), ctx = canvas.getContext("2d");
const btnCamera = $("btn-camera"), btnSwitch = $("btn-switch"), btnAI = $("btn-ai"), btnFlash = $("btn-flash");
let model = null, stream = null;
let isCameraOn = false, isAIDetecting = false, isMockMode = false, torchOn = false;
let facing = "environment";      // kamera belakang di HP; otomatis "user" jika tidak ada (laptop)
let lastSaveTime = 0, lastInfoKey = "";
let unsubscribe = null;

/* ---------- UI helper ---------- */
function showOverlay(text, spinner = true) {
  $("overlay-text").textContent = text;
  document.querySelector(".spinner").classList.toggle("stopped", !spinner);
  $("overlay-msg").classList.remove("hidden");
}
const hideOverlay = () => $("overlay-msg").classList.add("hidden");
let toastTimer;
function showToast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
function setStatus() {
  const el = $("db-status");
  el.textContent = isMockMode ? "DEMO" : "ONLINE";
  el.className = "status-badge" + (isMockMode ? "" : " online");
}
function setRail(btn, on, danger = false) {
  btn.classList.toggle("on", on && !danger);
  btn.classList.toggle("danger", danger);
}
function setInfo(cls, sub, chips = []) {
  const key = cls + sub + chips.join();
  if (key === lastInfoKey) return;       // hindari render ulang tiap frame
  lastInfoKey = key;
  $("info-class").textContent = cls;
  $("info-sub").textContent = sub;
  $("chips").replaceChildren(...chips.map((c) => {
    const s = document.createElement("span"); s.className = "chip"; s.textContent = c; return s;
  }));
}

/* ---------- Navigasi halaman (hanya berefek di tampilan mobile) ---------- */
document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => {
  const page = b.dataset.page;
  $("app").dataset.page = page;
  document.querySelectorAll(".nav-btn").forEach((x) => x.classList.toggle("active", x === b));
  $("page-scanner").classList.toggle("active", page === "scanner");
  $("page-log").classList.toggle("active", page === "log");
}));

/* ---------- Database (Firestore + fallback lokal) ---------- */
const LS_KEY = "mock_inventory_db";
let mockData = JSON.parse(localStorage.getItem(LS_KEY) || "[]");

function renderLog(rows) {
  const list = $("data-list");
  list.replaceChildren(...rows.map((r) => {
    const div = document.createElement("div"); div.className = "log-item";
    const t = document.createElement("span"); t.className = "time"; t.textContent = r.time;
    const i = document.createElement("span"); i.className = "items"; i.textContent = r.items;
    div.append(t, i); return div;
  }));
  if (!rows.length) list.innerHTML = '<div class="empty-state">Belum ada objek terdeteksi</div>';
  $("log-count").textContent = `${rows.length} items`;
  $("badge").textContent = rows.length;
}
const renderMock = () => renderLog(mockData.map((d) => ({
  time: new Date(d.timestamp).toLocaleTimeString("id-ID"), items: d.items,
})));

function switchToMock(reason) {
  if (isMockMode) return;
  console.warn("Beralih ke mode lokal:", reason);
  isMockMode = true; unsubscribe?.(); setStatus(); renderMock();
  showToast("Firestore tidak bisa diakses, pakai penyimpanan lokal");
}
function listenToDatabase() {
  const q = query(collection(db, COLLECTION), orderBy("timestamp", "desc"), limit(30));
  unsubscribe = onSnapshot(q, (snap) => renderLog(snap.docs.map((d) => {
    const x = d.data({ serverTimestamps: "estimate" });
    return { time: x.timestamp ? x.timestamp.toDate().toLocaleTimeString("id-ID") : "Baru saja", items: x.items };
  })), (err) => switchToMock(err.code || err.message));
  setStatus();
}
async function saveToDatabase(data) {
  const items = data.map((d) => `${d.class} (${d.confidence}%)`).join(", ");
  const base = { items, count: data.length, device_id: "MOBILE-WEB" };
  if (!isMockMode) {
    try {
      await addDoc(collection(db, COLLECTION), { ...base, timestamp: serverTimestamp() });
      showToast(`Tersimpan: ${data.length} objek`); return;
    } catch (err) { switchToMock(err.code || err.message); }
  }
  mockData = [{ ...base, timestamp: new Date().toISOString() }, ...mockData].slice(0, 50);
  localStorage.setItem(LS_KEY, JSON.stringify(mockData));
  renderMock(); showToast(`Tersimpan lokal: ${data.length} objek`);
}

/* ---------- Model ---------- */
async function loadModel() {
  showOverlay("Memuat Model AI (COCO-SSD)...");
  try {
    if (typeof cocoSsd === "undefined") throw new Error("Library coco-ssd tidak termuat. Cek koneksi internet.");
    await tf.ready();
    model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
    hideOverlay();
    btnCamera.disabled = false;
    showToast("Model siap! Tekan Kamera");
  } catch (err) {
    console.error(err); showOverlay("Gagal memuat model: " + err.message, false);
  }
}

/* ---------- Kamera ---------- */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
}
new ResizeObserver(resizeCanvas).observe($("stage"));

async function openStream() {
  stream?.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
  } catch (err) {
    console.error(err);
    const hint = location.protocol === "http:" && !["localhost", "127.0.0.1"].includes(location.hostname)
      ? " Kamera di HP butuh HTTPS." : "";
    showOverlay(`Kamera tidak bisa diakses (${err.name}).${hint}`, false);
    return false;
  }
  video.srcObject = stream;
  await video.play();
  const s = stream.getVideoTracks()[0].getSettings();
  video.classList.toggle("mirror", s.facingMode === "user" || (!s.facingMode && facing === "user"));
  torchOn = false; setRail(btnFlash, false);
  hideOverlay(); resizeCanvas();
  return true;
}

async function startCamera() {
  if (!(await openStream())) return;
  isCameraOn = true;
  setRail(btnCamera, true, true);
  btnSwitch.disabled = btnAI.disabled = btnFlash.disabled = false;
  setInfo("Kamera aktif", "Tekan AI Scan untuk mulai mendeteksi");
}
function stopCamera() {
  stopAI();
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null; stream = null; isCameraOn = false;
  setRail(btnCamera, false);
  btnSwitch.disabled = btnAI.disabled = btnFlash.disabled = true;
  setInfo("Menunggu...", "Nyalakan kamera lalu tekan AI Scan");
}
btnCamera.addEventListener("click", () => (isCameraOn ? stopCamera() : startCamera()));

btnSwitch.addEventListener("click", async () => {
  facing = facing === "user" ? "environment" : "user";
  await openStream();
});

btnFlash.addEventListener("click", async () => {
  const track = stream?.getVideoTracks()[0];
  if (!track?.getCapabilities?.().torch) return showToast("Flash tidak didukung di kamera ini");
  try {
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    setRail(btnFlash, torchOn);
  } catch { torchOn = false; showToast("Flash gagal dinyalakan"); }
});

/* ---------- Deteksi ---------- */
// video pakai object-fit: cover, jadi koordinat bbox harus dipetakan ke ukuran tampilan
function mapBox([x, y, w, h]) {
  const cw = canvas.width, ch = canvas.height, vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(cw / vw, ch / vh);
  const offX = (cw - vw * scale) / 2, offY = (ch - vh * scale) / 2;
  let bx = x * scale + offX; const by = y * scale + offY, bw = w * scale, bh = h * scale;
  if (video.classList.contains("mirror")) bx = cw - bx - bw;
  return [bx, by, bw, bh];
}

function drawPrediction(p, ok) {
  const [x, y, w, h] = mapBox(p.bbox);
  const dpr = window.devicePixelRatio || 1;
  ctx.strokeStyle = ok ? "#10b981" : "#6b728099";
  ctx.lineWidth = 3 * dpr;
  ctx.strokeRect(x, y, w, h);
  if (!ok) return;
  const label = `${p.class} ${(p.score * 100).toFixed(0)}%`;
  ctx.font = `bold ${13 * dpr}px sans-serif`;
  const tw = ctx.measureText(label).width + 10 * dpr, th = 22 * dpr;
  const ly = y < th ? y + th : y;
  ctx.fillStyle = "#10b981"; ctx.fillRect(x, ly - th, tw, th);
  ctx.fillStyle = "#fff"; ctx.fillText(label, x + 5 * dpr, ly - 6 * dpr);
}

async function detectLoop() {
  if (!isAIDetecting || !isCameraOn) return;
  try {
    const preds = await model.detect(video);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const targets = [];
    preds.forEach((p) => {
      const ok = TARGET_CLASSES.includes(p.class) && p.score > MIN_CONFIDENCE;
      drawPrediction(p, ok);
      if (ok) targets.push({ class: p.class, confidence: +(p.score * 100).toFixed(1) });
    });
    if (targets.length) {
      const best = targets.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      setInfo(best.class, `Terdeteksi ${targets.length} objek • Confidence ${Math.round(best.confidence)}%`,
        targets.map((t) => `${t.class} • ${Math.round(t.confidence)}%`));
      if (Date.now() - lastSaveTime > SAVE_THROTTLE_MS) {
        lastSaveTime = Date.now(); saveToDatabase(targets);
      }
    } else setInfo("Tidak ada objek", "Arahkan kamera ke objek target");
  } catch (err) { console.error("Deteksi gagal:", err); }
  requestAnimationFrame(detectLoop);
}

function stopAI() {
  isAIDetecting = false; setRail(btnAI, false);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
btnAI.addEventListener("click", () => {
  if (isAIDetecting) { stopAI(); return setInfo("AI berhenti", "Tekan AI Scan untuk melanjutkan"); }
  isAIDetecting = true; setRail(btnAI, true); detectLoop();
});

/* ---------- Init ---------- */
listenToDatabase();
loadModel();
