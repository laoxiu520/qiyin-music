'use strict';

const BUILT_IN_TRACKS = [
  { id: 'twilight', title: '暮色飞行', en: 'TWILIGHT FLIGHT', artist: 'Mori', genre: '氛围电子', mood: 'chill', moodLabel: '松弛', duration: 33, bpm: 92, src: 'audio/twilight-flight.mp3', art: 0, description: '温暖的合成器铺底，像城市灯火在暮色中缓缓升起。适合下班路上，或什么都不做的此刻。' },
  { id: 'rain', title: '雨停之后', en: 'AFTER THE RAIN', artist: '栖音 Studio', genre: '轻音乐', mood: 'focus', moodLabel: '专注', duration: 38, bpm: 78, src: 'audio/after-rain.mp3', art: 1, description: '干净的琴音与轻柔节拍，为你留出一段安静、专注的时间。' },
  { id: 'orange', title: '橘子海', en: 'ORANGE SEA', artist: 'Summer Salt', genre: '梦幻流行', mood: 'pop', moodLabel: '流行', duration: 29, bpm: 106, src: 'audio/orange-sea.mp3', art: 2, description: '明亮的旋律和跃动节奏，把假日的橙色装进口袋。' },
  { id: 'midnight', title: '午夜漫游', en: 'MIDNIGHT DRIVE', artist: 'Night Lines', genre: '电子', mood: 'electronic', moodLabel: '电子', duration: 26, bpm: 116, src: 'audio/midnight-drive.mp3', art: 3, description: '低矮贝斯穿过午夜街道，给夜晚一点向前的速度。' },
  { id: 'island', title: '岛屿来信', en: 'ISLAND LETTER', artist: 'Mori', genre: '氛围', mood: 'ambient', moodLabel: '氛围', duration: 35, bpm: 86, src: 'audio/island-letter.mp3', art: 4, description: '缓慢流动的声音风景，像一封从遥远岛屿寄来的信。' },
  { id: 'sunny', title: '晴天散步', en: 'SUNNY WALK', artist: '栖音 Studio', genre: '独立流行', mood: 'pop', moodLabel: '流行', duration: 30, bpm: 100, src: 'audio/sunny-walk.mp3', art: 5, description: '轻快、不赶时间。适合阳光很好、没有目的地的散步。' }
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const audio = $('#audio');
const main = $('#main-content');
const searchInput = $('#search-input');
const fileInput = $('#file-input');
const safeJSON = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const escapeHTML = (value = '') => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const formatTime = seconds => {
  const value = Number.isFinite(Number(seconds)) && Number(seconds) >= 0 ? Math.floor(Number(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

const state = {
  tracks: [...BUILT_IN_TRACKS],
  playlists: (() => { const value = safeJSON('qiyin-playlists', []); return Array.isArray(value) ? value : []; })(),
  localTracks: (() => { const value = safeJSON('qiyin-local-tracks', []); return Array.isArray(value) ? value : []; })(),
  sessionTracks: [],
  ccTracks: [],
  ccResults: [],
  ccKey: (() => { const value = safeJSON('qiyin-jamendo-key', ''); return typeof value === 'string' ? value : ''; })(),
  ccQuery: '',
  ccInput: '',
  ccLoading: false,
  ccError: '',
  netTracks: [],
  view: 'home',
  currentId: 'twilight',
  filter: 'all',
  search: '',
  lifePlaylistId: '',
  requestQuery: '',
  neteaseInput: '',
  importing: false,
  caching: new Set(),
  font: safeJSON('qiyin-font', 'normal'),
  favorites: new Set(safeJSON('qiyin-favorites', ['rain'])),
  history: safeJSON('qiyin-history', []),
  shuffle: safeJSON('qiyin-shuffle', false),
  repeat: safeJSON('qiyin-repeat', 0),
  volume: Math.max(0, Math.min(1, safeJSON('qiyin-volume', .72))),
  previousVolume: .72
};

const artIndex = key => {
  let hash = 7;
  for (const char of String(key)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 7;
};
function netTracksFromPlaylists() {
  const seen = new Set();
  const list = [];
  state.playlists.forEach(playlist => {
    (playlist.tracks || []).forEach(track => {
      if (!track || !track.id || seen.has(track.id)) return;
      seen.add(track.id);
      list.push(track);
    });
  });
  return list;
}
function rebuildTracks() {
  state.netTracks = netTracksFromPlaylists();
  const merged = [...BUILT_IN_TRACKS, ...state.netTracks, ...state.localTracks, ...state.sessionTracks, ...state.ccTracks];
  const seen = new Set();
  state.tracks = merged.filter(track => {
    if (!track || !track.id || seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
  if (!trackById(state.currentId)) state.currentId = state.tracks[0].id;
}
function persistPlaylists() {
  localStorage.setItem('qiyin-playlists', JSON.stringify(state.playlists));
}
function persistLocalTracks() {
  localStorage.setItem('qiyin-local-tracks', JSON.stringify(state.localTracks));
}
function pruneMissingFiles() {
  const bridge = nativeBridge();
  if (!bridge || typeof bridge.exists !== 'function') return;
  const usable = track => !track.src || !String(track.src).startsWith('file://') || bridge.exists(track.src);
  const kept = state.localTracks.filter(usable);
  if (kept.length !== state.localTracks.length) {
    state.localTracks = kept;
    persistLocalTracks();
  }
  let changed = false;
  state.playlists.forEach(playlist => (playlist.tracks || []).forEach(track => {
    if (track.cached && track.src && String(track.src).startsWith('file://') && !bridge.exists(track.src)) {
      track.cached = false;
      track.src = track.remoteSrc || track.src;
      changed = true;
    }
  }));
  if (changed) persistPlaylists();
}
function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function nativeBridge() {
  return typeof window.QiyinNative !== 'undefined' ? window.QiyinNative : null;
}
function cacheStats() {
  const bridge = nativeBridge();
  if (!bridge) return null;
  try { return JSON.parse(bridge.cacheInfo()); } catch { return null; }
}
function applyFont() {
  document.documentElement.dataset.font = state.font === 'large' || state.font === 'small' ? state.font : 'normal';
  localStorage.setItem('qiyin-font', JSON.stringify(state.font));
}
function licenseLabel(url) {
  const match = String(url || '').match(/licenses\/([a-z-]+)\/([\d.]+)/i);
  return match ? `CC ${match[1].toUpperCase()} ${match[2]}` : 'CC 授权';
}
function ccTrackFrom(item) {
  return {
    id: `cc-${item.id}`,
    ccId: String(item.id),
    title: item.title || '未命名曲目',
    en: '',
    artist: item.artist || '未知音乐人',
    genre: 'CC 授权',
    mood: 'cc',
    moodLabel: 'CC',
    duration: Number(item.duration) || 0,
    src: item.audio,
    remoteSrc: item.audio,
    remote: true,
    cc: true,
    license: licenseLabel(item.license),
    licenseUrl: item.license || '',
    shareUrl: item.shareUrl || '',
    art: artIndex(item.id),
    description: `CC 授权音乐 · ${licenseLabel(item.license)}。请保留作者署名与许可信息。${item.shareUrl ? ` 来源：${item.shareUrl}` : ''}`
  };
}

function currentTrack() {
  return state.tracks.find(track => track.id === state.currentId) || state.tracks[0];
}
function trackById(id) { return state.tracks.find(track => track.id === id); }
function coverMarkup(track, classes = '') {
  const title = escapeHTML((track.en || track.title).toUpperCase()).replace(/ /g, '<br>');
  return `<div class="cover ${classes} art-${Number(track.art) % 7}">
    <span class="cover-kicker">${track.local ? 'YOUR COLLECTION' : 'QIYIN ORIGINAL'}</span>
    <span class="cover-glyph"></span><strong>${title}</strong>
    <span class="cover-index">${track.local ? 'LOCAL AUDIO' : `VOL. ${String(state.tracks.indexOf(track) + 1).padStart(3, '0')}`}</span>
  </div>`;
}
function icon(name, classes = '') { return `<svg class="${classes}"><use href="#i-${name}"/></svg>`; }
function trackRow(track, index) {
  const playing = track.id === state.currentId;
  const liked = state.favorites.has(track.id);
  return `<div class="track-row ${playing ? 'playing' : ''}" data-row-id="${track.id}">
    <span class="track-number">${playing && !audio.paused ? '♪' : String(index + 1).padStart(2, '0')}</span>
    ${coverMarkup(track, 'track-art')}
    <button class="track-play-overlay" data-play-id="${track.id}" aria-label="播放 ${escapeHTML(track.title)}">${icon(playing && !audio.paused ? 'pause' : 'play')}</button>
    <div class="track-main"><span class="track-title">${escapeHTML(track.title)}${track.local ? '<span class="local-pill">本地</span>' : ''}</span><span class="track-sub">${escapeHTML(track.artist)} · ${escapeHTML(track.genre)}</span></div>
    <span class="track-artist">${escapeHTML(track.artist)}</span>
    <span class="track-mood">${escapeHTML(track.moodLabel)}</span>
    <span class="track-duration" data-duration-id="${track.id}">${formatTime(track.duration)}</span>
    <button class="icon-button heart-button ${liked ? 'liked' : ''}" data-like-id="${track.id}" aria-label="${liked ? '取消收藏' : '收藏'}">${icon('heart')}</button>
    <button class="icon-button row-more" data-info-id="${track.id}" aria-label="歌曲详情">${icon('more')}</button>
  </div>`;
}
function albumCard(track) {
  return `<article class="album-card">
    ${coverMarkup(track, 'card-art')}
    <button class="card-play" data-play-id="${track.id}" aria-label="播放 ${escapeHTML(track.title)}">${icon(track.id === state.currentId && !audio.paused ? 'pause' : 'play')}</button>
    <div class="album-info"><h3>${escapeHTML(track.title)}</h3><p>${escapeHTML(track.artist)} · ${escapeHTML(track.genre)}</p><div class="album-meta"><span class="mood-tag">${escapeHTML(track.moodLabel)}</span><span>${track.bpm ? `${track.bpm} BPM` : 'LOCAL AUDIO'}</span></div></div>
  </article>`;
}
function sectionHead(title, subtitle = '', link = '') {
  return `<div class="section-head"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${link ? `<button class="text-link" data-view="${link}">查看全部 ${icon('arrow')}</button>` : ''}</div>`;
}
function pageHeading(title, subtitle, count, label = 'TRACKS') {
  return `<div class="page-heading"><div><p class="eyebrow">YOUR MUSIC, YOUR MOMENT</p><h1>${title}</h1><p>${subtitle}</p></div><div class="page-stat"><strong>${count}</strong><span>${label}</span></div></div>`;
}
function emptyState(type, title, description, action = '') {
  return `<div class="empty-state"><div><div class="empty-icon">${icon(type)}</div><h2>${title}</h2><p>${description}</p>${action}</div></div>`;
}

function renderHome() {
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  const hour = new Date().getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  return `<div class="view-enter">
    <div class="welcome-line"><div><h1>${greeting}，听见此刻。</h1><p>今天，也为自己留一点音乐时间。</p></div><span class="date-pill">${date}</span></div>
    <section class="hero">
      <div class="hero-copy"><div class="hero-label">TODAY'S SELECTION</div><h2>把世界调成<br><em>喜欢的频率。</em></h2><p class="hero-description">今日推荐「暮色飞行」。让温暖的电子声场，接住你一整天的疲惫。</p><div class="hero-actions"><button class="primary-button" data-play-id="twilight">${icon(state.currentId === 'twilight' && !audio.paused ? 'pause' : 'play')} ${state.currentId === 'twilight' && !audio.paused ? '暂停播放' : '立即收听'}</button><button class="icon-button hero-like heart-button ${state.favorites.has('twilight') ? 'liked' : ''}" data-like-id="twilight" aria-label="收藏暮色飞行">${icon('heart')}</button></div></div>
      <div class="hero-visual">${coverMarkup(BUILT_IN_TRACKS[0], 'hero-cover')}<div class="floating-note"><span></span><small>ORIGINAL · 92 BPM</small></div></div>
    </section>
    <section class="section">${sectionHead('为你精选', '根据此刻的心情，选一段声音', 'discover')}<div class="album-grid">${state.tracks.slice(1, 4).map(albumCard).join('')}</div></section>
    <section class="section">${sectionHead('每日推荐', '6 首原创合成音乐，免费畅听', 'library')}<div class="track-list">${state.tracks.slice(0, 6).map(trackRow).join('')}</div></section>
  </div>`;
}
function renderDiscover() {
  const filters = [['all', '全部'], ['chill', '松弛'], ['focus', '专注'], ['electronic', '电子'], ['pop', '流行'], ['ambient', '氛围']];
  const local = state.tracks.some(t => t.local) ? [['local', '我的导入']] : [];
  const filtered = state.filter === 'all' ? state.tracks : state.tracks.filter(track => track.mood === state.filter);
  return `<div class="view-enter">${pageHeading('探索你的下一段循环', '不必追随榜单，选择与你此刻同频的声音。', filtered.length)}
    <div class="filter-chips">${[...filters, ...local].map(([id, label]) => `<button class="filter-chip ${state.filter === id ? 'active' : ''}" data-filter="${id}">${label}</button>`).join('')}</div>
    ${filtered.length ? `<div class="album-grid discover-grid">${filtered.map(albumCard).join('')}</div><section class="section">${sectionHead('细听每一首', '点击封面或播放键，开始收听')}<div class="track-list">${filtered.map(trackRow).join('')}</div></section>` : emptyState('compass', '这里还没有音乐', '试试其他风格，或导入一首属于你的音乐。')}
  </div>`;
}
function renderLibrary() {
  const localCount = state.tracks.filter(t => t.local).length;
  return `<div class="view-enter">${pageHeading('我的曲库', '内置音乐与你保存的本地音频，都汇聚在这里。', state.tracks.length)}
    <div class="library-banner"><div><h3>把你的音乐带进来</h3><p>支持 MP3、FLAC、M4A、WAV 等格式。导入后会复制到应用私有目录，重启仍可播放，也不会上传。</p></div><button class="primary-button" data-import>${icon('plus')} 导入音乐</button></div>
    ${sectionHead('全部歌曲', `${BUILT_IN_TRACKS.length} 首内置音乐${localCount ? ` · ${localCount} 首本地音频` : ''}`)}<div class="track-list">${state.tracks.map(trackRow).join('')}</div>
  </div>`;
}
function renderFavorites() {
  const tracks = state.tracks.filter(track => state.favorites.has(track.id));
  return `<div class="view-enter">${pageHeading('喜欢的音乐', '那些让你心动的旋律，值得再多听一遍。', tracks.length)}
    ${tracks.length ? `<div class="library-banner"><div><h3>你的私人精选</h3><p>收藏会保存在当前浏览器中，下次打开依然可以听到。</p></div><button class="primary-button" data-play-id="${tracks[0].id}">${icon('play')} 播放收藏</button></div><div class="track-list">${tracks.map(trackRow).join('')}</div>` : emptyState('heart', '还没有喜欢的音乐', '听到喜欢的歌曲时，点亮旁边的心形按钮，它就会出现在这里。', `<button class="primary-button" data-view="discover">去发现音乐 ${icon('arrow')}</button>`)}
  </div>`;
}
function renderHistory() {
  const tracks = state.history.map(trackById).filter(Boolean);
  return `<div class="view-enter">${pageHeading('最近播放', '沿着声音留下的足迹，回到刚才的那一刻。', tracks.length)}
    ${tracks.length ? `<div class="track-list">${tracks.map(trackRow).join('')}</div>` : emptyState('clock', '还没有播放记录', '从一首喜欢的音乐开始，你的收听足迹会保存在这里。', `<button class="primary-button" data-play-id="twilight">${icon('play')} 播放今日推荐</button>`)}
  </div>`;
}
function renderSearch() {
  const query = state.search.toLocaleLowerCase('zh-CN');
  const tracks = state.tracks.filter(track => [track.title, track.en, track.artist, track.genre, track.moodLabel].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query)));
  return `<div class="view-enter">${pageHeading('搜索结果', '在你的音乐空间里，找到想听的声音。', tracks.length)}<p class="search-summary">与 “<strong>${escapeHTML(state.search)}</strong>” 相关的结果</p>
    ${tracks.length ? `<div class="album-grid discover-grid">${tracks.slice(0, 3).map(albumCard).join('')}</div><section class="section">${sectionHead('歌曲', `共找到 ${tracks.length} 首`)}<div class="track-list">${tracks.map(trackRow).join('')}</div></section>` : emptyState('search', '没有找到相关音乐', '试试搜索“松弛”“电子”“Mori”，或换一个关键词。', `<button class="primary-button" data-view="discover">浏览全部音乐</button>`)}
  </div>`;
}
function playlistCover(playlist) {
  const name = escapeHTML(playlist.name || '歌单');
  const short = escapeHTML((playlist.name || 'QIYIN').slice(0, 6).toUpperCase());
  return `<div class="cover playlist-cover-art art-${artIndex(playlist.id)}">
    <span class="cover-kicker">PLAYLIST</span><span class="cover-glyph"></span>
    <strong>${short}</strong><span class="cover-index">${(playlist.tracks || []).length} TRACKS</span>
  </div>${playlist.cover ? `<img class="playlist-cover-img" src="${escapeHTML(playlist.cover)}" alt="${name}" loading="lazy" onerror="this.remove()">` : ''}`;
}
function playlistCard(playlist) {
  const count = (playlist.tracks || []).length;
  return `<article class="playlist-card">
    <button class="playlist-cover" data-pl-open="${escapeHTML(playlist.id)}" aria-label="查看歌单 ${escapeHTML(playlist.name)}">${playlistCover(playlist)}</button>
    <div class="playlist-meta"><h3>${escapeHTML(playlist.name || '未命名歌单')}</h3><p>${count} 首 · ${String(playlist.id) === 'cc' ? 'CC 授权' : '网易云'}</p></div>
    <div class="playlist-actions">
      <button class="mini-button" data-pl-play="${escapeHTML(playlist.id)}">${icon('play')} 播放全部</button>
      <button class="icon-button" data-pl-delete="${escapeHTML(playlist.id)}" aria-label="删除歌单">${icon('trash')}</button>
    </div>
  </article>`;
}
function lifeTrackRow(track, index) {
  const playing = track.id === state.currentId && !audio.paused;
  const caching = state.caching.has(track.id);
  return `<div class="life-track ${track.id === state.currentId ? 'playing' : ''}" data-life-row="${escapeHTML(track.id)}">
    <span class="life-index">${playing ? '♪' : String(index + 1).padStart(2, '0')}</span>
    <button class="life-play" data-req-play="${escapeHTML(track.id)}" aria-label="播放 ${escapeHTML(track.title)}">${icon(playing ? 'pause' : 'play')}</button>
    <span class="life-copy"><strong>${escapeHTML(track.title)}${track.vip ? '<em class="vip-tag">VIP</em>' : ''}</strong><span>${escapeHTML(track.artist)}</span></span>
    <span class="life-duration">${formatTime(track.duration)}</span>
    ${track.remote ? `<button class="cache-button ${track.cached ? 'cached' : ''}" data-cache-id="${escapeHTML(track.id)}" ${track.cached || caching ? 'disabled' : ''}>${track.cached ? '已缓存' : caching ? '缓存中' : '缓存'}</button>` : ''}
  </div>`;
}
function requestResultsMarkup() {
  const query = state.requestQuery.trim().toLocaleLowerCase('zh-CN');
  let tracks = state.tracks;
  if (query) {
    tracks = tracks.filter(track => [track.title, track.artist, track.album, track.playlistName].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query)));
  } else {
    tracks = state.netTracks.length ? state.netTracks : state.tracks;
  }
  if (!tracks.length) return `<p class="life-empty">没有找到相关歌曲，换个关键词试试。</p>`;
  return tracks.slice(0, 12).map((track, index) => `<button class="request-row ${track.id === state.currentId ? 'playing' : ''}" data-req-play="${escapeHTML(track.id)}">
    <span class="request-index">${track.id === state.currentId && !audio.paused ? '♪' : String(index + 1).padStart(2, '0')}</span>
    <span class="request-copy"><strong>${escapeHTML(track.title)}</strong><span>${escapeHTML(track.artist)} · ${escapeHTML(track.remote ? (track.playlistName || '网易云') : track.genre)}</span></span>
    <span class="request-duration">${formatTime(track.duration)}</span>
  </button>`).join('');
}
function ccResultsMarkup() {
  if (state.ccLoading) return `<p class="life-empty">正在搜索 CC 音乐…</p>`;
  if (state.ccError) return `<p class="life-empty cc-error">${escapeHTML(state.ccError)}</p>`;
  if (!state.ccResults.length) return `<p class="life-empty">搜索一首想听的曲子，结果均为 CC 授权音乐。</p>`;
  return `<div class="life-track-list">${state.ccResults.map((track, index) => `<div class="life-track ${track.id === state.currentId ? 'playing' : ''}" data-life-row="${escapeHTML(track.id)}">
    <span class="life-index">${track.id === state.currentId && !audio.paused ? '♪' : String(index + 1).padStart(2, '0')}</span>
    <button class="life-play" data-req-play="${escapeHTML(track.id)}" aria-label="播放 ${escapeHTML(track.title)}">${icon(track.id === state.currentId && !audio.paused ? 'pause' : 'play')}</button>
    <span class="life-copy"><strong>${escapeHTML(track.title)}<em class="cc-tag">${escapeHTML(track.license)}</em></strong><span>${escapeHTML(track.artist)}</span></span>
    <span class="life-duration">${formatTime(track.duration)}</span>
    <button class="cache-button ${track.cached ? 'cached' : ''}" data-cache-id="${escapeHTML(track.id)}" ${track.cached || state.caching.has(track.id) ? 'disabled' : ''}>${track.cached ? '已缓存' : state.caching.has(track.id) ? '缓存中' : '缓存'}</button>
  </div>`).join('')}</div>`;
}
function ccSection() {
  const bridge = nativeBridge();
  const canSearch = Boolean(bridge && typeof bridge.searchCc === 'function');
  if (!state.ccKey) {
    return `<section class="section cc-section">${sectionHead('CC 免费曲库', '接入 Jamendo 的 CC 授权音乐，可在线听，也可缓存离线')}
      <div class="life-card cc-card">
        <p class="life-desc">填一次免费的 Jamendo Client ID 就能搜索。到 developer.jamendo.com 注册应用，复制 Client ID 粘贴到下面；栖音只在本机保存这个值。</p>
        <div class="import-row">
          <input id="cc-key-input" type="text" autocomplete="off" placeholder="Jamendo Client ID" value="${escapeHTML(state.ccInput)}">
          <button class="primary-button" id="cc-key-save">保存</button>
        </div>
        <p class="life-hint">${canSearch ? '需要联网；搜索结果均为 CC 授权，请保留作者署名。' : '浏览器预览无法联网，请在栖音 App 内使用。'}</p>
      </div>
    </section>`;
  }
  return `<section class="section cc-section">${sectionHead('CC 免费曲库', 'Jamendo CC 授权音乐 · 点歌或缓存离线')}
    <div class="cc-search-row">
      <label class="life-search">${icon('search')}<input id="cc-input" type="search" autocomplete="off" placeholder="搜索 CC 音乐，如 piano、lofi、guitar…" value="${escapeHTML(state.ccQuery)}"></label>
      <button class="primary-button" id="cc-search" ${state.ccLoading ? 'disabled' : ''}>${state.ccLoading ? '搜索中…' : '搜索'}</button>
      <button class="ghost-button" id="cc-key-reset">更换 ID</button>
    </div>
    <div class="request-list" id="cc-results">${ccResultsMarkup()}</div>
    <p class="life-hint">曲目来自 Jamendo，按 CC 许可提供；播放时请保留作者与许可信息。</p>
  </section>`;
}
function renderLife() {
  const bridge = nativeBridge();
  const stats = cacheStats();
  const playlists = state.playlists;
  const active = playlists.find(playlist => String(playlist.id) === String(state.lifePlaylistId)) || playlists[0] || null;
  const cachedCount = stats ? stats.files : state.netTracks.filter(track => track.cached).length;
  return `<div class="view-enter">
    ${pageHeading('我的生活', '把喜欢的歌单带进来，点一首此刻想听的歌。', playlists.length, 'PLAYLISTS')}
    <section class="life-grid">
      <article class="life-card import-card">
        <div class="life-card-head"><div><p class="eyebrow">NETEASE CLOUD</p><h3>导入网易云歌单</h3></div><span class="life-badge">${bridge ? 'APP' : '仅 App'}</span></div>
        <p class="life-desc">粘贴歌单分享链接或歌单 ID，解析后加入我的歌单。</p>
        <div class="import-row">
          <input id="netease-input" type="text" inputmode="url" autocomplete="off" placeholder="https://music.163.com/playlist?id=…" value="${escapeHTML(state.neteaseInput)}" ${bridge ? '' : 'disabled'}>
          <button class="primary-button" id="netease-import" ${bridge && state.neteaseInput.trim() && !state.importing ? '' : 'disabled'}>${state.importing ? '解析中…' : '解析'}</button>
        </div>
        <p class="life-hint">${bridge ? '仅支持公开歌单；VIP 或付费曲目可能无法播放与缓存，请支持正版。' : '浏览器预览无法联网解析，请在栖音 Android App 内使用。'}</p>
      </article>
      <article class="life-card">
        <div class="life-card-head"><div><p class="eyebrow">OFFLINE CACHE</p><h3>缓存</h3></div><span class="life-badge">${cachedCount} 首</span></div>
        <div class="cache-stat"><strong>${stats ? formatBytes(stats.bytes) : '—'}</strong><span>已缓存音频占用空间</span></div>
        <div class="cache-actions">
          <button class="ghost-button" id="clear-cache" ${stats && stats.files ? '' : 'disabled'}>${icon('trash')} 清空缓存</button>
          <button class="ghost-button" data-view="life">${icon('cloud')} 缓存更多</button>
        </div>
      </article>
      <article class="life-card">
        <div class="life-card-head"><div><p class="eyebrow">APPEARANCE</p><h3>字体大小</h3></div><span class="life-badge">${state.font === 'small' ? '小' : state.font === 'large' ? '大' : '标准'}</span></div>
        <div class="segmented">${[['small', '小'], ['normal', '标准'], ['large', '大']].map(([value, label]) => `<button class="seg-item ${state.font === value ? 'active' : ''}" data-font-set="${value}">${label}</button>`).join('')}</div>
        <p class="life-hint">调整文字大小，立即生效并记住你的选择。</p>
      </article>
    </section>
    <section class="section">${sectionHead('我的歌单', playlists.length ? `${playlists.length} 个歌单 · ${state.netTracks.length} 首歌曲` : '导入一个歌单，开始建立你的私人电台')}
      ${playlists.length ? `<div class="playlist-grid">${playlists.map(playlistCard).join('')}</div>` : `<div class="life-empty-card"><p>还没有歌单。上面粘贴一个网易云歌单链接试试。</p></div>`}
    </section>
    ${active ? `<section class="section playlist-detail">${sectionHead(`歌单 · ${escapeHTML(active.name)}`, `${(active.tracks || []).length} 首 · 点击任意歌曲即可点歌`)}
      <div class="life-track-list">${(active.tracks || []).map(lifeTrackRow).join('')}</div>
    </section>` : ''}
    ${ccSection()}
    <section class="section">${sectionHead('点歌台', '输入歌名或歌手，点一首马上播放')}
      <label class="life-search">${icon('search')}<input id="request-input" type="search" autocomplete="off" placeholder="搜索歌名、歌手或歌单…" value="${escapeHTML(state.requestQuery)}"></label>
      <div class="request-list" id="request-results">${requestResultsMarkup()}</div>
    </section>
  </div>`;
}
function render() {
  const views = { home: renderHome, discover: renderDiscover, library: renderLibrary, favorites: renderFavorites, history: renderHistory, life: renderLife };
  main.innerHTML = state.search ? renderSearch() : (views[state.view] || renderHome)();
  $$('.nav-item').forEach(button => button.classList.toggle('active', !state.search && button.dataset.view === state.view));
  $$('.mobile-tabs button').forEach(button => button.classList.toggle('active', !state.search && button.dataset.view === state.view));
  $('#library-count').textContent = state.tracks.length;
  $('#life-count').textContent = state.playlists.length;
  updatePlaybackUI();
  renderQueue();
}

function setView(view) {
  state.view = view;
  state.search = '';
  searchInput.value = '';
  render();
  main.scrollTop = 0;
  $('#queue-panel').classList.remove('open');
  $('#queue-button').classList.remove('active');
}
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}
function persistFavorites() {
  localStorage.setItem('qiyin-favorites', JSON.stringify([...state.favorites]));
}
function toggleFavorite(id) {
  const track = trackById(id);
  if (!track) return;
  if (state.favorites.has(id)) {
    state.favorites.delete(id);
    toast(`已取消收藏「${track.title}」`);
  } else {
    state.favorites.add(id);
    toast(`已收藏「${track.title}」`);
  }
  persistFavorites();
  render();
  updateNowPlaying();
}
function addToHistory(id) {
  state.history = [id, ...state.history.filter(item => item !== id)].slice(0, 30);
  localStorage.setItem('qiyin-history', JSON.stringify(state.history));
}

async function playTrack(id) {
  const track = trackById(id);
  if (!track) return;
  if (state.currentId === id && audio.src) {
    if (audio.paused) await startPlayback(); else audio.pause();
    return;
  }
  state.currentId = id;
  audio.src = track.src;
  audio.load();
  updateNowPlaying();
  render();
  await startPlayback();
}
async function startPlayback() {
  try {
    await audio.play();
    addToHistory(state.currentId);
  } catch (error) {
    console.warn('Playback could not start:', error);
    toast('暂时无法播放，请再试一次或检查音频格式');
  }
}
function togglePlayback() {
  if (audio.paused) startPlayback(); else audio.pause();
}
function playNext(automatic = false) {
  if (!state.tracks.length) return;
  const index = state.tracks.findIndex(track => track.id === state.currentId);
  if (automatic && !state.shuffle && state.repeat === 0 && index === state.tracks.length - 1) {
    audio.pause();
    audio.currentTime = 0;
    return;
  }
  let nextIndex;
  if (state.shuffle && state.tracks.length > 1) {
    do { nextIndex = Math.floor(Math.random() * state.tracks.length); } while (nextIndex === index);
  } else {
    nextIndex = (index + 1) % state.tracks.length;
  }
  playTrack(state.tracks[nextIndex].id);
}
function playPrevious() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const index = state.tracks.findIndex(track => track.id === state.currentId);
  const previous = (index - 1 + state.tracks.length) % state.tracks.length;
  playTrack(state.tracks[previous].id);
}
function updateNowPlaying() {
  const track = currentTrack();
  if (!track) return;
  const nowArt = $('#now-art');
  nowArt.className = `now-art cover art-${track.art % 7}`;
  nowArt.innerHTML = `<span class="cover-kicker">${track.local ? 'YOUR COLLECTION' : 'QIYIN ORIGINAL'}</span><span class="cover-glyph"></span><strong>${escapeHTML((track.en || track.title).toUpperCase()).replace(/ /g, '<br>')}</strong><span class="cover-index">${track.local ? 'LOCAL AUDIO' : 'NOW PLAYING'}</span><button class="art-play" id="art-play" aria-label="播放或暂停">${icon(audio.paused ? 'play' : 'pause')}</button>`;
  $('#now-title').textContent = track.title;
  $('#now-artist').textContent = `${track.artist} · ${track.genre}`;
  $('#mini-cover').className = `mini-cover cover art-${track.art % 7}`;
  $('#player-title').textContent = track.title;
  $('#player-artist').textContent = track.artist;
  $('#duration').textContent = formatTime(Number.isFinite(audio.duration) ? audio.duration : track.duration);
  ['#now-like', '#player-like'].forEach(selector => {
    const button = $(selector);
    const liked = state.favorites.has(track.id);
    button.classList.toggle('liked', liked);
    button.setAttribute('aria-label', liked ? '取消收藏' : '收藏');
  });
  document.title = `${audio.paused ? '' : '♪ '}${track.title} · 栖音 QIYIN`;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: '栖音 · 自由畅听' });
  }
}
function renderQueue() {
  const index = state.tracks.findIndex(track => track.id === state.currentId);
  const ordered = [...state.tracks.slice(index + 1), ...state.tracks.slice(0, index + 1)];
  $('#queue-count').textContent = `${Math.max(0, ordered.length - 1)} 首`;
  $('#queue-list').innerHTML = ordered.slice(0, 6).map(track => `<button class="queue-item ${track.id === state.currentId ? 'active' : ''}" data-queue-id="${track.id}">${coverMarkup(track, 'queue-art')}<span class="queue-item-copy"><strong>${track.id === state.currentId ? '♪ ' : ''}${escapeHTML(track.title)}</strong><span>${escapeHTML(track.artist)}</span></span><span class="queue-time">${formatTime(track.duration)}</span></button>`).join('');
}
function updatePlaybackUI() {
  const playing = !audio.paused;
  $('#play-button').innerHTML = icon(playing ? 'pause' : 'play');
  $('#play-button').setAttribute('aria-label', playing ? '暂停' : '播放');
  const artPlay = $('#art-play');
  if (artPlay) artPlay.innerHTML = icon(playing ? 'play' : 'pause');
  $('#waveform').classList.toggle('playing', playing);
  $$('.track-row').forEach(row => {
    const active = row.dataset.rowId === state.currentId;
    row.classList.toggle('playing', active);
    const number = $('.track-number', row);
    const index = state.tracks.findIndex(t => t.id === row.dataset.rowId);
    if (number) number.textContent = active && playing ? '♪' : String(index + 1).padStart(2, '0');
    const button = $('.track-play-overlay', row);
    if (button) button.innerHTML = icon(active && playing ? 'pause' : 'play');
  });
  const track = currentTrack();
  if (track) document.title = `${playing ? '♪ ' : ''}${track.title} · 栖音 QIYIN`;
}
function updateProgress() {
  const duration = Number.isFinite(audio.duration) ? audio.duration : currentTrack().duration;
  const progress = duration ? (audio.currentTime / duration) * 100 : 0;
  $('#progress').value = Math.round(progress * 10);
  $('#progress').style.setProperty('--value', `${progress}%`);
  $('#current-time').textContent = formatTime(audio.currentTime);
  $('#duration').textContent = formatTime(duration);
}
function setVolume(value) {
  state.volume = Math.max(0, Math.min(1, value));
  audio.volume = state.volume;
  audio.muted = state.volume === 0;
  $('#volume').value = Math.round(state.volume * 100);
  $('#volume').style.setProperty('--value', `${state.volume * 100}%`);
  $('#mute-button').innerHTML = icon(state.volume === 0 ? 'muted' : 'volume');
  localStorage.setItem('qiyin-volume', JSON.stringify(state.volume));
}
function toggleMute() {
  if (state.volume > 0) {
    state.previousVolume = state.volume;
    setVolume(0);
  } else setVolume(state.previousVolume || .72);
}
function toggleQueue() {
  const open = $('#queue-panel').classList.toggle('open');
  $('#queue-button').classList.toggle('active', open);
}
function openDialog(content) {
  $('#dialog-content').innerHTML = content;
  $('#info-dialog').showModal();
}
function showAbout() {
  openDialog(`<div class="brand dialog-logo"><span class="brand-mark"><i></i><i></i><i></i><i></i></span><span><strong>栖音</strong><small>QIYIN MUSIC</small></span></div><h2>好音乐，本该自由。</h2><p>栖音是一款免费、无广告的音乐播放器。无需注册，不追踪你的收听习惯，也不上传你的音乐。</p><div class="dialog-features"><div class="dialog-feature"><strong>6</strong><span>原创演示曲目</span></div><div class="dialog-feature"><strong>0</strong><span>广告与订阅</span></div><div class="dialog-feature"><strong>∞</strong><span>本地自由畅听</span></div></div><p>内置曲目为本应用程序生成的原创合成音乐。你也可以导入自己合法拥有的音频：文件会复制到应用私有目录，重启后仍可离线播放，卸载应用时一并删除，栖音不会上传这些文件。</p><p>导入网易云歌单、搜索 CC 曲库与缓存歌曲时需要联网，其余时间完全离线。栖音只读取你主动粘贴的公开歌单，不登录账号；CC 音乐来自 Jamendo，请按许可保留作者署名。VIP 或付费曲目请前往官方客户端收听。</p><p class="dialog-foot">QIYIN MUSIC · VERSION 1.2 · MADE FOR YOUR MOMENT</p>`);
}
function showHelp() {
  openDialog(`<p class="eyebrow">LISTEN EFFORTLESSLY</p><h2>让播放更随心</h2><p>使用快捷键，不必打断正在做的事。</p><ul class="shortcut-list"><li><span>播放 / 暂停</span><kbd>Space</kbd></li><li><span>快进 / 后退 5 秒</span><span><kbd>←</kbd> <kbd>→</kbd></span></li><li><span>收藏当前歌曲</span><kbd>L</kbd></li><li><span>静音 / 恢复音量</span><kbd>M</kbd></li><li><span>聚焦搜索</span><kbd>⌘ / Ctrl K</kbd></li></ul><p class="dialog-foot">Android 设备可直接使用屏幕播放控件。</p>`);
}
function showTrackInfo(id) {
  const track = trackById(id);
  if (!track) return;
  const remove = track.persistent ? `<button class="ghost-button danger" data-local-delete="${escapeHTML(track.id)}">${icon('trash')} 删除本地文件</button>` : '';
  const footer = track.local ? (track.persistent ? 'LOCAL AUDIO · 已保存到本机' : 'LOCAL AUDIO · 仅当前会话') : track.cc ? 'CC LICENSED · 请保留作者署名' : track.remote ? 'NETEASE PLAYLIST · 在线或缓存播放' : 'QIYIN ORIGINAL · 原创合成音乐';
  openDialog(`<p class="eyebrow">TRACK DETAILS</p><h2>${escapeHTML(track.title)}</h2><p>${escapeHTML(track.artist)} · ${escapeHTML(track.genre)}${track.bpm ? ` · ${track.bpm} BPM` : ''}</p><p>${escapeHTML(track.description || '这是你从本机导入的音乐。栖音只在当前设备播放它，不会上传或收集文件信息。')}</p><button class="primary-button" data-dialog-play="${escapeHTML(track.id)}">${icon('play')} 播放这首音乐</button>${remove}<p class="dialog-foot">${footer}</p>`);
}

