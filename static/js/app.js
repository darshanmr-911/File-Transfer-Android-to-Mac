/**
 * AirBridge - Client-side application logic
 * Handles uploads, downloads, WebSocket updates, E2E encryption, and QR scanning.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    deviceId: localStorage.getItem("airbridge_device_id") || generateId(),
    deviceName: localStorage.getItem("airbridge_device_name") || getDefaultDeviceName(),
    maxFileSize: 100 * 1024 * 1024,
    pendingDownload: null,
    pendingDecrypt: null,
    downloadStep: null,
    qrScanner: null,
  };

  localStorage.setItem("airbridge_device_id", state.deviceId);

  // ---------------------------------------------------------------------------
  // DOM elements
  // ---------------------------------------------------------------------------

  const els = {
    serverUrl: document.getElementById("serverUrl"),
    qrCode: document.getElementById("qrCode"),
    deviceList: document.getElementById("deviceList"),
    deviceCount: document.getElementById("deviceCount"),
    dropZone: document.getElementById("dropZone"),
    fileInput: document.getElementById("fileInput"),
    uploadProgressList: document.getElementById("uploadProgressList"),
    fileList: document.getElementById("fileList"),
    maxSizeHint: document.getElementById("maxSizeHint"),
    uploadPassword: document.getElementById("uploadPassword"),
    encryptToggle: document.getElementById("encryptToggle"),
    themeToggle: document.getElementById("themeToggle"),
    refreshFiles: document.getElementById("refreshFiles"),
    scanQrBtn: document.getElementById("scanQrBtn"),
    historyBtn: document.getElementById("historyBtn"),
    toastContainer: document.getElementById("toastContainer"),
    passwordModal: document.getElementById("passwordModal"),
    downloadPassword: document.getElementById("downloadPassword"),
    cancelPassword: document.getElementById("cancelPassword"),
    confirmPassword: document.getElementById("confirmPassword"),
    decryptModal: document.getElementById("decryptModal"),
    decryptKey: document.getElementById("decryptKey"),
    cancelDecrypt: document.getElementById("cancelDecrypt"),
    confirmDecrypt: document.getElementById("confirmDecrypt"),
    keyShareModal: document.getElementById("keyShareModal"),
    sharedKey: document.getElementById("sharedKey"),
    copyKeyBtn: document.getElementById("copyKeyBtn"),
    closeKeyModal: document.getElementById("closeKeyModal"),
    scannerModal: document.getElementById("scannerModal"),
    closeScanner: document.getElementById("closeScanner"),
    qrReader: document.getElementById("qrReader"),
    historyModal: document.getElementById("historyModal"),
    historyList: document.getElementById("historyList"),
    closeHistory: document.getElementById("closeHistory"),
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function generateId() {
    return "dev_" + Math.random().toString(36).slice(2, 11);
  }

  function getDefaultDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return "iPhone";
    if (/Android/.test(ua)) return "Android Device";
    if (/Mac/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows PC";
    return "My Device";
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }

  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    els.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function openModal(modal) {
    modal.hidden = false;
  }

  function closeModal(modal) {
    modal.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------

  function initTheme() {
    const saved = localStorage.getItem("airbridge_theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("airbridge_theme", next);
  }

  // ---------------------------------------------------------------------------
  // Server info & files
  // ---------------------------------------------------------------------------

  async function loadServerInfo() {
    try {
      const res = await fetch("/api/info");
      const data = await res.json();
      els.serverUrl.textContent = data.server_url;
      state.maxFileSize = data.max_file_size;
      els.maxSizeHint.textContent = `Max ${data.max_file_size_formatted} per file`;
    } catch {
      els.serverUrl.textContent = window.location.origin;
      showToast("Could not load server info", "error");
    }
  }

  async function loadFiles() {
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      renderFiles(data.files);
    } catch {
      showToast("Failed to load files", "error");
    }
  }

  function renderFiles(files) {
    if (!files || files.length === 0) {
      els.fileList.innerHTML = '<li class="file-item empty">No files yet — send something!</li>';
      return;
    }

    els.fileList.innerHTML = files.map((file) => {
      const badges = [];
      if (file.password_protected) badges.push('<span class="file-badge">🔒 Protected</span>');
      if (file.encrypted) badges.push('<span class="file-badge">🔐 Encrypted</span>');

      return `
        <li class="file-item" data-id="${file.id}">
          <div class="file-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          </div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(file.name)}</div>
            <div class="file-meta">
              <span>${file.size_formatted}</span>
              <span>from ${escapeHtml(file.device_name)}</span>
              ${badges.join("")}
            </div>
          </div>
          <div class="file-actions">
            <button class="btn-download" data-action="download" data-id="${file.id}"
              data-protected="${file.password_protected}" data-encrypted="${file.encrypted}"
              title="Download" aria-label="Download">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>
            <button class="btn-delete" data-action="delete" data-id="${file.id}"
              title="Delete" aria-label="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </li>
      `;
    }).join("");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderDevices(devices) {
    els.deviceCount.textContent = devices.length;

    if (!devices.length) {
      els.deviceList.innerHTML = '<li class="device-item empty">No devices connected yet</li>';
      return;
    }

    els.deviceList.innerHTML = devices.map((d) => `
      <li class="device-item">
        <div class="device-avatar">${d.name.charAt(0).toUpperCase()}</div>
        <div>
          <div class="device-name">${escapeHtml(d.name)}</div>
        </div>
        <span class="device-status">Online</span>
      </li>
    `).join("");
  }

  // ---------------------------------------------------------------------------
  // End-to-end encryption (AES-GCM via Web Crypto API)
  // ---------------------------------------------------------------------------

  async function generateEncryptionKey() {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    const exported = await crypto.subtle.exportKey("raw", key);
    const keyBase64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    return { key, keyBase64 };
  }

  async function importEncryptionKey(keyBase64) {
    const raw = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }

  async function encryptFile(file, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const content = await file.arrayBuffer();
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, content);

    // Prepend IV to encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);

    return new Blob([combined], { type: "application/octet-stream" });
  }

  async function decryptData(encryptedBlob, keyBase64) {
    const key = await importEncryptionKey(keyBase64);
    const data = new Uint8Array(await encryptedBlob.arrayBuffer());
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);

    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new Blob([decrypted]);
  }

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  function createProgressItem(name) {
    const id = "progress_" + Math.random().toString(36).slice(2, 8);
    const el = document.createElement("div");
    el.className = "progress-item";
    el.id = id;
    el.innerHTML = `
      <div class="progress-name">
        <span>${escapeHtml(name)}</span>
        <span class="progress-pct">0%</span>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar"></div>
      </div>
    `;
    els.uploadProgressList.appendChild(el);
    return el;
  }

  function updateProgress(el, percent, status) {
    const bar = el.querySelector(".progress-bar");
    const pct = el.querySelector(".progress-pct");
    bar.style.width = percent + "%";
    pct.textContent = status || percent + "%";
    if (percent >= 100) bar.classList.add("complete");
    if (status === "Failed") bar.classList.add("error");
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList);
    const password = els.uploadPassword.value.trim();
    const useEncryption = els.encryptToggle.checked;
    let encryptionKey = null;
    let keyBase64 = null;

    if (useEncryption) {
      const keyData = await generateEncryptionKey();
      encryptionKey = keyData.key;
      keyBase64 = keyData.keyBase64;
    }

    for (const file of files) {
      if (file.size > state.maxFileSize) {
        showToast(`${file.name} exceeds max file size`, "error");
        continue;
      }

      const progressEl = createProgressItem(file.name);

      try {
        let uploadBlob;
        let uploadName = file.name;

        if (useEncryption && encryptionKey) {
          uploadBlob = await encryptFile(file, encryptionKey);
          uploadName = file.name + ".encrypted";
          updateProgress(progressEl, 30, "Encrypting...");
        } else {
          uploadBlob = file;
        }

        const formData = new FormData();
        formData.append("files", uploadBlob, uploadName);
        formData.append("device_name", state.deviceName);
        formData.append("password", password);
        formData.append("encrypted", useEncryption ? "true" : "false");

        await uploadWithProgress(formData, progressEl);
        updateProgress(progressEl, 100, "Done");
        showToast(`${file.name} uploaded successfully`, "success");

        if (useEncryption && keyBase64) {
          els.sharedKey.value = keyBase64;
          openModal(els.keyShareModal);
        }
      } catch (err) {
        updateProgress(progressEl, 0, "Failed");
        showToast(`Failed to upload ${file.name}`, "error");
        console.error(err);
      }
    }

    els.uploadPassword.value = "";
    setTimeout(() => {
      els.uploadProgressList.innerHTML = "";
    }, 3000);
  }

  function uploadWithProgress(formData, progressEl) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          updateProgress(progressEl, pct);
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const data = JSON.parse(xhr.responseText);
          if (data.errors && data.errors.length) {
            showToast(data.errors[0], "warning");
          }
          resolve(data);
        } else {
          reject(new Error(xhr.responseText || "Upload failed"));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.send(formData);
    });
  }

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  function handleDownloadClick(btn) {
    const fileId = btn.dataset.id;
    const isProtected = btn.dataset.protected === "true";
    const isEncrypted = btn.dataset.encrypted === "true";

    state.pendingDownload = { fileId, isProtected, isEncrypted, password: "" };

    if (isEncrypted && isProtected) {
      state.downloadStep = "password_then_decrypt";
      openModal(els.passwordModal);
      els.downloadPassword.value = "";
      els.downloadPassword.focus();
    } else if (isEncrypted) {
      openModal(els.decryptModal);
      els.decryptKey.value = "";
      els.decryptKey.focus();
    } else if (isProtected) {
      openModal(els.passwordModal);
      els.downloadPassword.value = "";
      els.downloadPassword.focus();
    } else {
      downloadFile(fileId, "", false, null);
    }
  }

  async function downloadFile(fileId, password, needsDecrypt, decryptKey) {
    try {
      let url = `/api/download/${fileId}?device_name=${encodeURIComponent(state.deviceName)}`;
      if (password) url += `&password=${encodeURIComponent(password)}`;

      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || "Download failed", "error");
        return;
      }

      let blob = await res.blob();
      let filename = "download";

      // Get filename from Content-Disposition or file list
      const disposition = res.headers.get("Content-Disposition");
      if (disposition) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];
      }

      if (needsDecrypt && decryptKey) {
        blob = await decryptData(blob, decryptKey);
        filename = filename.replace(/\.encrypted$/, "");
        showToast("File decrypted successfully", "success");
      }

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast("Download started", "success");
    } catch (err) {
      showToast("Download failed — check password or key", "error");
      console.error(err);
    }
  }

  async function deleteFile(fileId) {
    try {
      const res = await fetch(`/api/delete/${fileId}`, { method: "DELETE" });
      if (res.ok) {
        showToast("File deleted", "success");
        loadFiles();
      } else {
        showToast("Failed to delete file", "error");
      }
    } catch {
      showToast("Failed to delete file", "error");
    }
  }

  // ---------------------------------------------------------------------------
  // QR Scanner
  // ---------------------------------------------------------------------------

  async function startQrScanner() {
    if (typeof Html5Qrcode === "undefined") {
      showToast("QR scanner library not loaded", "error");
      return;
    }

    openModal(els.scannerModal);

    if (!state.qrScanner) {
      state.qrScanner = new Html5Qrcode("qrReader");
    }

    try {
      await state.qrScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          stopQrScanner();
          if (decodedText.startsWith("http")) {
            window.location.href = decodedText;
          } else {
            showToast("Invalid QR code", "error");
          }
        },
        () => {} // ignore scan failures
      );
    } catch (err) {
      showToast("Camera access denied or unavailable", "error");
      closeModal(els.scannerModal);
      console.error(err);
    }
  }

  async function stopQrScanner() {
    if (state.qrScanner && state.qrScanner.isScanning) {
      try {
        await state.qrScanner.stop();
      } catch {
        // Scanner may already be stopped
      }
    }
    closeModal(els.scannerModal);
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  async function loadHistory() {
    try {
      const res = await fetch("/api/history");
      const data = await res.json();
      renderHistory(data.history);
      openModal(els.historyModal);
    } catch {
      showToast("Failed to load history", "error");
    }
  }

  function renderHistory(history) {
    if (!history || history.length === 0) {
      els.historyList.innerHTML = '<li class="history-item">No transfers yet</li>';
      return;
    }

    els.historyList.innerHTML = history.map((h) => {
      const time = new Date(h.timestamp).toLocaleString();
      const actionClass = h.action === "download" ? "download" : "";
      return `
        <li class="history-item">
          <span class="history-action ${actionClass}">${h.action.toUpperCase()}</span>
          — ${escapeHtml(h.file_name)} (${formatSize(h.size)})
          <br><small>${escapeHtml(h.device_name)} · ${time}</small>
        </li>
      `;
    }).join("");
  }

  // ---------------------------------------------------------------------------
  // WebSocket (real-time updates)
  // ---------------------------------------------------------------------------

  function initSocket() {
    const socket = io();

    socket.on("connect", () => {
      socket.emit("register_device", {
        device_id: state.deviceId,
        device_name: state.deviceName,
      });
    });

    socket.on("device_registered", (data) => {
      if (data.device_id) {
        state.deviceId = data.device_id;
        localStorage.setItem("airbridge_device_id", state.deviceId);
      }
    });

    socket.on("devices_updated", (data) => {
      renderDevices(data.devices || []);
    });

    socket.on("files_updated", (data) => {
      renderFiles(data.files || []);
    });

    socket.on("disconnect", () => {
      showToast("Disconnected from server", "warning");
    });

    socket.on("connect", () => {
      // Reconnected
    });
  }

  // ---------------------------------------------------------------------------
  // Drag & drop
  // ---------------------------------------------------------------------------

  function initDropZone() {
    els.dropZone.addEventListener("click", () => els.fileInput.click());

    els.fileInput.addEventListener("change", (e) => {
      if (e.target.files.length) uploadFiles(e.target.files);
      e.target.value = "";
    });

    ["dragenter", "dragover"].forEach((evt) => {
      els.dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        els.dropZone.classList.add("drag-over");
      });
    });

    ["dragleave", "drop"].forEach((evt) => {
      els.dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        els.dropZone.classList.remove("drag-over");
      });
    });

    els.dropZone.addEventListener("drop", (e) => {
      if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
    });
  }

  // ---------------------------------------------------------------------------
  // Event bindings
  // ---------------------------------------------------------------------------

  function initEvents() {
    els.themeToggle.addEventListener("click", toggleTheme);
    els.refreshFiles.addEventListener("click", loadFiles);
    els.scanQrBtn.addEventListener("click", startQrScanner);
    els.historyBtn.addEventListener("click", loadHistory);
    els.closeScanner.addEventListener("click", stopQrScanner);
    els.closeHistory.addEventListener("click", () => closeModal(els.historyModal));

    els.fileList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === "download") handleDownloadClick(btn);
      if (action === "delete") deleteFile(id);
    });

    els.cancelPassword.addEventListener("click", () => {
      state.downloadStep = null;
      closeModal(els.passwordModal);
    });
    els.confirmPassword.addEventListener("click", () => {
      const pwd = els.downloadPassword.value;
      closeModal(els.passwordModal);
      if (!state.pendingDownload) return;

      if (state.downloadStep === "password_then_decrypt") {
        state.pendingDownload.password = pwd;
        state.downloadStep = null;
        openModal(els.decryptModal);
        els.decryptKey.value = "";
        els.decryptKey.focus();
      } else {
        downloadFile(state.pendingDownload.fileId, pwd, false, null);
      }
    });

    els.cancelDecrypt.addEventListener("click", () => closeModal(els.decryptModal));
    els.confirmDecrypt.addEventListener("click", () => {
      const key = els.decryptKey.value.trim();
      const pwd = state.pendingDownload?.password || "";
      closeModal(els.decryptModal);
      if (state.pendingDownload) {
        downloadFile(state.pendingDownload.fileId, pwd, true, key);
      }
    });

    els.copyKeyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(els.sharedKey.value);
      showToast("Key copied to clipboard", "success");
    });
    els.closeKeyModal.addEventListener("click", () => closeModal(els.keyShareModal));

    // Prompt for device name on first visit
    const savedName = localStorage.getItem("airbridge_device_name");
    if (!savedName) {
      const name = prompt("Enter your device name:", state.deviceName);
      if (name) {
        state.deviceName = name.trim();
        localStorage.setItem("airbridge_device_name", state.deviceName);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-refresh fallback (every 30s)
  // ---------------------------------------------------------------------------

  function initAutoRefresh() {
    setInterval(loadFiles, 30000);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function init() {
    initTheme();
    initDropZone();
    initEvents();
    initSocket();
    initAutoRefresh();
    loadServerInfo();
    loadFiles();
  }

  init();
})();
