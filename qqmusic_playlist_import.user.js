// ==UserScript==
// @name         QQ音乐歌单批量导入
// @namespace    https://y.qq.com/
// @version      0.1.1
// @description  根据 CSV 中的 song,artist 列表批量添加歌曲到指定 QQ 音乐歌单，不存在时自动创建。
// @author       Codex
// @match        https://y.qq.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "__qqmusic_playlist_import_job_v1__";
  const LAST_PLAYLIST_KEY = "__qqmusic_playlist_import_last_playlist__";
  const PANEL_ID = "qqmusic-playlist-import-panel";
  const STYLE_ID = "qqmusic-playlist-import-style";
  const PROFILE_CREATE_URL = "https://y.qq.com/n/ryqq_v2/profile/create";
  const SEARCH_URL = "https://y.qq.com/n/ryqq_v2/search";
  const POLL_INTERVAL_MS = 1600;
  const MAX_LOGS = 250;

  const runtime = {
    automationLocked: false,
    mounted: false,
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nowText() {
    const d = new Date();
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  }

  function safeJsonParse(text, fallback) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return fallback;
    }
  }

  function loadJob() {
    return safeJsonParse(localStorage.getItem(STORAGE_KEY), null);
  }

  function saveJob(job) {
    job.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(job));
    renderPanel();
  }

  function clearJob() {
    localStorage.removeItem(STORAGE_KEY);
    renderPanel();
  }

  function getLastPlaylistName() {
    return localStorage.getItem(LAST_PLAYLIST_KEY) || "";
  }

  function setLastPlaylistName(name) {
    localStorage.setItem(LAST_PLAYLIST_KEY, name || "");
  }

  function jobLog(job, level, message) {
    if (!job.logs) {
      job.logs = [];
    }
    job.logs.push({
      time: nowText(),
      level,
      message,
    });
    if (job.logs.length > MAX_LOGS) {
      job.logs = job.logs.slice(job.logs.length - MAX_LOGS);
    }
  }

  function withJob(mutator) {
    const job = loadJob();
    if (!job) {
      return null;
    }
    mutator(job);
    saveJob(job);
    return job;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }
    if (element.closest(`#${PANEL_ID}`)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeText(input) {
    return String(input || "")
      .normalize("NFKC")
      .replace(/[（）]/g, (m) => (m === "（" ? "(" : ")"))
      .replace(/[【】]/g, (m) => (m === "【" ? "[" : "]"))
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\u3000/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function compactText(input) {
    return normalizeText(input).replace(/\s+/g, "");
  }

  function stripActionSuffix(input) {
    return String(input || "")
      .replace(/播放添加到歌单(?:vip下载)?分享.*$/i, "")
      .replace(/播放添加到歌单分享.*$/i, "")
      .replace(/播放分享.*$/i, "")
      .trim();
  }

  function getCleanNodeText(node) {
    if (!node) {
      return "";
    }
    const clone = node.cloneNode(true);
    clone.querySelectorAll(
      [
        "button",
        "i",
        "svg",
        "use",
        ".icon_txt",
        ".mod_list_menu",
        ".list_menu",
        ".songlist__edit",
        ".songlist__number",
        ".songlist__other",
        "[class*='icon']",
        "[class*='mv']",
        "[class*='vip']",
        "[title='MV']",
        "[title='VIP']",
        "[title='SQ']",
        "[title='HQ']",
        "[aria-label='MV']",
        "[aria-label='VIP']",
        "[aria-label='SQ']",
        "[aria-label='HQ']",
      ].join(", ")
    ).forEach((child) => child.remove());
    return String(clone.textContent || "").trim();
  }

  function stripDecorativeTitleParts(input) {
    return String(input || "")
      .replace(/[《【\[][^》】\]]+[》】\]]/g, "")
      .replace(/[（(][^)）]+[)）]\s*$/g, "")
      .replace(/\s*[-|_]\s*.*$/g, "")
      .trim();
  }

  function splitArtists(input) {
    const normalized = String(input || "")
      .replace(/\s+(feat\.?|ft\.?|with)\s+/gi, "/")
      .replace(/[()（）[\]【】]/g, "/")
      .replace(/[、，,&+／/|;；]/g, "/")
      .replace(/\s+x\s+/gi, "/")
      .replace(/\s+/g, " ")
      .trim();
    const parts = normalized
      .split("/")
      .map((item) => normalizeText(item))
      .filter(Boolean);
    return [...new Set(parts)];
  }

  function normalizeArtistName(input) {
    return normalizeText(input)
      .replace(/^(?:女神|男神|原唱|翻唱|演唱|歌手|主播|网络歌手|抖音热歌|qq音乐推荐|官方推荐)\s*/i, "")
      .replace(/\s*(?:官方|专区|频道)$/i, "")
      .trim();
  }

  function buildArtistTokens(input) {
    return [...new Set(
      splitArtists(input)
        .map((item) => normalizeArtistName(item))
        .filter(Boolean)
    )];
  }

  function getArtistMatchInfo(candidateArtists, targetArtistText) {
    const targetArtists = buildArtistTokens(targetArtistText);
    const compactTargetArtistText = compactText(targetArtistText);
    const candidateTokens = [...new Set(
      (candidateArtists || [])
        .flatMap((item) => buildArtistTokens(item))
        .filter(Boolean)
    )];
    const hasExactArtistText = !!(candidateArtists || []).some(
      (item) => compactText(item) === compactTargetArtistText
    );

    const matchedTargets = targetArtists.filter((target) =>
      candidateTokens.some((candidate) => candidate === target)
    );
    const looselyMatchedTargets = targetArtists.filter((target) =>
      candidateTokens.some((candidate) => candidate === target || candidate.includes(target) || target.includes(candidate))
    );
    const extraCandidates = candidateTokens.filter((candidate) =>
      !targetArtists.some((target) => candidate === target || candidate.includes(target) || target.includes(candidate))
    );

    return {
      targetArtists,
      candidateTokens,
      exactMatchedCount: matchedTargets.length,
      looseMatchedCount: looselyMatchedTargets.length,
      targetCoveredExactly: targetArtists.length > 0 && matchedTargets.length === targetArtists.length,
      targetCoveredLoosely: targetArtists.length > 0 && looselyMatchedTargets.length === targetArtists.length,
      exactSetEqual: targetArtists.length > 0 && matchedTargets.length === targetArtists.length && extraCandidates.length === 0,
      hasExactArtistText,
      extraCount: extraCandidates.length,
    };
  }

  function makeSongKey(song, artist) {
    return `${compactText(song)}||${compactText(artist)}`;
  }

  function parseCsv(text) {
    const rows = [];
    let current = "";
    let row = [];
    let insideQuote = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '"') {
        if (insideQuote && next === '"') {
          current += '"';
          i += 1;
        } else {
          insideQuote = !insideQuote;
        }
        continue;
      }
      if (!insideQuote && char === ",") {
        row.push(current);
        current = "";
        continue;
      }
      if (!insideQuote && (char === "\n" || char === "\r")) {
        if (char === "\r" && next === "\n") {
          i += 1;
        }
        row.push(current);
        current = "";
        rows.push(row);
        row = [];
        continue;
      }
      current += char;
    }
    row.push(current);
    rows.push(row);

    const cleanRows = rows
      .map((cells) => cells.map((cell) => String(cell || "").trim()))
      .filter((cells) => cells.some((cell) => cell !== ""));

    if (cleanRows.length === 0) {
      throw new Error("CSV 文件为空。");
    }

    const header = cleanRows[0].map((cell) => normalizeText(cell));
    const songIndex = header.indexOf("song");
    const artistIndex = header.indexOf("artist");
    if (songIndex === -1 || artistIndex === -1) {
      throw new Error("CSV 表头必须包含 song,artist 两列。");
    }

    const seen = new Set();
    const songs = [];
    let duplicateCount = 0;

    for (let i = 1; i < cleanRows.length; i += 1) {
      const cells = cleanRows[i];
      const song = (cells[songIndex] || "").trim();
      const artist = (cells[artistIndex] || "").trim();
      if (!song || !artist) {
        continue;
      }
      const key = makeSongKey(song, artist);
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      songs.push({
        song,
        artist,
        key,
        status: "pending",
        detail: "",
      });
    }

    if (songs.length === 0) {
      throw new Error("CSV 中没有可导入的 song,artist 数据。");
    }

    return { songs, duplicateCount };
  }

  function buildSummary(job) {
    if (!job) {
      return "暂无任务。";
    }
    const total = job.songs.length;
    const added = job.songs.filter((item) => item.status === "added").length;
    const skipped = job.songs.filter((item) => item.status === "skipped").length;
    const notFound = job.songs.filter((item) => item.status === "not_found").length;
    const ambiguous = job.songs.filter((item) => item.status === "ambiguous").length;
    const failed = job.songs.filter((item) => item.status === "failed").length;
    const header = [
      `状态: ${job.status}`,
      `目标歌单: ${job.playlistName}`,
      `总数: ${total}`,
      `added=${added}`,
      `skipped=${skipped}`,
      `not_found=${notFound}`,
      `ambiguous=${ambiguous}`,
      `failed=${failed}`,
    ].join(" | ");
    const details = job.logs && job.logs.length
      ? job.logs.map((item) => `[${item.time}] ${item.message}`).join("\n")
      : "暂无日志。";
    return `${header}\n\n${details}`;
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) {
      return;
    }

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="qqm-import__header">
        <strong>QQ 音乐歌单导入</strong>
        <span class="qqm-import__badge" data-role="status-badge">idle</span>
      </div>
      <label class="qqm-import__label">
        <span>目标歌单名</span>
        <input data-role="playlist-name" type="text" placeholder="例如：周杰伦收藏" />
      </label>
      <label class="qqm-import__label">
        <span>CSV 文件</span>
        <input data-role="csv-file" type="file" accept=".csv,text/csv" />
      </label>
      <div class="qqm-import__hint" data-role="hint">CSV 表头固定为 song,artist</div>
      <div class="qqm-import__buttons">
        <button data-role="start">开始导入</button>
        <button data-role="stop" class="qqm-import__ghost">停止</button>
        <button data-role="copy" class="qqm-import__ghost">复制日志</button>
        <button data-role="clear" class="qqm-import__ghost">清除任务</button>
      </div>
      <div class="qqm-import__progress" data-role="progress">尚未开始。</div>
      <textarea data-role="output" readonly></textarea>
    `;

    document.body.appendChild(panel);

    const playlistInput = panel.querySelector('[data-role="playlist-name"]');
    const fileInput = panel.querySelector('[data-role="csv-file"]');
    const startButton = panel.querySelector('[data-role="start"]');
    const stopButton = panel.querySelector('[data-role="stop"]');
    const copyButton = panel.querySelector('[data-role="copy"]');
    const clearButton = panel.querySelector('[data-role="clear"]');

    playlistInput.value = getLastPlaylistName();

    startButton.addEventListener("click", async () => {
      const playlistName = playlistInput.value.trim();
      const file = fileInput.files && fileInput.files[0];
      if (!playlistName) {
        alert("请先填写目标歌单名。");
        return;
      }
      if (!file) {
        alert("请先选择 CSV 文件。");
        return;
      }
      setLastPlaylistName(playlistName);
      const currentJob = loadJob();
      if (currentJob && currentJob.status === "running") {
        const confirmed = window.confirm("当前已有运行中的任务，是否覆盖并重新开始？");
        if (!confirmed) {
          return;
        }
      }
      try {
        const text = await file.text();
        const parsed = parseCsv(text);
        const job = {
          version: 1,
          status: "running",
          stopRequested: false,
          playlistName,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          currentIndex: 0,
          playlistEnsured: false,
          ensureAttempts: 0,
          activeQuery: "",
          songs: parsed.songs,
          logs: [],
        };
        jobLog(job, "info", `已载入 ${parsed.songs.length} 首歌曲，目标歌单“${playlistName}”。`);
        if (parsed.duplicateCount > 0) {
          jobLog(job, "info", `已跳过 ${parsed.duplicateCount} 条 CSV 内重复记录。`);
        }
        saveJob(job);
        fileInput.value = "";
        await runAutomation();
      } catch (error) {
        console.error(error);
        alert(`导入任务创建失败：${error.message}`);
      }
    });

    stopButton.addEventListener("click", () => {
      withJob((job) => {
        job.stopRequested = true;
        jobLog(job, "warn", "已收到停止请求，将在当前步骤结束后停止。");
      });
    });

    copyButton.addEventListener("click", async () => {
      const summary = buildSummary(loadJob());
      try {
        await navigator.clipboard.writeText(summary);
        const hint = panel.querySelector('[data-role="hint"]');
        hint.textContent = "日志已复制到剪贴板。";
        setTimeout(() => renderPanel(), 1200);
      } catch (error) {
        console.error(error);
        alert("复制失败，请手动从文本框中复制。");
      }
    });

    clearButton.addEventListener("click", () => {
      const job = loadJob();
      if (job && job.status === "running") {
        const confirmed = window.confirm("任务仍在运行中，确认清除吗？");
        if (!confirmed) {
          return;
        }
      }
      clearJob();
    });
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 340px;
        background: rgba(20, 25, 28, 0.96);
        color: #f5f7f8;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 14px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(10px);
        padding: 14px;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      #${PANEL_ID} * {
        box-sizing: border-box;
      }
      #${PANEL_ID} .qqm-import__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
        font-size: 14px;
      }
      #${PANEL_ID} .qqm-import__badge {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        font-size: 12px;
      }
      #${PANEL_ID} .qqm-import__label {
        display: block;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .qqm-import__label span {
        display: block;
        margin-bottom: 4px;
        color: #cfd7db;
      }
      #${PANEL_ID} input[type="text"],
      #${PANEL_ID} input[type="file"],
      #${PANEL_ID} textarea {
        width: 100%;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.06);
        color: #fff;
        border-radius: 10px;
        outline: none;
      }
      #${PANEL_ID} input[type="text"],
      #${PANEL_ID} input[type="file"] {
        padding: 9px 10px;
      }
      #${PANEL_ID} textarea {
        min-height: 160px;
        resize: vertical;
        padding: 10px;
        margin-top: 8px;
      }
      #${PANEL_ID} .qqm-import__buttons {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-top: 10px;
      }
      #${PANEL_ID} button {
        border: 0;
        border-radius: 10px;
        padding: 9px 10px;
        cursor: pointer;
        background: #31c27c;
        color: #07130d;
        font-weight: 600;
      }
      #${PANEL_ID} .qqm-import__ghost {
        background: rgba(255, 255, 255, 0.12);
        color: #f5f7f8;
      }
      #${PANEL_ID} .qqm-import__hint,
      #${PANEL_ID} .qqm-import__progress {
        color: #a9b7be;
        font-size: 12px;
      }
      #${PANEL_ID} .qqm-import__progress {
        margin-top: 10px;
        white-space: pre-wrap;
      }
    `;
    document.head.appendChild(style);
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }
    const job = loadJob();
    const badge = panel.querySelector('[data-role="status-badge"]');
    const output = panel.querySelector('[data-role="output"]');
    const progress = panel.querySelector('[data-role="progress"]');
    const hint = panel.querySelector('[data-role="hint"]');
    const playlistInput = panel.querySelector('[data-role="playlist-name"]');

    if (playlistInput && !playlistInput.value) {
      playlistInput.value = getLastPlaylistName();
    }

    if (!job) {
      badge.textContent = "idle";
      hint.textContent = "CSV 表头固定为 song,artist";
      progress.textContent = "尚未开始。";
      output.value = "暂无任务。";
      return;
    }

    const added = job.songs.filter((item) => item.status === "added").length;
    const skipped = job.songs.filter((item) => item.status === "skipped").length;
    const notFound = job.songs.filter((item) => item.status === "not_found").length;
    const ambiguous = job.songs.filter((item) => item.status === "ambiguous").length;
    const failed = job.songs.filter((item) => item.status === "failed").length;
    const current = job.songs[job.currentIndex];

    badge.textContent = job.status;
    hint.textContent = `目标歌单：${job.playlistName}`;
    progress.textContent = [
      `进度：${Math.min(job.currentIndex, job.songs.length)}/${job.songs.length}`,
      `当前：${current ? `${current.song} - ${current.artist}` : "无"}`,
      `统计：added=${added}, skipped=${skipped}, not_found=${notFound}, ambiguous=${ambiguous}, failed=${failed}`,
    ].join("\n");
    output.value = buildSummary(job);
  }

  function findByVisibleText(texts, root = document.body) {
    const targets = Array.isArray(texts) ? texts : [texts];
    const normalizedTargets = targets.map((item) => normalizeText(item));
    const nodes = root.querySelectorAll("button, a, span, div, li");
    for (const node of nodes) {
      if (!isVisible(node)) {
        continue;
      }
      const content = normalizeText(node.textContent);
      if (!content) {
        continue;
      }
      if (normalizedTargets.includes(content)) {
        return node;
      }
    }
    return null;
  }

  function findClickableAncestor(element) {
    if (!element) {
      return null;
    }
    return element.closest("button, a, li, div");
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    dispatchInputEvents(element);
  }

  async function clickElement(element) {
    if (!element) {
      throw new Error("点击目标不存在。");
    }
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(120);
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await sleep(80);
    element.click();
    await sleep(160);
  }

  async function waitFor(fn, timeout = 8000, interval = 160) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) {
        return result;
      }
      await sleep(interval);
    }
    return null;
  }

  function currentSearchQuery() {
    const params = new URLSearchParams(location.search);
    return params.get("w") || "";
  }

  function isOnCreatePage() {
    return location.pathname.includes("/n/ryqq_v2/profile/create");
  }

  function isOnSearchPage() {
    return location.pathname.includes("/n/ryqq_v2/search");
  }

  function isOnPlaylistDetailPage() {
    return location.pathname.includes("/n/ryqq_v2/playlist/");
  }

  function isLoggedIn() {
    if (document.querySelector(".profile_unlogin__btn")) {
      return false;
    }
    if (/uin=/.test(document.cookie) || /qqmusic_key=/.test(document.cookie)) {
      return true;
    }
    const avatar = document.querySelector(".js_userInfo_img");
    return !!(avatar && avatar.getAttribute("src"));
  }

  function navigate(url) {
    if (location.href === url) {
      return false;
    }
    location.assign(url);
    return true;
  }

  function buildSearchUrl(song, artist) {
    const query = `${song} ${artist}`.trim();
    return `${SEARCH_URL}?w=${encodeURIComponent(query)}&t=song`;
  }

  function findPlaylistRowByName(playlistName) {
    const expected = compactText(playlistName);
    const rows = document.querySelectorAll(".playlist__item");
    for (const row of rows) {
      const titleNode = row.querySelector(".playlist__title_txt a, .playlist__title_txt, .playlist__title a");
      const title = compactText(titleNode ? titleNode.textContent : row.textContent);
      if (title && (title === expected || title.includes(expected) || expected.includes(title))) {
        return row;
      }
    }
    return null;
  }

  function findCreatePlaylistInput() {
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (const input of inputs) {
      if (!isVisible(input)) {
        continue;
      }
      if (input.closest(`#${PANEL_ID}`)) {
        continue;
      }
      if (input.classList.contains("search_input__input")) {
        continue;
      }
      return input;
    }
    return null;
  }

  async function ensurePlaylist(job) {
    if (!isOnCreatePage()) {
      jobLog(job, "info", "正在跳转到“我创建的歌单”页。");
      saveJob(job);
      navigate(PROFILE_CREATE_URL);
      return false;
    }

    const ready = await waitFor(
      () => document.querySelector(".playlist_toolbar") || document.querySelector("#create_tab"),
      10000
    );
    if (!ready) {
      job.ensureAttempts += 1;
      jobLog(job, "warn", "等待歌单页加载超时，稍后重试。");
      return false;
    }

    const currentTab = document.querySelector("#create_tab");
    if (currentTab && !currentTab.classList.contains("mod_tab__current")) {
      await clickElement(currentTab);
      await sleep(400);
    }

    const existing = findPlaylistRowByName(job.playlistName);
    if (existing) {
      job.playlistEnsured = true;
      jobLog(job, "info", `已确认目标歌单“${job.playlistName}”存在。`);
      return true;
    }

    job.ensureAttempts += 1;
    if (job.ensureAttempts > 4) {
      throw new Error(`连续 ${job.ensureAttempts} 次未能确认歌单创建成功。`);
    }

    jobLog(job, "info", `未找到歌单“${job.playlistName}”，开始尝试创建。`);
    const createButton = document.querySelector(".js_create_new") || findByVisibleText("新建歌单");
    if (!createButton) {
      throw new Error("未找到“新建歌单”按钮。");
    }
    await clickElement(createButton);

    const input = await waitFor(() => findCreatePlaylistInput(), 6000);
    if (!input) {
      throw new Error("未找到新建歌单输入框。");
    }
    setNativeValue(input, job.playlistName);
    await sleep(150);

    const submitNode = findByVisibleText(["确定", "创建", "保存", "完成"]);
    const submitButton = findClickableAncestor(submitNode);
    if (!submitButton) {
      throw new Error("未找到新建歌单确认按钮。");
    }
    await clickElement(submitButton);
    await sleep(1200);

    if (isOnPlaylistDetailPage()) {
      jobLog(job, "info", "歌单创建后已进入歌单详情页，返回歌单列表确认。");
      saveJob(job);
      navigate(PROFILE_CREATE_URL);
      return false;
    }

    const created = await waitFor(() => findPlaylistRowByName(job.playlistName), 5000);
    if (created) {
      job.playlistEnsured = true;
      jobLog(job, "info", `已创建歌单“${job.playlistName}”。`);
      return true;
    }

    jobLog(job, "warn", "创建歌单后暂未在列表中看到结果，将稍后再次确认。");
    return false;
  }

  function collectCandidateArtists(row) {
    const artists = new Set();
    const selectors = [
      ".songlist__artist a",
      ".songlist__artist_txt a",
      ".songlist__singer a",
      ".songlist__singer_txt a",
      "[class*='artist'] a",
      "[class*='singer'] a",
      '.songlist__artist a[href*="/singer/"]',
      'a[href*="/singer/"]',
      ".songlist__artist",
      ".songlist__artist_txt",
      ".songlist__singer",
      ".songlist__singer_txt",
      "[class*='artist']",
      "[class*='singer']",
    ];
    for (const selector of selectors) {
      row.querySelectorAll(selector).forEach((node) => {
        const text = normalizeText(node.textContent);
        if (text) {
          artists.add(text);
        }
      });
    }
    return [...artists];
  }

  function getSongLinkFromRow(row) {
    const selectors = [
      ".songlist__songname_txt a",
      ".songlist__songname a",
      "a[href*='/songDetail/']",
      "a[href*='playsong.html']",
      "a[href*='songid=']",
    ];
    for (const selector of selectors) {
      const node = row.querySelector(selector);
      if (node && isVisible(node)) {
        return node;
      }
    }
    return null;
  }

  function getRawTitleFromRow(row) {
    const link = getSongLinkFromRow(row);
    if (link) {
      const titleText =
        link.getAttribute("title") ||
        link.getAttribute("data-title") ||
        link.getAttribute("aria-label") ||
        getCleanNodeText(link) ||
        link.textContent ||
        "";
      if (String(titleText).trim()) {
        return String(titleText).trim();
      }
    }

    const selectors = [
      ".songlist__songname_txt a",
      ".songlist__songname a",
      ".songlist__songname_txt",
      ".songlist__songname",
      ".songlist__title",
      ".songlist__title_txt",
    ];
    for (const selector of selectors) {
      const node = row.querySelector(selector);
      if (node && isVisible(node)) {
        const text = node.getAttribute("title") || getCleanNodeText(node) || node.textContent || "";
        if (text.trim()) {
          return text.trim();
        }
      }
    }
    return "";
  }

  function cleanCandidateTitle(input) {
    return normalizeText(
      stripActionSuffix(String(input || ""))
        .replace(/^(?:mv|vip|sq|hq)\s*/gi, "")
        .replace(/^\s*(?:mv|vip|sq|hq)\b/gi, "")
        .trim()
    );
  }

  function getBaseCandidateTitle(input) {
    return normalizeText(stripDecorativeTitleParts(cleanCandidateTitle(input)));
  }

  function hasVariantHint(text) {
    const normalized = normalizeText(text);
    return /(?:dj|live|remix|mix|伴奏|钢琴|纯音乐|合唱|快四|慢摇|广场舞|cover|剪辑|片段|铃声|翻唱|伴唱|demo|版\)|版）|版$|[_-]版$)/i.test(
      normalized
    );
  }

  function isLikelyMvCandidate(row, title, link) {
    const href = (link && link.getAttribute("href")) || "";
    return href.includes("/mv/") || !!row.closest(".mv_list__item");
  }

  function extractCandidate(row) {
    const songLink = getSongLinkFromRow(row);
    const rawTitle = getRawTitleFromRow(row);
    const title = cleanCandidateTitle(rawTitle);
    const baseTitle = getBaseCandidateTitle(rawTitle);
    const artists = collectCandidateArtists(row);
    let addButton =
      row.querySelector(".list_menu__add") ||
      row.querySelector('[title="添加到歌单"]') ||
      row.querySelector(".mod_list_menu a:nth-child(2)");

    if (!addButton) {
      const addNode = findByVisibleText("添加到歌单", row);
      addButton = findClickableAncestor(addNode);
    }

    return {
      row,
      rawTitle,
      title,
      baseTitle,
      artists,
      songLink,
      isVariant: hasVariantHint(rawTitle) || (!!baseTitle && compactText(baseTitle) !== compactText(title)),
      isLikelyMv: isLikelyMvCandidate(row, rawTitle, songLink),
      addButton,
    };
  }

  function dedupeCandidates(candidates) {
    const unique = new Map();
    for (const candidate of candidates) {
      const signature = [
        compactText(candidate.title),
        [...candidate.artists].map((item) => compactText(item)).sort().join("/"),
      ].join("||");
      if (!signature.replace(/\|/g, "")) {
        continue;
      }
      if (!unique.has(signature)) {
        unique.set(signature, candidate);
      }
    }
    return [...unique.values()];
  }

  function findSearchRows() {
    const root =
      document.querySelector(".result .mod_songlist") ||
      document.querySelector(".main .mod_songlist") ||
      document.querySelector(".mod_songlist");
    const searchScope = root || document;
    const directRows = Array.from(
      searchScope.querySelectorAll(".songlist__item, .mod_songlist li, [class*='songlist__item']")
    )
      .filter((row) => isVisible(row))
      .filter((row) => row.querySelector(".songlist__songname, .songlist__songname_txt"))
      .filter((row) => row.querySelector(".list_menu__add, [title='添加到歌单'], .mod_list_menu"));
    if (directRows.length > 0) {
      return [...new Set(directRows)];
    }

    const addButtons = Array.from(
      searchScope.querySelectorAll(".list_menu__add, [title='添加到歌单']")
    ).filter((button) => isVisible(button));
    return [...new Set(addButtons
      .map((button) => button.closest("li, .songlist__item, .playlist__item, .mod_songlist"))
      .filter(Boolean))];
  }

  function chooseCandidate(candidates, song, artist) {
    const targetTitle = compactText(song);
    const targetArtists = buildArtistTokens(artist);

    const withScore = dedupeCandidates(candidates)
      .filter((candidate) => candidate.title)
      .map((candidate) => {
        const titleCompact = compactText(candidate.title);
        const baseTitleCompact = compactText(candidate.baseTitle || candidate.title);
        const titleExact = titleCompact === targetTitle;
        const baseTitleExact = baseTitleCompact === targetTitle;
        const artistInfo = getArtistMatchInfo(candidate.artists, artist);
        const titleLoose =
          titleCompact.includes(targetTitle) ||
          targetTitle.includes(titleCompact) ||
          baseTitleCompact.includes(targetTitle) ||
          targetTitle.includes(baseTitleCompact);
        const rowText = compactText(candidate.row.textContent || "");
        const rowHasArtist = targetArtists.some((item) => rowText.includes(compactText(item)));
        const score =
          (titleExact ? 130 : 0) +
          (!titleExact && baseTitleExact ? 80 : 0) +
          (!titleExact && !baseTitleExact && titleLoose ? 25 : 0) +
          (artistInfo.exactSetEqual ? 80 : 0) +
          (artistInfo.hasExactArtistText ? 20 : 0) +
          (!artistInfo.exactSetEqual && artistInfo.targetCoveredExactly ? 50 : 0) +
          (!artistInfo.targetCoveredExactly && artistInfo.targetCoveredLoosely ? 20 : 0) +
          (!artistInfo.targetCoveredLoosely && rowHasArtist ? 20 : 0) +
          (artistInfo.extraCount > 0 ? -25 * artistInfo.extraCount : 0) +
          (candidate.songLink ? 10 : 0) +
          (!candidate.isLikelyMv ? 10 : -60) +
          (!candidate.isVariant ? 20 : -40) +
          (candidate.addButton ? 5 : 0);
        return {
          ...candidate,
          score,
          titleExact,
          baseTitleExact,
          titleLoose,
          artistExactSet: artistInfo.exactSetEqual,
          artistTextExact: artistInfo.hasExactArtistText,
          artistCovered: artistInfo.targetCoveredLoosely,
          artistExtraCount: artistInfo.extraCount,
          rowHasArtist,
        };
      })
      .filter((candidate) => candidate.addButton);

    const strict = withScore
      .filter((candidate) => (candidate.titleExact || candidate.baseTitleExact) && candidate.artistCovered)
      .sort((a, b) => b.score - a.score);
    if (strict.length === 1) {
      return { type: "selected", candidate: strict[0] };
    }
    if (strict.length > 1) {
      if (
        strict[0].score - strict[1].score >= 20 ||
        (strict[0].artistExactSet && !strict[1].artistExactSet) ||
        (strict[0].artistTextExact && !strict[1].artistTextExact) ||
        (strict[0].titleExact && !strict[0].isVariant && !strict[0].isLikelyMv &&
          (!strict[1].titleExact || strict[1].isVariant || strict[1].isLikelyMv))
      ) {
        return { type: "selected", candidate: strict[0] };
      }
      return { type: "ambiguous", candidates: strict.slice(0, 3) };
    }

    const weaker = withScore.filter(
      (candidate) => candidate.titleLoose && (candidate.artistCovered || candidate.rowHasArtist)
    );
    if (weaker.length === 1) {
      return { type: "selected", candidate: weaker[0] };
    }
    if (weaker.length > 1) {
      const sorted = [...weaker].sort((a, b) => b.score - a.score);
      if (sorted[0].score - sorted[1].score >= 20) {
        return { type: "selected", candidate: sorted[0] };
      }
      return { type: "ambiguous", candidates: sorted.slice(0, 3) };
    }

    const titleOnly = withScore.filter((candidate) => candidate.titleExact || candidate.titleLoose);
    if (titleOnly.length === 1) {
      return { type: "selected", candidate: titleOnly[0] };
    }
    if (titleOnly.length > 1) {
      const sorted = [...titleOnly].sort((a, b) => b.score - a.score);
      if (
        sorted[0].score - sorted[1].score >= 30 ||
        (!sorted[0].isVariant && sorted[1].isVariant && !sorted[0].isLikelyMv) ||
        (sorted[0].titleExact && !sorted[0].isLikelyMv && !sorted[1].titleExact)
      ) {
        return { type: "selected", candidate: sorted[0] };
      }
      return { type: "ambiguous", candidates: sorted.slice(0, 3) };
    }

    return { type: withScore.length === 0 ? "not_found" : "ambiguous", candidates: withScore.slice(0, 3) };
  }

  async function revealRowActions(row) {
    row.classList.add("songlist__item--hover", "playlist__item--hover");
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await sleep(140);
  }

  function findOperateMenu() {
    return Array.from(document.querySelectorAll(".mod_operate_menu"))
      .find((node) => isVisible(node) && !node.closest(`#${PANEL_ID}`)) || null;
  }

  function getVisibleOperateMenus() {
    return Array.from(document.querySelectorAll(".mod_operate_menu"))
      .filter((node) => isVisible(node) && !node.closest(`#${PANEL_ID}`));
  }

  function findPlaylistChoiceInMenu(menu, playlistName) {
    const expected = compactText(playlistName);
    const nodes = Array.from(menu.querySelectorAll("a, button, li, span, div"))
      .filter((node) => isVisible(node))
      .map((node) => {
        const text = compactText(node.textContent);
        return {
          node,
          text,
          clickable: findClickableAncestor(node),
        };
      })
      .filter((item) => item.text && (item.text === expected || item.text.includes(expected) || expected.includes(item.text)))
      .map((item) => {
        const exact = item.text === expected;
        const clickableText = compactText(item.clickable ? item.clickable.textContent : "");
        const descendantMatch = Array.from(item.node.querySelectorAll("a, button, li, span, div"))
          .some((child) => child !== item.node && isVisible(child) && compactText(child.textContent) === expected);
        const score =
          (exact ? 100 : 0) +
          (item.clickable && item.clickable !== menu ? 20 : 0) +
          (!descendantMatch ? 15 : 0) +
          (clickableText === expected ? 10 : 0) -
          Math.min(item.text.length, 80);
        return { ...item, score };
      })
      .sort((a, b) => b.score - a.score);
    return nodes[0] ? nodes[0].clickable || nodes[0].node : null;
  }

  function getPopupTipText() {
    const tips = Array.from(document.querySelectorAll(".mod_popup_tips, #popup"))
      .filter((node) => isVisible(node) && !node.closest(`#${PANEL_ID}`));
    const latest = tips[tips.length - 1];
    return latest ? normalizeText(latest.textContent || "") : "";
  }

  async function addCandidateToPlaylist(candidate, playlistName) {
    await revealRowActions(candidate.row);
    const addButton =
      candidate.addButton ||
      candidate.row.querySelector(".list_menu__add, [title='添加到歌单']");
    if (!addButton) {
      throw new Error("未找到“添加到歌单”按钮。");
    }

    const previousMenus = new Set(getVisibleOperateMenus());
    await clickElement(addButton);
    const menu = await waitFor(() => {
      const visibleMenus = getVisibleOperateMenus();
      return visibleMenus.find((node) => !previousMenus.has(node)) || visibleMenus[0] || null;
    }, 5000);
    if (!menu) {
      throw new Error("未能打开歌单选择菜单。");
    }

    const choice = await waitFor(() => findPlaylistChoiceInMenu(menu, playlistName), 5000);
    if (!choice) {
      throw new Error(`未在添加菜单中找到目标歌单“${playlistName}”。`);
    }

    await clickElement(choice);
    const result = await waitFor(() => {
      const tipText = getPopupTipText();
      if (tipText.includes("已在歌单中") || tipText.includes("已经在歌单中")) {
        return "skipped";
      }
      if (
        tipText.includes("已添加") ||
        tipText.includes("添加成功") ||
        tipText.includes("收藏成功") ||
        tipText.includes("成功加入歌单") ||
        tipText.includes("已收藏到歌单")
      ) {
        return "added";
      }
      if (!isVisible(menu)) {
        return "menu_closed";
      }
      return null;
    }, 5000, 180);

    if (result === "added" || result === "skipped") {
      return result;
    }

    await sleep(1200);
    const tipText = getPopupTipText();
    if (tipText.includes("已在歌单中") || tipText.includes("已经在歌单中")) {
      return "skipped";
    }
    if (
      tipText.includes("已添加") ||
      tipText.includes("添加成功") ||
      tipText.includes("收藏成功") ||
      tipText.includes("成功加入歌单") ||
      tipText.includes("已收藏到歌单")
    ) {
      return "added";
    }

    throw new Error("未检测到添加成功提示，可能未真正加入歌单。");
  }

  async function processCurrentSong(job) {
    const current = job.songs[job.currentIndex];
    if (!current) {
      job.status = "finished";
      jobLog(job, "info", "任务完成。");
      return;
    }

    const expectedQuery = `${current.song} ${current.artist}`.trim();
    if (!isOnSearchPage() || compactText(currentSearchQuery()) !== compactText(expectedQuery)) {
      job.activeQuery = expectedQuery;
      jobLog(job, "info", `正在搜索：${current.song} - ${current.artist}`);
      saveJob(job);
      navigate(buildSearchUrl(current.song, current.artist));
      return;
    }

    const ready = await waitFor(
      () => document.querySelector(".mod_search_none") || findSearchRows().length > 0,
      12000
    );
    if (!ready) {
      current.status = "failed";
      current.detail = "等待搜索结果超时";
      job.currentIndex += 1;
      jobLog(job, "error", `搜索超时：${current.song} - ${current.artist}`);
      return;
    }

    if (document.querySelector(".mod_search_none")) {
      current.status = "not_found";
      current.detail = "搜索结果为空";
      job.currentIndex += 1;
      jobLog(job, "warn", `未找到：${current.song} - ${current.artist}`);
      return;
    }

    const rows = findSearchRows();
    const candidates = rows.map(extractCandidate).filter((candidate) => candidate.addButton);
    const decision = chooseCandidate(candidates, current.song, current.artist);

    if (decision.type === "not_found") {
      current.status = "not_found";
      current.detail = "没有符合保守匹配规则的候选";
      job.currentIndex += 1;
      jobLog(job, "warn", `未找到匹配项：${current.song} - ${current.artist}`);
      return;
    }

    if (decision.type === "ambiguous") {
      current.status = "ambiguous";
      current.detail = "存在多个候选，已跳过";
      job.currentIndex += 1;
      const sample = (decision.candidates || [])
        .map((item) => {
          const flags = [
            item.titleExact ? "exact" : "",
            item.baseTitleExact ? "base" : "",
            item.artistExactSet ? "artist_set" : "",
            item.artistTextExact ? "artist_text" : "",
            item.artistExtraCount > 0 ? `extra${item.artistExtraCount}` : "",
            item.isVariant ? "variant" : "",
            item.isLikelyMv ? "mv" : "",
          ].filter(Boolean).join(",");
          return `${item.title || item.rawTitle} / ${(item.artists || []).join("&") || "未知歌手"}${flags ? ` [${flags}]` : ""}`;
        })
        .join(" | ");
      jobLog(
        job,
        "warn",
        `候选歧义，已跳过：${current.song} - ${current.artist}${sample ? `；候选：${sample}` : ""}`
      );
      return;
    }

    try {
      const result = await addCandidateToPlaylist(decision.candidate, job.playlistName);
      current.status = result;
      current.detail = result === "skipped" ? "歌曲可能已存在于歌单中" : "添加成功";
      job.currentIndex += 1;
      jobLog(
        job,
        result === "skipped" ? "warn" : "info",
        `${result === "skipped" ? "跳过" : "已添加"}：${current.song} - ${current.artist}`
      );
    } catch (error) {
      current.status = "failed";
      current.detail = error.message;
      job.currentIndex += 1;
      jobLog(job, "error", `添加失败：${current.song} - ${current.artist}，${error.message}`);
    }
  }

  async function runAutomation() {
    if (runtime.automationLocked) {
      return;
    }
    const job = loadJob();
    if (!job || job.status !== "running") {
      return;
    }

    runtime.automationLocked = true;
    try {
      const latestJob = loadJob();
      if (!latestJob || latestJob.status !== "running") {
        return;
      }

      if (latestJob.stopRequested) {
        latestJob.status = "stopped";
        jobLog(latestJob, "warn", "任务已停止。");
        saveJob(latestJob);
        return;
      }

      if (!isLoggedIn()) {
        latestJob.status = "error";
        jobLog(latestJob, "error", "当前未检测到登录状态，请先登录 QQ 音乐后重试。");
        saveJob(latestJob);
        return;
      }

      if (!latestJob.playlistEnsured) {
        const ensured = await ensurePlaylist(latestJob);
        saveJob(latestJob);
        if (!ensured) {
          return;
        }
      }

      if (latestJob.currentIndex >= latestJob.songs.length) {
        latestJob.status = "finished";
        jobLog(latestJob, "info", "所有歌曲处理完毕。");
        saveJob(latestJob);
        return;
      }

      await processCurrentSong(latestJob);
      saveJob(latestJob);

      if (latestJob.currentIndex >= latestJob.songs.length && latestJob.status === "running") {
        latestJob.status = "finished";
        jobLog(latestJob, "info", "导入任务完成。");
        saveJob(latestJob);
      }
    } catch (error) {
      console.error(error);
      withJob((jobToUpdate) => {
        jobToUpdate.status = "error";
        jobLog(jobToUpdate, "error", error.message || "发生未知错误。");
      });
    } finally {
      runtime.automationLocked = false;
    }
  }

  function bootstrap() {
    if (!document.body || runtime.mounted) {
      return;
    }
    runtime.mounted = true;
    ensureStyle();
    createPanel();
    renderPanel();

    setInterval(() => {
      renderPanel();
      runAutomation().catch((error) => console.error(error));
    }, POLL_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