function requestNeteaseImport() {
  const bridge = nativeBridge();
  if (!bridge) { toast('请在栖音 App 内导入歌单'); return; }
  const text = state.neteaseInput.trim();
  if (!text) { toast('先粘贴网易云歌单分享链接'); return; }
  if (state.importing) return;
  state.importing = true;
  render();
  clearTimeout(requestNeteaseImport.timer);
  requestNeteaseImport.timer = setTimeout(() => {
    if (!state.importing) return;
    state.importing = false;
    render();
    toast('解析超时，请检查网络后重试');
  }, 30000);
  try {
    nativeBridge().resolvePlaylist(text);
  } catch (error) {
    state.importing = false;
    render();
    toast('无法调用歌单解析，请重启应用');
  }
}
function handlePlaylistResult(raw) {
  clearTimeout(requestNeteaseImport.timer);
  state.importing = false;
  let data;
  try { data = JSON.parse(raw); } catch { data = { ok: false, error: '返回数据异常' }; }
  if (!data.ok || !data.playlist) {
    render();
    toast(data.error || '歌单解析失败');
    return;
  }
  const source = data.playlist;
  const previous = new Map(state.netTracks.map(track => [track.id, track]));
  const tracks = (source.tracks || []).map(item => {
    const songId = String(item.id);
    const id = `ne-${songId}`;
    const old = previous.get(id);
    const remoteSrc = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
    const cached = Boolean(old && old.cached && old.src);
    return {
      id, neId: songId,
      title: item.title || '未知歌曲',
      en: '',
      artist: item.artist || '未知歌手',
      album: item.album || '',
      genre: '网易云',
      mood: 'net',
      moodLabel: '歌单',
      duration: Math.max(0, Math.round(Number(item.duration) || 0)),
      bpm: 0,
      vip: Boolean(item.vip),
      remoteSrc,
      src: cached ? old.src : remoteSrc,
      cached,
      art: artIndex(songId),
      playlistId: String(source.id),
      playlistName: source.name || '未命名歌单',
      remote: true,
      description: `来自网易云歌单「${source.name || '未命名歌单'}」。`
    };
  });
  if (!tracks.length) { render(); toast('这个歌单没有可读取的歌曲'); return; }
  const playlist = { id: String(source.id), name: source.name || '未命名歌单', cover: source.cover || '', importedAt: Date.now(), tracks };
  const index = state.playlists.findIndex(item => String(item.id) === playlist.id);
  if (index >= 0) state.playlists[index] = playlist; else state.playlists.unshift(playlist);
  state.lifePlaylistId = playlist.id;
  persistPlaylists();
  rebuildTracks();
  state.view = 'life';
  render();
  toast(`已导入「${playlist.name}」${tracks.length} 首`);
}
function deletePlaylist(id) {
  const playlist = state.playlists.find(item => String(item.id) === String(id));
  if (!playlist) return;
  openDialog(`<p class="eyebrow">REMOVE PLAYLIST</p><h2>删除「${escapeHTML(playlist.name)}」？</h2><p>只是从栖音移除这个歌单。已缓存的音频可以在「缓存」卡片里一键清空。</p><div class="dialog-actions"><button class="ghost-button" id="dialog-cancel">取消</button><button class="primary-button" data-pl-delete-confirm="${escapeHTML(id)}">确认删除</button></div>`);
}
function confirmDeletePlaylist(id) {
  state.playlists = state.playlists.filter(item => String(item.id) !== String(id));
  if (String(state.lifePlaylistId) === String(id)) state.lifePlaylistId = state.playlists[0] ? String(state.playlists[0].id) : '';
  persistPlaylists();
  rebuildTracks();
  $('#info-dialog').close();
  render();
  toast('歌单已删除');
}
function playPlaylist(id) {
  const playlist = state.playlists.find(item => String(item.id) === String(id));
  if (!playlist || !(playlist.tracks || []).length) { toast('这个歌单还没有歌曲'); return; }
  state.lifePlaylistId = String(playlist.id);
  playTrack(playlist.tracks[0].id);
}
function cacheTrack(id) {
  const track = trackById(id);
  if (!track || !track.remote) return;
  if (!nativeBridge()) { toast('缓存功能需在 App 内使用'); return; }
  if (track.cached || state.caching.has(id)) { toast('这首歌已缓存'); return; }
  const url = track.remoteSrc || track.src;
  if (!url || !String(url).startsWith('http')) { toast('这首歌没有可缓存的音频地址'); return; }
  state.caching.add(id);
  render();
  try {
    nativeBridge().downloadAudio(track.id, url);
  } catch (error) {
    state.caching.delete(id);
    render();
    toast('无法开始缓存，请重启应用');
  }
}
function addToCcPlaylist(track) {
  let playlist = state.playlists.find(item => String(item.id) === 'cc');
  if (!playlist) {
    playlist = { id: 'cc', name: 'CC 免费曲库', cover: '', importedAt: Date.now(), tracks: [] };
    state.playlists.unshift(playlist);
  }
  const copy = { ...track, remote: true, cc: true, playlistId: 'cc', playlistName: playlist.name };
  const index = playlist.tracks.findIndex(item => item.id === track.id);
  if (index >= 0) playlist.tracks[index] = copy; else playlist.tracks.push(copy);
  state.lifePlaylistId = 'cc';
}
function handleCachedResult(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  const id = data.key || (data.songId ? `ne-${data.songId}` : '');
  if (!id) return;
  state.caching.delete(id);
  if (!data.ok) {
    render();
    toast(data.error || '缓存失败，请稍后重试');
    return;
  }
  const track = trackById(id);
  if (track) {
    track.cached = true;
    track.src = data.path;
    if (track.cc) addToCcPlaylist(track);
  }
  state.ccResults.forEach(item => {
    if (item.id === id) { item.cached = true; item.src = data.path; }
  });
  persistPlaylists();
  rebuildTracks();
  render();
  toast('已缓存，可离线播放');
}
function clearSongCache() {
  const bridge = nativeBridge();
  if (!bridge) { toast('缓存功能需在 App 内使用'); return; }
  try { bridge.clearCache(); } catch (error) { toast('清空缓存失败'); return; }
  state.playlists.forEach(playlist => (playlist.tracks || []).forEach(track => {
    if (track.cached) { track.cached = false; track.src = track.remoteSrc; }
  }));
  state.ccTracks.forEach(track => {
    if (track.cached) { track.cached = false; track.src = track.remoteSrc || track.src; }
  });
  state.ccResults.forEach(track => {
    if (track.cached) { track.cached = false; track.src = track.remoteSrc || track.src; }
  });
  persistPlaylists();
  rebuildTracks();
  render();
  toast('缓存已清空');
}
function startLocalImport() {
  const bridge = nativeBridge();
  if (bridge && typeof bridge.importAudio === 'function') {
    try { bridge.importAudio(); return; } catch (error) { /* 回退到网页文件选择器 */ }
  }
  fileInput.click();
}
function handleImported(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { toast('导入失败，文件无法读取'); return; }
  const list = (data && data.tracks) || [];
  if (!data || !data.ok || !list.length) {
    toast((data && data.error) || '没有导入任何音频');
    return;
  }
  let added = 0;
  list.forEach(item => {
    if (!item || !item.src || !item.id) return;
    if (state.localTracks.some(track => track.id === item.id)) return;
    state.localTracks.push({
      id: item.id,
      title: item.title || '本地音频',
      en: item.title || '本地音频',
      artist: item.artist || '本地导入',
      genre: '本地文件',
      mood: 'local',
      moodLabel: '本地',
      duration: Number(item.duration) || 0,
      size: Number(item.size) || 0,
      src: item.src,
      local: true,
      persistent: true,
      art: artIndex(item.id),
      description: '已复制到栖音的应用私有目录，重启后仍可离线播放；卸载应用会一并删除。'
    });
    added += 1;
  });
  persistLocalTracks();
  rebuildTracks();
  state.view = 'library';
  state.search = '';
  searchInput.value = '';
  render();
  toast(added ? `已保存 ${added} 首本地音乐` : '这些音乐已经在曲库里了');
}
function deleteLocalTrack(id) {
  const index = state.localTracks.findIndex(track => track.id === id);
  if (index < 0) return;
  const track = state.localTracks[index];
  const bridge = nativeBridge();
  if (bridge && typeof bridge.deleteAudio === 'function' && track.src) {
    try { bridge.deleteAudio(track.src); } catch (error) { /* 文件可能已被系统清理 */ }
  }
  state.localTracks.splice(index, 1);
  persistLocalTracks();
  const wasCurrent = state.currentId === id;
  rebuildTracks();
  $('#info-dialog').close();
  if (wasCurrent) {
    audio.pause();
    audio.src = currentTrack().src;
    audio.load();
    updateNowPlaying();
  }
  render();
  toast('已删除本地音乐');
}
function saveCcKey() {
  const value = state.ccInput.trim();
  if (!value) { toast('先填写 Jamendo Client ID'); return; }
  state.ccKey = value;
  localStorage.setItem('qiyin-jamendo-key', JSON.stringify(value));
  render();
  toast('Client ID 已保存');
}
function resetCcKey() {
  state.ccKey = '';
  state.ccResults = [];
  state.ccTracks = [];
  state.ccError = '';
  localStorage.removeItem('qiyin-jamendo-key');
  rebuildTracks();
  render();
  toast('已清除 Client ID');
}
function searchCc() {
  const bridge = nativeBridge();
  if (!bridge || typeof bridge.searchCc !== 'function') { toast('请在栖音 App 内搜索 CC 音乐'); return; }
  if (!state.ccKey) { toast('先填写 Jamendo Client ID'); return; }
  if (state.ccLoading) return;
  state.ccLoading = true;
  state.ccError = '';
  render();
  try {
    bridge.searchCc(state.ccKey, state.ccQuery.trim());
  } catch (error) {
    state.ccLoading = false;
    render();
    toast('无法开始搜索，请重启应用');
  }
}
function handleCcResults(raw) {
  state.ccLoading = false;
  let data;
  try { data = JSON.parse(raw); } catch { state.ccError = '搜索结果解析失败'; render(); return; }
  if (!data.ok) {
    state.ccError = data.error || '搜索失败，请稍后重试';
    render();
    toast(state.ccError);
    return;
  }
  state.ccResults = (data.tracks || []).map(ccTrackFrom);
  state.ccTracks = state.ccResults.slice();
  rebuildTracks();
  render();
  if (!state.ccResults.length) toast('没有找到 CC 音乐');
}
function setFont(value) {
  state.font = value;
  applyFont();
  render();
  toast(value === 'small' ? '字体已调小' : value === 'large' ? '字体已调大' : '字体已恢复标准');
}
window.QiyinNativeCallback = {
  onPlaylist(raw) { handlePlaylistResult(raw); },
  onCached(raw) { handleCachedResult(raw); },
  onImported(raw) { handleImported(raw); },
  onCcResults(raw) { handleCcResults(raw); }
};

main.addEventListener('click', event => {
  const play = event.target.closest('[data-play-id]');
  const like = event.target.closest('[data-like-id]');
  const view = event.target.closest('[data-view]');
  const filter = event.target.closest('[data-filter]');
  const info = event.target.closest('[data-info-id]');
  const cacheButton = event.target.closest('[data-cache-id]');
  const plOpen = event.target.closest('[data-pl-open]');
  const plPlay = event.target.closest('[data-pl-play]');
  const plDelete = event.target.closest('[data-pl-delete]');
  const reqPlay = event.target.closest('[data-req-play]');
  const font = event.target.closest('[data-font-set]');
  const lifeRow = event.target.closest('[data-life-row]');
  if (event.target.closest('#netease-import')) { requestNeteaseImport(); return; }
  if (event.target.closest('#clear-cache')) { clearSongCache(); return; }
  if (event.target.closest('#cc-key-save')) { saveCcKey(); return; }
  if (event.target.closest('#cc-key-reset')) { resetCcKey(); return; }
  if (event.target.closest('#cc-search')) { searchCc(); return; }
  if (cacheButton) { cacheTrack(cacheButton.dataset.cacheId); return; }
  if (plOpen) { state.lifePlaylistId = plOpen.dataset.plOpen; render(); return; }
  if (plPlay) { playPlaylist(plPlay.dataset.plPlay); return; }
  if (plDelete) { deletePlaylist(plDelete.dataset.plDelete); return; }
  if (reqPlay) { playTrack(reqPlay.dataset.reqPlay); return; }
  if (font) { setFont(font.dataset.fontSet); return; }
  if (lifeRow && !event.target.closest('button')) { playTrack(lifeRow.dataset.lifeRow); return; }
  if (play) playTrack(play.dataset.playId);
  else if (like) toggleFavorite(like.dataset.likeId);
  else if (view) setView(view.dataset.view);
  else if (filter) { state.filter = filter.dataset.filter; render(); }
  else if (info) showTrackInfo(info.dataset.infoId);
  else if (event.target.closest('[data-import]')) startLocalImport();
  else {
    const art = event.target.closest('.track-art');
    if (art) playTrack(art.closest('[data-row-id]').dataset.rowId);
  }
});
document.addEventListener('click', event => {
  const view = event.target.closest('.sidebar [data-view], .mobile-brand[data-view], .mobile-tabs [data-view]');
  if (view) { event.preventDefault(); setView(view.dataset.view); }
  const dialogPlay = event.target.closest('[data-dialog-play]');
  if (dialogPlay) { $('#info-dialog').close(); playTrack(dialogPlay.dataset.dialogPlay); }
  const confirmDelete = event.target.closest('[data-pl-delete-confirm]');
  if (confirmDelete) confirmDeletePlaylist(confirmDelete.dataset.plDeleteConfirm);
  const localDelete = event.target.closest('[data-local-delete]');
  if (localDelete) deleteLocalTrack(localDelete.dataset.localDelete);
  if (event.target.closest('#dialog-cancel')) $('#info-dialog').close();
});
document.addEventListener('input', event => {
  if (event.target.id === 'netease-input') {
    state.neteaseInput = event.target.value;
    const button = $('#netease-import');
    if (button) button.disabled = !nativeBridge() || !state.neteaseInput.trim() || state.importing;
  }
  if (event.target.id === 'request-input') {
    state.requestQuery = event.target.value;
    const results = $('#request-results');
    if (results) results.innerHTML = requestResultsMarkup();
  }
  if (event.target.id === 'cc-key-input') state.ccInput = event.target.value;
  if (event.target.id === 'cc-input') state.ccQuery = event.target.value;
});
document.addEventListener('keydown', event => {
  if (event.target.id === 'netease-input' && event.key === 'Enter') {
    event.preventDefault();
    requestNeteaseImport();
  }
  if (event.target.id === 'cc-key-input' && event.key === 'Enter') {
    event.preventDefault();
    saveCcKey();
  }
  if (event.target.id === 'cc-input' && event.key === 'Enter') {
    event.preventDefault();
    searchCc();
  }
});
$('#queue-list').addEventListener('click', event => {
  const item = event.target.closest('[data-queue-id]');
  if (item) playTrack(item.dataset.queueId);
});
$('#queue-panel').addEventListener('click', event => {
  if (event.target.closest('#art-play')) togglePlayback();
  if (event.target.closest('#now-like')) toggleFavorite(state.currentId);
});
$('#play-button').addEventListener('click', togglePlayback);
$('#player-like').addEventListener('click', () => toggleFavorite(state.currentId));
$('#next-button').addEventListener('click', () => playNext());
$('#prev-button').addEventListener('click', playPrevious);
$('#shuffle-button').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  $('#shuffle-button').classList.toggle('active', state.shuffle);
  localStorage.setItem('qiyin-shuffle', JSON.stringify(state.shuffle));
  toast(state.shuffle ? '已开启随机播放' : '已关闭随机播放');
});
$('#repeat-button').addEventListener('click', () => {
  state.repeat = (state.repeat + 1) % 3;
  audio.loop = state.repeat === 2;
  const button = $('#repeat-button');
  button.classList.toggle('active', state.repeat > 0);
  button.classList.toggle('repeat-one', state.repeat === 2);
  localStorage.setItem('qiyin-repeat', JSON.stringify(state.repeat));
  toast(['已关闭循环播放', '已开启列表循环', '已开启单曲循环'][state.repeat]);
});
$('#progress').addEventListener('input', event => {
  if (Number.isFinite(audio.duration)) audio.currentTime = (Number(event.target.value) / 1000) * audio.duration;
  updateProgress();
});
$('#volume').addEventListener('input', event => setVolume(Number(event.target.value) / 100));
$('#mute-button').addEventListener('click', toggleMute);
$('#queue-button').addEventListener('click', toggleQueue);
$('#close-queue').addEventListener('click', toggleQueue);
$('#import-button').addEventListener('click', startLocalImport);
$('#open-about').addEventListener('click', showAbout);
$('#help-button').addEventListener('click', showHelp);
$('#dialog-close').addEventListener('click', () => $('#info-dialog').close());
$('#info-dialog').addEventListener('click', event => {
  if (event.target === $('#info-dialog')) $('#info-dialog').close();
});
searchInput.addEventListener('input', () => { state.search = searchInput.value.trim(); render(); });
searchInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') { searchInput.value = ''; state.search = ''; searchInput.blur(); render(); }
});
fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  let added = 0;
  files.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    const id = `local-${Date.now()}-${index}`;
    const track = { id, title: file.name.replace(/\.[^.]+$/, ''), en: file.name.replace(/\.[^.]+$/, ''), artist: '本地音乐', genre: '我的导入', mood: 'local', moodLabel: '本地', duration: 0, src: url, art: (state.tracks.length + index) % 7, local: true };
    state.sessionTracks.push(track);
    added += 1;
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.src = url;
    probe.addEventListener('loadedmetadata', () => {
      track.duration = probe.duration;
      const duration = document.querySelector(`[data-duration-id="${id}"]`);
      if (duration) duration.textContent = formatTime(track.duration);
      renderQueue();
    }, { once: true });
  });
  if (added) {
    rebuildTracks();
    state.view = 'library';
    state.search = '';
    searchInput.value = '';
    render();
    toast(`已导入 ${added} 首音乐，仅保存在本次会话`);
  }
  fileInput.value = '';
});

audio.addEventListener('play', () => { updatePlaybackUI(); render(); });
audio.addEventListener('pause', () => { updatePlaybackUI(); render(); });
audio.addEventListener('ended', () => playNext(true));
audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('loadedmetadata', () => {
  const track = currentTrack();
  if (Number.isFinite(audio.duration)) track.duration = audio.duration;
  updateProgress();
  renderQueue();
});
audio.addEventListener('error', () => {
  const track = currentTrack();
  if (track && track.remote && track.cached && track.remoteSrc && audio.src !== track.remoteSrc) {
    track.cached = false;
    track.src = track.remoteSrc;
    audio.src = track.remoteSrc;
    persistPlaylists();
    toast('缓存文件已失效，已切换在线播放');
    return;
  }
  if (audio.src) toast('音频加载失败，请确认文件格式受支持');
});
audio.loop = state.repeat === 2;
audio.volume = state.volume;
$('#shuffle-button').classList.toggle('active', state.shuffle);
$('#repeat-button').classList.toggle('active', state.repeat > 0);
$('#repeat-button').classList.toggle('repeat-one', state.repeat === 2);

for (let i = 0; i < 42; i += 1) {
  const bar = document.createElement('i');
  bar.style.height = `${6 + ((Math.sin(i * 1.8) + 1) * 11) + (i % 5) * 1.3}px`;
  bar.style.setProperty('--n', i);
  $('#waveform').appendChild(bar);
}
setVolume(state.volume);
pruneMissingFiles();
rebuildTracks();
applyFont();
audio.src = currentTrack().src;
audio.load();
updateNowPlaying();
render();

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', startPlayback);
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', playPrevious);
  navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
}
document.addEventListener('keydown', event => {
  if (event.target.matches('input, textarea') || $('#info-dialog').open) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); searchInput.focus(); return;
  }
  if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
  else if (event.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
  else if (event.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  else if (event.key.toLowerCase() === 'm') toggleMute();
  else if (event.key.toLowerCase() === 'l') toggleFavorite(state.currentId);
});
window.addEventListener('beforeunload', () => state.tracks.filter(track => track.local).forEach(track => URL.revokeObjectURL(track.src)));
