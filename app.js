/* ═══════════════════════════════════════════════════════════════
   BUMBLE FOTO — App Logic (Standalone / GitHub Pages)
   Uses the File System Access API — no server required.
   Works in Chrome and Edge.
   ═══════════════════════════════════════════════════════════════ */

// ─── Supported image extensions (browser-displayable) ──────────

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'svg',
]);

// ─── State ─────────────────────────────────────────────────────

const state = {
  screen: 'folder',
  dirHandle: null,            // FileSystemDirectoryHandle (chosen folder)
  trashHandle: null,          // FileSystemDirectoryHandle (_trash subfolder)
  keptHandle: null,           // FileSystemDirectoryHandle (_kept subfolder)
  groupsHandle: null,         // FileSystemDirectoryHandle (_groups subfolder)
  photos: [],                 // [{ name, handle }]
  currentIndex: 0,
  group: [],                  // [{ name, handle }] — photos being grouped
  isGrouping: false,
  undoStack: [],              // [{ type, entry, index, trashed?, groupStartIndex?, folderName?, entries? }]
  stats: { kept: 0, trashed: 0, grouped: 0 },
  isAnimating: false,
  isDragging: false,
  dragStartX: 0,
  dragDeltaX: 0,
  currentObjectUrl: null,     // For memory cleanup
  nextObjectUrl: null,
  prevObjectUrl: null,
  selectedPhotos: new Set(),  // Set of names for group modal multi-select
  sideBySide: false,
  galleryType: null,
  gallerySelected: new Set(),
  activeSavedGroupHandle: null,
  activeSavedGroupName: null,
  
  // Stats
  allStatsData: [],
  statsFilters: { date: null, camera: null, bounds: null },
  _ignoreMapEvents: false,
};

// ─── Settings ──────────────────────────────────────────────────

// Default Settings
const defaultSettings = {
  dHashSim: 71,
  histSim: 75,
  blurThreshold: 80,
  darkThreshold: 50,
  brightThreshold: 215
};

state.settings = { ...defaultSettings };

// Load from LocalStorage
try {
  const saved = localStorage.getItem('bumblefoto_settings');
  if (saved) {
    const parsed = JSON.parse(saved);
    state.settings = { ...defaultSettings, ...parsed };
  }
} catch (e) {}

// Keep backward compat for analyzer.js which reads window.AppSettings
window.AppSettings = state.settings;

function saveSettings() {
  localStorage.setItem('bumblefoto_settings', JSON.stringify(state.settings));
}

// ─── DOM Helpers ───────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// ─── Initialisation ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  checkBrowserSupport();
  setupEventListeners();
  setupKeyboardShortcuts();
  setupSwipeGestures();
});

/**
 * Check if the browser supports the File System Access API.
 * Show a warning and disable the folder picker if not.
 */
function checkBrowserSupport() {
  if (!('showDirectoryPicker' in window)) {
    $('browser-warning').classList.add('visible');
    $('pick-folder-btn').disabled = true;
    $('pick-folder-btn').style.opacity = '0.5';
    $('pick-folder-btn').style.cursor = 'not-allowed';
  }
}

// ─── Screen Management ─────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(name + '-screen').classList.add('active');
  state.screen = name;
}

// ═══════════════════════════════════════════════════════════════
// FOLDER SELECTION — File System Access API
// ═══════════════════════════════════════════════════════════════

/**
 * Open the native folder picker dialog.
 */
async function pickFolder() {
  try {
    state.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

    // Show selected folder name
    $('selected-folder').textContent = '📁 ' + state.dirHandle.name;
    $('selected-folder').classList.add('visible');
    $('start-btn').style.display = '';
    $('folder-error').textContent = '';
  } catch (err) {
    // User cancelled the dialog — ignore AbortError
    if (err.name !== 'AbortError') {
      $('folder-error').textContent = 'Erro ao selecionar pasta: ' + err.message;
    }
  }
}

/**
 * Scan the selected folder for images and start the session.
 */
async function startSession() {
  if (!state.dirHandle) {
    $('folder-error').textContent = 'Seleciona uma pasta primeiro';
    return;
  }

  $('folder-error').textContent = '';

  try {
    // Create _trash, _kept, and _groups directories inside the chosen folder
    state.trashHandle = await state.dirHandle.getDirectoryHandle('_trash', { create: true });
    state.keptHandle = await state.dirHandle.getDirectoryHandle('_kept', { create: true });
    state.groupsHandle = await state.dirHandle.getDirectoryHandle('_groups', { create: true });

    let trashedCount = 0;
    for await (const entry of state.trashHandle.keys()) trashedCount++;
    
    let keptCount = 0;
    for await (const entry of state.keptHandle.keys()) keptCount++;

    let groupedCount = 0;
    for await (const entry of state.groupsHandle.keys()) groupedCount++;

    // Scan for image files
    const photos = [];
    state.videoBasenames = new Set();
    
    for await (const [name, handle] of state.dirHandle.entries()) {
      if (handle.kind !== 'file') continue;
      if (name.startsWith('.')) continue;

      const ext = name.split('.').pop().toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        photos.push({ name, handle });
      } else if (ext === 'mov' || ext === 'mp4') {
        const basename = name.substring(0, name.lastIndexOf('.')).toLowerCase();
        state.videoBasenames.add(basename);
      }
    }

    // Sort by filename (natural sort: IMG_2 before IMG_10)
    photos.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );

    // Reset state
    state.photos = photos;
    state.currentIndex = 0;
    state.stats = { kept: keptCount, trashed: trashedCount, grouped: groupedCount };
    state.undoStack = [];
    state.group = [];
    state.isGrouping = false;
    state.selectedPhotos = new Set();

    updateControlsUI();
    showScreen('swipe');
    renderPhoto();
  } catch (err) {
    $('folder-error').textContent = 'Erro: ' + err.message;
  }
}

// ═══════════════════════════════════════════════════════════════
// FILE OPERATIONS — File System Access API
// ═══════════════════════════════════════════════════════════════

/**
 * Create an object URL from a FileSystemFileHandle.
 * Remember to revoke the URL when no longer needed.
 */
async function createObjectUrl(fileHandle) {
  const file = await fileHandle.getFile();
  return URL.createObjectURL(file);
}

/**
 * Generic file move function.
 */
async function moveFileTo(fileHandle, filename, destDirHandle, sourceDirHandle = state.dirHandle) {
  try {
    if (typeof fileHandle.move === 'function') {
      await fileHandle.move(destDirHandle);
      return;
    }
  } catch { /* fallback */ }

  const file = await fileHandle.getFile();
  const newHandle = await destDirHandle.getFileHandle(filename, { create: true });
  const writable = await newHandle.createWritable();
  await writable.write(file);
  await writable.close();
  await sourceDirHandle.removeEntry(filename);
}

/**
 * Move a file to the _trash directory.
 */
async function trashFile(fileHandle, filename) {
  await moveFileTo(fileHandle, filename, state.trashHandle);
}

/**
 * Move a file to the _kept directory.
 */
async function keepFile(fileHandle, filename) {
  await moveFileTo(fileHandle, filename, state.keptHandle);
}

/**
 * Restore a file from a subdirectory (_trash or _kept) back to the main directory.
 */
async function restoreFile(filename, sourceHandle) {
  const fileHandle = await sourceHandle.getFileHandle(filename);
  await moveFileTo(fileHandle, filename, state.dirHandle, sourceHandle);
  return await state.dirHandle.getFileHandle(filename);
}

// ═══════════════════════════════════════════════════════════════
// PHOTO RENDERING
// ═══════════════════════════════════════════════════════════════

/**
 * Compare two images for structural and color similarity.
 * Returns { dHashSim, histSim, isSimilar }
 */
async function computeSimilarity(img1, img2) {
  let dHashSim = 0;
  let histSim = 0;

  if (typeof ImageAnalyzer === 'undefined') return { dHashSim, histSim, isSimilar: false };

  if (ImageAnalyzer.computeDHash) {
    const dHash1 = await ImageAnalyzer.computeDHash(img1);
    const dHash2 = await ImageAnalyzer.computeDHash(img2);
    if (dHash1 && dHash2) dHashSim = ImageAnalyzer.compareHashes(dHash1, dHash2);
  }

  if (ImageAnalyzer.computeColorHistogram) {
    const hist1 = await ImageAnalyzer.computeColorHistogram(img1);
    const hist2 = await ImageAnalyzer.computeColorHistogram(img2);
    if (hist1 && hist2) histSim = ImageAnalyzer.compareHistograms(hist1, hist2);
  }

  const settings = state.settings || window.AppSettings;
  const isSimilar = dHashSim >= settings.dHashSim || histSim >= settings.histSim;

  return { dHashSim, histSim, isSimilar };
}

/**
 * Render the current photo and update all UI elements.
 */
async function renderPhoto() {
  // Handle empty folder state
  if (state.photos.length === 0) {
    $('photo-card').style.display = 'none';
    $('controls-bar').style.display = 'none';
    const emptyState = $('empty-folder-state');
    if (emptyState) emptyState.style.display = 'flex';
    
    $('photo-counter').textContent = '0 / 0';
    $('stat-kept-count').textContent = state.stats.kept || 0;
    $('stat-trashed-count').textContent = state.stats.trashed || 0;
    $('stat-grouped-count').textContent = state.stats.grouped || 0;
    $('progress-fill').style.width = '100%';
    
    // Clear any previous previews
    if ($('next-preview')) $('next-preview').classList.remove('visible');
    if ($('prev-preview')) $('prev-preview').classList.remove('visible');
    return;
  } else {
    $('photo-card').style.display = '';
    $('controls-bar').style.display = '';
    const emptyState = $('empty-folder-state');
    if (emptyState) emptyState.style.display = 'none';
  }

  // Reached the end?
  if (state.currentIndex >= state.photos.length) {
    if (state.isGrouping && state.group.length > 0) {
      endGrouping();
      return;
    }
    showDoneScreen();
    return;
  }

  const entry = state.photos[state.currentIndex];

  // Clear previous group alert
  $('photo-card').classList.remove('current-group-alert');

  // Show loading spinner
  $('photo-loading').classList.remove('hidden');

  // Revoke previous URL to free memory
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
    state.currentObjectUrl = null;
  }

  // Load the image
  try {
    const url = await createObjectUrl(entry.handle);
    state.currentObjectUrl = url;

    const img = $('current-photo');
    const tagsContainer = $('quality-tags');
    if (tagsContainer) tagsContainer.innerHTML = ''; // Clear previous tags

    img.onload = async () => {
      $('photo-loading').classList.add('hidden');
      
      // Automatic Image Quality Analysis
      if (typeof ImageAnalyzer !== 'undefined' && tagsContainer) {
        try {
          const tags = await ImageAnalyzer.analyze(img);
          tags.forEach((tag, index) => {
            const el = document.createElement('div');
            el.className = `quality-tag ${tag.type}`;
            el.innerHTML = `<span>${tag.icon}</span> <span>${tag.text}</span>`;
            el.style.animationDelay = `${index * 0.15 + 0.1}s`;
            tagsContainer.appendChild(el);
          });
        } catch (e) {
          console.error('Image analysis error:', e);
        }
      }

      // Grouping similarity detection
      if (state.isGrouping && state.group.length > 0) {
        try {
          const prevEntry = state.group[state.group.length - 1];
          const prevUrl = await createObjectUrl(prevEntry.handle);
          const prevImg = new Image();
          
          prevImg.onload = async () => {
            const { isSimilar } = await computeSimilarity(prevImg, img);
            if (isSimilar) {
              $('photo-card').classList.add('current-group-alert');
            }
            URL.revokeObjectURL(prevUrl);
          };
          prevImg.src = prevUrl;
        } catch (e) {
          console.error('Similarity group error:', e);
        }
      }
    };

    img.onerror = () => {
      $('photo-loading').classList.add('hidden');
      showToast('Erro ao carregar: ' + entry.name, 'error');
    };
    img.src = url;
  } catch (err) {
    $('photo-loading').classList.add('hidden');
    showToast('Erro: ' + err.message, 'error');
  }

  // Update text elements
  $('photo-filename').textContent = entry.name;

  // Motion Photo Detection
  const nameUpper = entry.name.toUpperCase();
  const basename = entry.name.substring(0, entry.name.lastIndexOf('.')).toLowerCase();
  
  let isMotionPhoto = false;
  
  // 1. Check for Apple Live Photo sidecar (.mov or .mp4)
  if (state.videoBasenames && state.videoBasenames.has(basename)) {
    isMotionPhoto = true;
  }
  // 2. Check filename conventions for Google Pixel / Samsung
  else if (nameUpper.startsWith('MVIMG_') || nameUpper.includes('MP.JPG') || nameUpper.includes('_MP')) {
    isMotionPhoto = true;
  }
  // 3. Fallback: Deep inspection of XMP metadata in first 128KB
  else {
    try {
      const file = await entry.handle.getFile();
      const slice = file.slice(0, 131072);
      const buffer = await slice.arrayBuffer();
      const decoder = new TextDecoder('iso-8859-1'); 
      const text = decoder.decode(buffer);
      
      if (text.includes('GCamera:MotionPhoto="1"') || 
          text.includes('GCamera:MicroVideo="1"') || 
          text.includes('MicroVideo>1<') ||
          text.includes('Item:Mime="video/mp4"')) {
        isMotionPhoto = true;
      }
    } catch (e) {
      // ignore
    }
  }

  const mpIndicator = $('motion-photo-indicator');
  if (mpIndicator) {
    if (isMotionPhoto) mpIndicator.classList.add('visible');
    else mpIndicator.classList.remove('visible');
  }

  $('photo-counter').textContent = (state.currentIndex + 1) + ' / ' + state.photos.length;
  $('stat-kept-count').textContent = state.stats.kept;
  $('stat-trashed-count').textContent = state.stats.trashed;
  $('stat-grouped-count').textContent = state.stats.grouped;

  // Progress bar
  $('progress-fill').style.width = ((state.currentIndex / state.photos.length) * 100) + '%';

  // Photo previews (next or prev)
  renderPreviews();

  // Group indicator
  updateGroupIndicator();

  // Card entrance animation
  const card = $('photo-card');
  card.classList.remove('exit-left', 'exit-right', 'exit-group');
  card.classList.add('entering');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => card.classList.remove('entering'));
  });
}

/**
 * Render the next/prev photo previews depending on mode.
 */
async function renderPreviews() {
  const nextIdx = state.currentIndex + 1;
  const preview = $('next-preview');
  const prevPreview = $('prev-preview');

  // Revoke previous URLs
  if (state.nextObjectUrl) {
    URL.revokeObjectURL(state.nextObjectUrl);
    state.nextObjectUrl = null;
  }
  if (state.prevObjectUrl) {
    URL.revokeObjectURL(state.prevObjectUrl);
    state.prevObjectUrl = null;
  }

  const btnGroup = $('btn-group');
  if (btnGroup) btnGroup.classList.remove('similar-pulse');

  if (state.isGrouping) {
    preview.classList.remove('visible');
    preview.classList.remove('similar-alert');
    
    if (state.group.length > 0 && prevPreview) {
      try {
        const prevEntry = state.group[state.group.length - 1];
        const url = await createObjectUrl(prevEntry.handle);
        state.prevObjectUrl = url;
        $('prev-photo').src = url;
        $('side-photo').src = url; // Update side-by-side
        prevPreview.classList.add('visible');
      } catch {
        prevPreview.classList.remove('visible');
      }
    } else if (prevPreview) {
      prevPreview.classList.remove('visible');
    }
  } else {
    if (prevPreview) prevPreview.classList.remove('visible');
    
    if (nextIdx < state.photos.length) {
      try {
        const url = await createObjectUrl(state.photos[nextIdx].handle);
        state.nextObjectUrl = url;
        preview.classList.remove('similar-alert');
        
        const nextImg = $('next-photo');
        nextImg.src = url;
        $('side-photo').src = url; // Update side-by-side
        preview.classList.add('visible');

        // Detect similarity once next image loads
        nextImg.onload = async () => {
          try {
            const currentImg = $('current-photo');
            const { isSimilar } = await computeSimilarity(currentImg, nextImg);
            if (isSimilar) {
              preview.classList.add('similar-alert');
              if (btnGroup) btnGroup.classList.add('similar-pulse');
            }
          } catch (e) {}
        };
      } catch {
        preview.classList.remove('visible');
        preview.classList.remove('similar-alert');
      }
    } else {
      preview.classList.remove('visible');
      preview.classList.remove('similar-alert');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ACTIONS — Keep, Trash, Group, Undo
// ═══════════════════════════════════════════════════════════════

/**
 * Keep the current photo (swipe right / → / D).
 */
async function handleKeep() {
  if (state.screen !== 'swipe' || state.isAnimating) return;
  if (state.isGrouping) return; // Disabled during grouping

  disableSideBySide();

  const entry = state.photos[state.currentIndex];

  try {
    await keepFile(entry.handle, entry.name);
  } catch (err) {
    showToast('Erro ao guardar: ' + err.message, 'error');
    return;
  }

  state.stats.kept++;
  state.undoStack.push({ type: 'keep', entry, index: state.currentIndex });

  // Remove from list (don't increment index — array shrinks)
  state.photos.splice(state.currentIndex, 1);

  await animateExit('right');
  renderPhoto();
}

/**
 * Trash the current photo (swipe left / ← / A).
 * Moves the file to the _trash subdirectory.
 */
async function handleTrash() {
  if (state.screen !== 'swipe' || state.isAnimating) return;
  if (state.isGrouping) return; // Disabled during grouping

  disableSideBySide();

  const entry = state.photos[state.currentIndex];

  try {
    await trashFile(entry.handle, entry.name);
  } catch (err) {
    showToast('Erro ao apagar: ' + err.message, 'error');
    return;
  }

  state.stats.trashed++;
  state.undoStack.push({ type: 'trash', entry, index: state.currentIndex });

  // Remove from list (don't increment index — array shrinks)
  state.photos.splice(state.currentIndex, 1);

  await animateExit('left');
  renderPhoto();
}

/**
 * Add the current photo to a duplicate group (M key).
 * Keep pressing M to add more. Any other key ends grouping.
 */
async function handleGroup() {
  if (state.screen !== 'swipe' || state.isAnimating) return;
  if (state.currentIndex >= state.photos.length) return;

  disableSideBySide();

  const entry = state.photos[state.currentIndex];

  if (!state.isGrouping) {
    state.isGrouping = true;
    state.group = [];
    updateControlsUI();
  }

  state.group.push(entry);
  state.undoStack.push({ type: 'grouping', index: state.currentIndex });
  updateGroupIndicator();

  await animateExit('group');
  state.currentIndex++;

  // If no more photos, end grouping automatically
  if (state.currentIndex >= state.photos.length) {
    endGrouping();
    return;
  }

  renderPhoto();
}

/**
 * End the grouping phase and open the group selection modal.
 */
function endGrouping() {
  if (!state.isGrouping) return;
  state.isGrouping = false;
  updateControlsUI();
  updateGroupIndicator();

  if (state.group.length === 0) {
    renderPhoto();
    return;
  }

  // Open selection modal
  showGroupModal();
}

/**
 * Undo the last action.
 */
async function handleUndo() {
  if (state.undoStack.length === 0) {
    showToast('Nada para desfazer', 'info');
    return;
  }

  const last = state.undoStack.pop();

  if (last.type === 'grouping') {
    if (state.group.length > 0) {
      state.group.pop();
      state.currentIndex = last.index;
      state.isGrouping = true; // Volta a activar o modo de agrupamento
      
      if (state.group.length === 0) {
        state.isGrouping = false;
      }
      
      updateControlsUI();
      updateGroupIndicator();
      showToast('Desagrupada', 'info');
      renderPhoto();
    }
    return;
  }

  if (last.type === 'trash') {
    try {
      const restoredHandle = await restoreFile(last.entry.name, state.trashHandle);
      state.photos.splice(last.index, 0, { name: last.entry.name, handle: restoredHandle });
      state.currentIndex = last.index;
      state.stats.trashed--;
      showToast('Restaurada: ' + last.entry.name, 'success');
      renderPhoto();
    } catch (err) {
      showToast('Erro ao desfazer: ' + err.message, 'error');
    }

  } else if (last.type === 'keep') {
    try {
      const restoredHandle = await restoreFile(last.entry.name, state.keptHandle);
      state.photos.splice(last.index, 0, { name: last.entry.name, handle: restoredHandle });
      state.currentIndex = last.index;
      state.stats.kept--;
      showToast('Voltando a: ' + last.entry.name, 'info');
      renderPhoto();
    } catch (err) {
      showToast('Erro ao desfazer: ' + err.message, 'error');
    }

  } else if (last.type === 'group') {
    try {
      // Restore all trashed photos from the group
      for (const entry of last.trashed) {
        const restoredHandle = await restoreFile(entry.name, state.trashHandle);
        state.photos.push({ name: entry.name, handle: restoredHandle });
      }
      // Restore all kept photos from the group
      for (const entry of last.kept) {
        const restoredHandle = await restoreFile(entry.name, state.keptHandle);
        state.photos.push({ name: entry.name, handle: restoredHandle });
      }
      // Re-sort to restore original order
      state.photos.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
      state.currentIndex = last.groupStartIndex;
      state.stats.trashed -= last.trashed.length;
      state.stats.kept -= last.kept.length;
      showToast('Grupo desfeito', 'success');
      renderPhoto();
    } catch (err) {
      showToast('Erro ao desfazer grupo: ' + err.message, 'error');
    }

  } else if (last.type === 'group_later') {
    try {
      const groupHandle = await state.groupsHandle.getDirectoryHandle(last.folderName);
      for (const entry of last.entries) {
        const restoredHandle = await restoreFile(entry.name, groupHandle);
        state.photos.push({ name: entry.name, handle: restoredHandle });
      }
      await state.groupsHandle.removeEntry(last.folderName, { recursive: true });
      
      state.photos.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
      state.currentIndex = last.groupStartIndex;
      state.stats.grouped--;
      showToast('Grupo recuperado', 'success');
      renderPhoto();
    } catch (err) {
      showToast('Erro ao desfazer grupo: ' + err.message, 'error');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// GROUP SELECTION MODAL
// ═══════════════════════════════════════════════════════════════

async function renderGroupGrid() {
  const grid = $('group-grid');
  grid.innerHTML = '';
  const btnDelete = $('btn-delete-selected');
  const btnConfirm = $('btn-confirm-group');
  if (btnDelete) {
    btnDelete.style.display = state.selectedPhotos.size > 0 ? 'inline-flex' : 'none';
  }
  if (btnConfirm) {
    btnConfirm.style.display = state.selectedPhotos.size > 0 ? 'inline-flex' : 'none';
  }

  for (let i = 0; i < state.group.length; i++) {
    const entry = state.group[i];

    const item = document.createElement('div');
    item.className = 'group-item';
    if (state.selectedPhotos.has(entry.name)) {
      item.classList.add('selected');
    }
    item.style.animationDelay = (i * 0.08) + 's';

    const img = document.createElement('img');
    img.draggable = false;
    try {
      const url = await createObjectUrl(entry.handle);
      img.src = url;
      img.dataset.objectUrl = url; // Store for cleanup
    } catch {
      img.alt = 'Erro ao carregar';
    }
    img.alt = entry.name;

    const indicator = document.createElement('div');
    indicator.className = 'group-select-indicator';
    indicator.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>';

    const fsBtn = document.createElement('div');
    fsBtn.className = 'group-fullscreen-btn';
    fsBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
    fsBtn.title = "Ver em ecrã inteiro";
    fsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFullscreen(img.dataset.objectUrl);
    });

    const label = document.createElement('span');
    label.className = 'group-item-label';
    label.textContent = entry.name;

    item.appendChild(img);
    item.appendChild(fsBtn);
    item.appendChild(indicator);
    item.appendChild(label);

    item.addEventListener('click', () => {
      if (state.selectedPhotos.has(entry.name)) {
        state.selectedPhotos.delete(entry.name);
        item.classList.remove('selected');
      } else {
        state.selectedPhotos.add(entry.name);
        item.classList.add('selected');
      }
      if (btnDelete) {
        btnDelete.style.display = state.selectedPhotos.size > 0 ? 'inline-flex' : 'none';
      }
      if (btnConfirm) {
        btnConfirm.style.display = state.selectedPhotos.size > 0 ? 'inline-flex' : 'none';
      }
    });
    grid.appendChild(item);
  }
}

/**
 * Display the group selection modal with all grouped photos.
 */
async function showGroupModal() {
  state.selectedPhotos = new Set(); // Reset selection
  cleanupGroupModal(); // clean just in case
  const modal = $('group-modal');
  await renderGroupGrid();
  modal.classList.add('active');
}

/**
 * Delete selected photos directly from the group without closing it.
 */
async function deleteSelectedFromGroup() {
  if (state.selectedPhotos.size === 0) return;

  const toTrash = [];
  const toKeepInGroup = [];

  for (const entry of state.group) {
    if (state.selectedPhotos.has(entry.name)) {
      toTrash.push(entry);
    } else {
      toKeepInGroup.push(entry);
    }
  }

  // Move to _trash
  try {
    const isSavedGroup = !!state.activeSavedGroupHandle;
    for (const entry of toTrash) {
      if (isSavedGroup) {
        await moveFileTo(entry.handle, entry.name, state.trashHandle, state.activeSavedGroupHandle);
      } else {
        await trashFile(entry.handle, entry.name);
      }
    }
  } catch (err) {
    showToast('Erro ao apagar selecção: ' + err.message, 'error');
    return;
  }

  state.stats.trashed += toTrash.length;

  state.group = toKeepInGroup;
  state.selectedPhotos.clear();
  
  cleanupGroupModal(); // Revoke all old urls

  if (state.group.length === 0) {
    $('group-modal').classList.remove('active');
    if (state.activeSavedGroupHandle) {
      try {
        await state.groupsHandle.removeEntry(state.activeSavedGroupName, { recursive: true });
      } catch (err) {}
      state.activeSavedGroupHandle = null;
      state.activeSavedGroupName = null;
      showGroupsList();
    } else {
      state.isGrouping = false;
      updateControlsUI();
      renderPhoto();
    }
    showToast('Todas apagadas do grupo', 'info');
  } else {
    await renderGroupGrid();
    showToast(toTrash.length + ' apagadas', 'info');
  }
}

/**
 * Confirm selection from group modal.
 * Keeps the selected photos, trashes unselected.
 */
async function confirmGroupSelection() {
  const isSavedGroup = !!state.activeSavedGroupHandle;
  const toKeep = [];
  const toTrash = [];

  for (const entry of state.group) {
    if (state.selectedPhotos.has(entry.name)) {
      toKeep.push(entry);
    } else {
      toTrash.push(entry);
    }
  }

  // Move to _kept
  try {
    for (const entry of toKeep) {
      if (isSavedGroup) {
        await moveFileTo(entry.handle, entry.name, state.keptHandle, state.activeSavedGroupHandle);
      } else {
        await keepFile(entry.handle, entry.name);
      }
    }
  } catch (err) {
    showToast('Erro ao guardar grupo: ' + err.message, 'error');
    return;
  }

  // Trash the rest
  try {
    for (const entry of toTrash) {
      if (isSavedGroup) {
        await moveFileTo(entry.handle, entry.name, state.trashHandle, state.activeSavedGroupHandle);
      } else {
        await trashFile(entry.handle, entry.name);
      }
    }
  } catch (err) {
    showToast('Erro ao apagar grupo: ' + err.message, 'error');
    return;
  }

  state.stats.kept += toKeep.length;
  state.stats.trashed += toTrash.length;

  if (isSavedGroup) {
    try {
      await state.groupsHandle.removeEntry(state.activeSavedGroupName, { recursive: true });
    } catch {}
    state.stats.grouped--;
    state.activeSavedGroupHandle = null;
    state.activeSavedGroupName = null;
    state.group = [];
    cleanupGroupModal();
    $('group-modal').classList.remove('active');
    showToast(`${toKeep.length} guardada(s), ${toTrash.length} apagada(s)`, 'success');
    showGroupsList();
    renderPhoto();
    return;
  }

  const groupStartIndex = state.currentIndex - state.group.length;

  // Push undo entry for the whole group
  state.undoStack.push({
    type: 'group',
    trashed: toTrash,
    kept: toKeep,
    groupStartIndex: groupStartIndex >= 0 ? groupStartIndex : 0,
  });

  // Remove trashed photos from the array
  const trashedNames = new Set(toTrash.map((e) => e.name));
  state.photos = state.photos.filter((p) => !trashedNames.has(p.name));

  // Adjust currentIndex
  state.currentIndex -= toTrash.length;

  // Cleanup modal and close
  cleanupGroupModal();
  $('group-modal').classList.remove('active');
  state.group = [];
  state.selectedPhotos = new Set();

  showToast(`${toKeep.length} guardada(s), ${toTrash.length} apagada(s)`, 'success');
  renderPhoto();
}

/**
 * Cancel the group selection — return to grouping mode.
 */
async function cancelGroupSelection() {
  cleanupGroupModal();
  $('group-modal').classList.remove('active');

  if (state.activeSavedGroupHandle) {
    state.activeSavedGroupHandle = null;
    state.activeSavedGroupName = null;
    state.group = [];
    showGroupsList();
    return;
  }

  // Return to grouping mode
  state.isGrouping = true;
  updateControlsUI();
  updateGroupIndicator();
  
  showToast('De volta ao agrupamento', 'info');
  renderPhoto();
}

/**
 * Revoke object URLs created for the group modal to free memory.
 */
function cleanupGroupModal() {
  const imgs = $('group-grid').querySelectorAll('img[data-object-url]');
  imgs.forEach((img) => URL.revokeObjectURL(img.dataset.objectUrl));
}

// ═══════════════════════════════════════════════════════════════
// GROUPS FOR LATER
// ═══════════════════════════════════════════════════════════════

async function saveGroupForLater() {
  if (state.group.length === 0) return;
  if (state.activeSavedGroupHandle) {
    state.activeSavedGroupHandle = null;
    state.activeSavedGroupName = null;
    state.group = [];
    cleanupGroupModal();
    $('group-modal').classList.remove('active');
    showGroupsList();
    return;
  }
  
  let groupedCount = 0;
  for await (const entry of state.groupsHandle.keys()) groupedCount++;
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const groupFolderName = `Grupo_${groupedCount + 1}_${timestamp.substring(11, 16)}`;
  
  try {
    const newGroupHandle = await state.groupsHandle.getDirectoryHandle(groupFolderName, { create: true });
    for (const entry of state.group) {
      await moveFileTo(entry.handle, entry.name, newGroupHandle);
    }
  } catch (err) {
    showToast('Erro ao guardar grupo: ' + err.message, 'error');
    return;
  }
  
  state.stats.grouped++;
  
  const groupStartIndex = state.currentIndex - state.group.length;
  state.undoStack.push({
    type: 'group_later',
    folderName: groupFolderName,
    entries: state.group,
    groupStartIndex: groupStartIndex >= 0 ? groupStartIndex : 0,
  });

  cleanupGroupModal();
  $('group-modal').classList.remove('active');
  
  const groupedNames = new Set(state.group.map((e) => e.name));
  state.photos = state.photos.filter((p) => !groupedNames.has(p.name));
  state.currentIndex -= state.group.length;
  if (state.currentIndex < 0) state.currentIndex = 0;
  
  state.group = [];
  showToast('Grupo guardado para mais tarde', 'success');
  renderPhoto();
}

async function showGroupsList() {
  const modal = $('groups-list-modal');
  const grid = $('groups-list-grid');
  grid.innerHTML = '';
  
  if (!state.groupsHandle) {
    showToast('Inicia uma sessão primeiro', 'info');
    return;
  }
  
  $('photo-loading').classList.remove('hidden');
  
  const groups = [];
  try {
    for await (const [name, handle] of state.groupsHandle.entries()) {
      if (handle.kind === 'directory') groups.push({ name, handle });
    }
  } catch (err) {
    showToast('Erro ao ler grupos: ' + err.message, 'error');
  }
  
  groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  
  for (let i = 0; i < groups.length; i++) {
    const entry = groups[i];
    const item = document.createElement('div');
    item.className = 'group-item';
    item.style.animationDelay = (i * 0.04) + 's';
    
    let firstFileHandle = null;
    let photoCount = 0;
    for await (const [fileName, fileHandle] of entry.handle.entries()) {
      if (fileHandle.kind === 'file') {
        photoCount++;
        if (!firstFileHandle) firstFileHandle = fileHandle;
      }
    }
    
    if (photoCount === 0) continue; // Skip empty groups
    
    const img = document.createElement('img');
    img.draggable = false;
    try {
      if (firstFileHandle) {
        const url = await createObjectUrl(firstFileHandle);
        img.src = url;
        img.dataset.objectUrl = url;
      }
    } catch {
      img.alt = 'Erro';
    }
    
    const label = document.createElement('span');
    label.className = 'group-item-label';
    label.textContent = `${entry.name} (${photoCount} fotos)`;
    
    item.appendChild(img);
    item.appendChild(label);
    
    item.addEventListener('click', () => {
      cleanupGroupsListModal();
      modal.classList.remove('active');
      openGroupForSelection(entry.handle, entry.name);
    });
    
    grid.appendChild(item);
  }
  
  $('photo-loading').classList.add('hidden');
  modal.classList.add('active');
}

function cleanupGroupsListModal() {
  const imgs = $('groups-list-grid').querySelectorAll('img[data-object-url]');
  imgs.forEach((img) => URL.revokeObjectURL(img.dataset.objectUrl));
}

async function openGroupForSelection(groupHandle, groupName) {
  const files = [];
  for await (const [name, handle] of groupHandle.entries()) {
    if (handle.kind === 'file') files.push({ name, handle });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  
  state.group = files;
  state.activeSavedGroupName = groupName;
  state.activeSavedGroupHandle = groupHandle;
  
  showGroupModal();
}

// ═══════════════════════════════════════════════════════════════
// GALLERY MODAL (KEPT/TRASHED)
// ═══════════════════════════════════════════════════════════════

async function showGallery(type) {
  state.galleryType = type;
  state.gallerySelected = new Set();
  
  const modal = $('gallery-modal');
  const grid = $('gallery-grid');
  const title = $('gallery-title');
  const desc = $('gallery-desc');
  const restoreBtn = $('btn-restore-gallery');
  
  grid.innerHTML = '';
  restoreBtn.style.display = 'none';
  
  let sourceHandle = null;

  if (type === 'kept') {
    title.textContent = 'Guardadas';
    desc.textContent = `Fotos movidas para _kept (${state.stats.kept})`;
    sourceHandle = state.keptHandle;
  } else {
    title.textContent = 'Apagadas';
    desc.textContent = `Fotos movidas para _trash (${state.stats.trashed})`;
    sourceHandle = state.trashHandle;
  }
  
  if (!sourceHandle) {
    showToast('Inicia uma sessão primeiro', 'info');
    return;
  }
  
  $('photo-loading').classList.remove('hidden');
  
  const files = [];
  try {
    for await (const [name, handle] of sourceHandle.entries()) {
      if (handle.kind === 'file') files.push({ name, handle });
    }
  } catch (err) {
    showToast('Erro ao ler pasta: ' + err.message, 'error');
  }
  
  files.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' }));
  
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    const item = document.createElement('div');
    item.className = 'group-item';
    item.style.animationDelay = (i * 0.04) + 's';
    
    const img = document.createElement('img');
    try {
      const url = await createObjectUrl(entry.handle);
      img.src = url;
      img.dataset.objectUrl = url;
    } catch {
      img.alt = 'Erro';
    }
    
    const indicator = document.createElement('div');
    indicator.className = 'group-select-indicator';
    indicator.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>';

    const fsBtn = document.createElement('div');
    fsBtn.className = 'group-fullscreen-btn';
    fsBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
    fsBtn.title = "Ver em ecrã inteiro";
    fsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFullscreen(img.dataset.objectUrl);
    });

    const label = document.createElement('span');
    label.className = 'group-item-label';
    label.textContent = entry.name;
    
    item.appendChild(img);
    item.appendChild(fsBtn);
    item.appendChild(indicator);
    item.appendChild(label);
    grid.appendChild(item);

    // Toggle selection on click
    item.addEventListener('click', () => {
      if (state.gallerySelected.has(entry.name)) {
        state.gallerySelected.delete(entry.name);
        item.classList.remove('selected');
      } else {
        state.gallerySelected.add(entry.name);
        item.classList.add('selected');
      }
      
      if (state.gallerySelected.size > 0) {
        restoreBtn.style.display = 'inline-flex';
        restoreBtn.textContent = `Restaurar ${state.gallerySelected.size} foto(s)`;
      } else {
        restoreBtn.style.display = 'none';
      }
    });
  }
  
  $('photo-loading').classList.add('hidden');
  modal.classList.add('active');
}

function cleanupGalleryModal() {
  const imgs = $('gallery-grid').querySelectorAll('img[data-object-url]');
  imgs.forEach((img) => URL.revokeObjectURL(img.dataset.objectUrl));
}

async function restoreGallerySelection() {
  if (state.gallerySelected.size === 0) return;
  
  const sourceHandle = state.galleryType === 'kept' ? state.keptHandle : state.trashHandle;
  const restoredPhotos = [];
  
  $('photo-loading').classList.remove('hidden');
  
  for (const name of state.gallerySelected) {
    try {
      const restoredHandle = await restoreFile(name, sourceHandle);
      restoredPhotos.push({ name, handle: restoredHandle });
      
      if (state.galleryType === 'kept') state.stats.kept--;
      else state.stats.trashed--;
    } catch (err) {
      showToast('Erro ao restaurar: ' + err.message, 'error');
    }
  }
  
  // Insert exactly at current index so they appear next
  state.photos.splice(state.currentIndex, 0, ...restoredPhotos);
  
  showToast(`${restoredPhotos.length} foto(s) restaurada(s)`, 'success');
  
  // Refresh gallery (keeps it open)
  await showGallery(state.galleryType);
  
  // Update main screen if it was empty, or just re-render
  renderPhoto();
}

// ═══════════════════════════════════════════════════════════════
// ANIMATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Animate the photo card exiting the screen.
 * @param {'left'|'right'|'group'} direction
 */
function animateExit(direction) {
  return new Promise((resolve) => {
    state.isAnimating = true;
    const card = $('photo-card');

    // Flash the matching overlay
    const overlaySelector =
      direction === 'right' ? '.overlay-keep' :
      direction === 'left'  ? '.overlay-trash' :
      '.overlay-group';

    const overlay = card.querySelector(overlaySelector);
    overlay.style.opacity = '1';

    // Start exit after a short overlay flash
    setTimeout(() => {
      card.style.transition = '';
      card.style.transform = ''; // clear inline transform so class can take over
      card.classList.add('exit-' + direction);
    }, 120);

    // Resolve after animation finishes
    setTimeout(() => {
      overlay.style.opacity = '0';
      state.isAnimating = false;
      resolve();
    }, 450);
  });
}

// ═══════════════════════════════════════════════════════════════
// SWIPE GESTURES (Pointer Events)
// ═══════════════════════════════════════════════════════════════

function setupSwipeGestures() {
  const card = $('photo-card');

  card.addEventListener('pointerdown', (e) => {
    if (state.screen !== 'swipe' || state.isAnimating) return;
    state.isDragging = true;
    state.dragStartX = e.clientX;
    state.dragDeltaX = 0;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });

  card.addEventListener('pointermove', (e) => {
    if (!state.isDragging) return;
    state.dragDeltaX = e.clientX - state.dragStartX;
    if (state.isGrouping) return; // Do not animate swipe in grouping mode

    const rotation = state.dragDeltaX * 0.04;
    card.style.transform = 'translateX(' + state.dragDeltaX + 'px) rotate(' + rotation + 'deg)';

    // Show overlays based on drag direction
    const keepOv = card.querySelector('.overlay-keep');
    const trashOv = card.querySelector('.overlay-trash');

    if (state.dragDeltaX > 0) {
      keepOv.style.opacity = Math.min(state.dragDeltaX / 300, 1);
      trashOv.style.opacity = '0';
    } else {
      trashOv.style.opacity = Math.min(-state.dragDeltaX / 300, 1);
      keepOv.style.opacity = '0';
    }
  });

  card.addEventListener('pointerup', () => {
    if (!state.isDragging) return;
    state.isDragging = false;

    // Click without drag triggers fullscreen
    if (Math.abs(state.dragDeltaX) < 5) {
      card.style.transition = '';
      card.style.transform = '';
      card.querySelector('.overlay-keep').style.opacity = '0';
      card.querySelector('.overlay-trash').style.opacity = '0';
      toggleFullscreen();
      return;
    }

    if (state.isGrouping) {
      // Swiping is disabled in grouping mode, snap back smoothly
      card.style.transition = 'transform 0.3s ease-out';
      card.style.transform = '';
      card.querySelector('.overlay-keep').style.opacity = '0';
      card.querySelector('.overlay-trash').style.opacity = '0';
      return;
    }

    // Trigger action if dragged past threshold
    const threshold = 120;
    if (state.dragDeltaX > threshold) {
      handleKeep();
    } else if (state.dragDeltaX < -threshold) {
      handleTrash();
    } else {
      // Snap back smoothly if not dragged past threshold
      card.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
      card.style.transform = '';
      card.querySelector('.overlay-keep').style.opacity = '0';
      card.querySelector('.overlay-trash').style.opacity = '0';
    }
  });

  card.addEventListener('pointercancel', () => {
    state.isDragging = false;
    card.style.transition = '';
    card.style.transform = '';
  });

  // Prevent native image drag
  card.addEventListener('dragstart', (e) => e.preventDefault());
}

// ═══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ignore when typing in inputs
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    // Fullscreen viewer — close on any key
    if ($('fullscreen-viewer').classList.contains('active')) {
      $('fullscreen-viewer').classList.remove('active');
      e.preventDefault();
      return;
    }

    // Group modal
    if ($('group-modal').classList.contains('active')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelGroupSelection();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (state.selectedPhotos.size > 0) {
          confirmGroupSelection();
        } else {
          saveGroupForLater();
        }
      } else if (e.key.toLowerCase() === 'z') {
        if (!state.activeSavedGroupHandle) {
          e.preventDefault();
          cleanupGroupModal();
          $('group-modal').classList.remove('active');
          handleUndo();
        }
      }
      return;
    }

    // Gallery modal — Escape
    if ($('gallery-modal').classList.contains('active')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanupGalleryModal();
        $('gallery-modal').classList.remove('active');
      }
      return;
    }

    // Groups list modal — Escape
    if ($('groups-list-modal').classList.contains('active')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanupGroupsListModal();
        $('groups-list-modal').classList.remove('active');
      }
      return;
    }

    // Swipe screen shortcuts
    if (state.screen === 'swipe') {
      switch (e.key) {
        case 'Enter':
          if (state.isGrouping) {
            e.preventDefault();
            state.isGrouping = false;
            updateControlsUI();
            updateGroupIndicator();
            if (state.group.length > 0) {
              saveGroupForLater();
            } else {
              renderPhoto();
            }
          }
          break;
        case 'ArrowRight': case 'd': case 'D':
          if (!state.isGrouping) { e.preventDefault(); handleKeep(); } break;
        case 'ArrowLeft': case 'a': case 'A':
          if (!state.isGrouping) { e.preventDefault(); handleTrash(); } break;
        case 'ArrowDown': case 'm': case 'M':
          e.preventDefault(); handleGroup(); break;
        case 'z': case 'Z':
          e.preventDefault(); handleUndo(); break;
        case 'ArrowUp':
          e.preventDefault();
          if (state.isGrouping) endGrouping();
          else toggleFullscreen();
          break;
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// FULLSCREEN VIEWER
// ═══════════════════════════════════════════════════════════════

/**
 * Toggle the fullscreen viewer for the current swipe photo.
 */
async function toggleFullscreen() {
  const viewer = $('fullscreen-viewer');

  if (viewer.classList.contains('active')) {
    viewer.classList.remove('active');
  } else if (state.currentIndex < state.photos.length) {
    try {
      const url = await createObjectUrl(state.photos[state.currentIndex].handle);
      openFullscreen(url);
    } catch { /* ignore */ }
  }
}

/**
 * Open the fullscreen viewer with a specific image URL.
 */
function openFullscreen(url) {
  $('fullscreen-photo').src = url;
  $('fullscreen-viewer').classList.add('active');
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Show a toast notification.
 */
function showToast(message, type) {
  type = type || 'info';
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('visible'));
  });

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}

/**
 * Update the group indicator badge visibility and count.
 */
function updateGroupIndicator() {
  const indicator = $('group-indicator');
  if (state.isGrouping && state.group.length > 0) {
    indicator.classList.add('visible');
    $('group-count').textContent = state.group.length;
  } else {
    indicator.classList.remove('visible');
  }
}

/**
 * Show the "all done" screen with final stats.
 */
function showDoneScreen() {
  $('done-kept').textContent = state.stats.kept;
  $('done-trashed').textContent = state.stats.trashed;
  showScreen('done');
}

/**
 * Toggle control buttons based on grouping mode.
 */
function updateControlsUI() {
  const normalBtns = document.querySelectorAll('.mode-normal');
  const groupBtns = document.querySelectorAll('.mode-group');
  
  if (state.isGrouping) {
    normalBtns.forEach(b => b.classList.add('hidden'));
    groupBtns.forEach(b => b.classList.remove('hidden'));
  } else {
    normalBtns.forEach(b => b.classList.remove('hidden'));
    groupBtns.forEach(b => b.classList.add('hidden'));
  }
}

// ═══════════════════════════════════════════════════════════════
// SIDE-BY-SIDE MODE
// ═══════════════════════════════════════════════════════════════

function toggleSideBySide() {
  if (state.sideBySide) {
    disableSideBySide();
  } else {
    enableSideBySide();
  }
}

function enableSideBySide() {
  if (state.isGrouping) {
    if (state.group.length === 0) return;
  } else {
    const nextIdx = state.currentIndex + 1;
    if (nextIdx >= state.photos.length) return;
  }
  
  state.sideBySide = true;
  $('photo-stage').classList.add('side-by-side-mode');
  $('next-preview').style.display = 'none';
  if ($('prev-preview')) $('prev-preview').style.display = 'none';
}

function disableSideBySide() {
  if (!state.sideBySide) return;
  state.sideBySide = false;
  $('photo-stage').classList.remove('side-by-side-mode');
  if (state._updatePreviewsLayout) state._updatePreviewsLayout();
}

// ═══════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════

function setupEventListeners() {
  // Dynamic resize of next-preview and prev-preview to avoid overlap
  const updatePreviewsLayout = () => {
    const currentPhoto = $('current-photo');
    if (!currentPhoto) return;
    
    const offsetWidth = currentPhoto.offsetWidth;
    // Space available on each side when photo is centered
    const availableSpace = (window.innerWidth - offsetWidth) / 2;
    
    const nextPreview = $('next-preview');
    if (nextPreview) {
      if (state.sideBySide) {
        nextPreview.style.display = 'none';
      } else {
        let previewMaxWidth = availableSpace - 24; // 12px gap from photo, 12px gap from edge
        if (previewMaxWidth < 40) {
          nextPreview.style.display = 'none';
        } else {
          nextPreview.style.display = '';
          previewMaxWidth = Math.max(0, Math.min(previewMaxWidth, 500));
          nextPreview.style.maxWidth = `${previewMaxWidth}px`;
        }
      }
    }
    
    const prevPreview = $('prev-preview');
    if (prevPreview) {
      if (state.sideBySide) {
        prevPreview.style.display = 'none';
      } else {
        let previewMaxWidth = availableSpace - 24;
        if (previewMaxWidth < 40) {
          prevPreview.style.display = 'none';
        } else {
          prevPreview.style.display = '';
          previewMaxWidth = Math.max(0, Math.min(previewMaxWidth, 500));
          prevPreview.style.maxWidth = `${previewMaxWidth}px`;
        }
      }
    }
  };

  const photoCardObserver = new ResizeObserver(() => updatePreviewsLayout());
  photoCardObserver.observe($('current-photo'));
  window.addEventListener('resize', updatePreviewsLayout);
  state._updatePreviewsLayout = updatePreviewsLayout;

  // Folder screen
  $('pick-folder-btn').addEventListener('click', pickFolder);
  $('start-btn').addEventListener('click', startSession);

  // Control buttons
  $('btn-trash').addEventListener('click', handleTrash);
  $('btn-keep').addEventListener('click', handleKeep);
  $('btn-group').addEventListener('click', handleGroup);
  $('btn-undo').addEventListener('click', handleUndo);

  $('btn-stop-group').addEventListener('click', endGrouping);
  $('btn-continue-group').addEventListener('click', handleGroup);
  
  $('btn-confirm-group').addEventListener('click', confirmGroupSelection);
  $('btn-save-later').addEventListener('click', saveGroupForLater);
  $('btn-delete-selected').addEventListener('click', deleteSelectedFromGroup);
  // Open fullscreen on scroll for swipe images
  $('current-photo').addEventListener('wheel', (e) => {
    e.preventDefault();
    openFullscreen($('current-photo').src);
  }, { passive: false });

  $('side-photo').addEventListener('wheel', (e) => {
    e.preventDefault();
    openFullscreen($('side-photo').src);
  }, { passive: false });

  // Setup advanced zoom/pan ONLY for fullscreen
  setupFullscreenZoomPan($('fullscreen-photo'));

  // Gallery and Groups
  $('stat-kept').addEventListener('click', () => showGallery('kept'));
  $('stat-trashed').addEventListener('click', () => showGallery('trashed'));
  $('btn-restore-gallery').addEventListener('click', restoreGallerySelection);
  
  $('stat-grouped').addEventListener('click', showGroupsList);

  $('gallery-modal').addEventListener('click', (e) => {
    if (e.target === $('gallery-modal')) {
      cleanupGalleryModal();
      $('gallery-modal').classList.remove('active');
    }
  });

  $('groups-list-modal').addEventListener('click', (e) => {
    if (e.target === $('groups-list-modal')) {
      cleanupGroupsListModal();
      $('groups-list-modal').classList.remove('active');
    }
  });

  // Modal close buttons (moved from inline onclick in HTML)
  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('#gallery-modal, #groups-list-modal');
      if (modal) {
        if (modal.id === 'gallery-modal') cleanupGalleryModal();
        if (modal.id === 'groups-list-modal') cleanupGroupsListModal();
        modal.classList.remove('active');
      }
    });
  });

  // Fullscreen viewer — click to close (only if clicking outside the image or if it's not zoomed)
  $('fullscreen-viewer').addEventListener('click', (e) => {
    if (e.target !== $('fullscreen-photo') || !$('fullscreen-photo').classList.contains('zoom-grabbable')) {
      $('fullscreen-viewer').classList.remove('active');
      if ($('fullscreen-photo')._resetZoomPan) {
        $('fullscreen-photo')._resetZoomPan();
      }
    }
  });

  // Side photo click to disable
  $('side-photo-card').addEventListener('click', disableSideBySide);

  // Toggle side-by-side via preview click
  $('next-preview').addEventListener('click', toggleSideBySide);
  if ($('prev-preview')) {
    $('prev-preview').addEventListener('click', toggleSideBySide);
  }

  // Settings Modal
  $('btn-settings').addEventListener('click', () => {
    // Populate sliders with current settings
    $('set-dhash').value = state.settings.dHashSim;
    $('val-dhash').textContent = state.settings.dHashSim + '%';
    
    $('set-hist').value = state.settings.histSim;
    $('val-hist').textContent = state.settings.histSim + '%';

    $('set-blur').value = state.settings.blurThreshold;
    $('val-blur').textContent = state.settings.blurThreshold;

    $('set-dark').value = state.settings.darkThreshold;
    $('val-dark').textContent = state.settings.darkThreshold;

    $('set-bright').value = state.settings.brightThreshold;
    $('val-bright').textContent = state.settings.brightThreshold;

    $('settings-modal').classList.add('active');
  });

  $('settings-close').addEventListener('click', () => {
    $('settings-modal').classList.remove('active');
  });

  $('settings-modal').addEventListener('click', (e) => {
    if (e.target === $('settings-modal')) {
      $('settings-modal').classList.remove('active');
    }
  });

  // Settings slider change events
  const updateSetting = (id, key, suffix = '') => {
    $(id).addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.settings[key] = val;
      $('val-' + id.replace('set-', '')).textContent = val + suffix;
    });

    $(id).addEventListener('change', () => {
      saveSettings();
      // Re-evaluate current photo
      if (state.screen === 'swipe') {
        renderPhoto();
        renderPreviews();
      }
    });
  };

  updateSetting('set-dhash', 'dHashSim', '%');
  updateSetting('set-hist', 'histSim', '%');
  updateSetting('set-blur', 'blurThreshold', '');
  updateSetting('set-dark', 'darkThreshold', '');
  updateSetting('set-bright', 'brightThreshold', '');

  // Done screen — restart
  $('restart-btn').addEventListener('click', () => showScreen('folder'));
  
  // Stats
  const showStats = () => loadStatistics();
  $('btn-stats').addEventListener('click', showStats);
  const emptyStatsBtn = $('empty-stats-btn');
  if (emptyStatsBtn) emptyStatsBtn.addEventListener('click', showStats);
  if ($('done-stats-btn')) $('done-stats-btn').addEventListener('click', showStats);
  $('stats-back-btn').addEventListener('click', () => {
    $('stats-screen').classList.remove('active');
  });
}

function setupFullscreenZoomPan(imgElement) {
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;

  const updateTransform = () => {
    imgElement.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  };

  imgElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    scale += delta;
    scale = Math.min(Math.max(1, scale), 8); // allow 8x zoom
    
    if (scale === 1) {
      translateX = 0;
      translateY = 0;
      imgElement.classList.remove('zoom-grabbable', 'zoom-grabbing');
    } else {
      imgElement.classList.add('zoom-grabbable');
    }
    
    updateTransform();
  }, { passive: false });

  imgElement.addEventListener('mousedown', (e) => {
    if (scale > 1) {
      e.preventDefault();
      isDragging = true;
      startX = e.clientX - translateX;
      startY = e.clientY - translateY;
      imgElement.classList.add('zoom-grabbing');
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    updateTransform();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    imgElement.classList.remove('zoom-grabbing');
  });

  imgElement._resetZoomPan = () => {
    scale = 1;
    translateX = 0;
    translateY = 0;
    isDragging = false;
    imgElement.classList.remove('zoom-grabbable', 'zoom-grabbing');
    updateTransform();
  };
}

// ═══════════════════════════════════════════════════════════════
// STATISTICS & HEATMAP
// ═══════════════════════════════════════════════════════════════

async function loadStatistics() {
  if (!state.dirHandle) {
    showToast('Seleciona uma pasta primeiro para ver as estatísticas.', 'error');
    return;
  }
  
  $('stats-screen').classList.add('active');
  $('stats-loading').classList.remove('hidden');
  $('stats-dashboard').classList.remove('hidden'); // Show dashboard immediately
  
  $('stats-loading-text').textContent = 'A procurar fotografias na pasta...';
  
  // Clear previous stats
  state.allStatsData = [];
  state.statsFilters = { date: null, camera: null, bounds: null };

  $('stat-total-photos').textContent = '0';
  $('stat-gps-photos').textContent = '0';
  renderHeatmap([], false);
  
  // Important: leaflet needs invalidateSize after container becomes visible
  if (state.leafletMap) {
    setTimeout(() => {
      state.leafletMap.invalidateSize();
    }, 150);
  }

  const allHandles = [];

  // Pass 1: Collect all files quickly
  async function collectFiles(dirHandle) {
    for await (const [name, handle] of dirHandle.entries()) {
      if (name.startsWith('.')) continue;
      if (handle.kind === 'directory') {
        await collectFiles(handle);
      } else if (handle.kind === 'file') {
        const ext = name.split('.').pop().toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          allHandles.push(handle);
        }
      }
    }
  }

  try {
    await collectFiles(state.dirHandle);
  } catch (err) {
    console.error('Erro ao procurar ficheiros', err);
  }

  const totalFiles = allHandles.length;
  if (totalFiles === 0) {
    $('stats-loading').classList.add('hidden');
    return;
  }

  let processedCount = 0;
  let photosWithGPS = 0;
  const gpsPoints = [];
  
  // New Chart Data
  const timelineData = {}; // "YYYY-MM": count
  const camerasData = {}; // "Make Model": count

  // Initial charts draw (empty)
  renderCharts({}, {});

  // Pass 2: Process files with progress
  for (const handle of allHandles) {
    processedCount++;
    let photoData = { lat: undefined, lng: undefined, dateKey: null, camName: null };
    
    // Update UI periodically to not block the thread too much
    if (processedCount % 5 === 0 || processedCount === totalFiles) {
      $('stats-loading-text').textContent = `A extrair metadados... (${processedCount} / ${totalFiles})`;
      $('stat-total-photos').textContent = processedCount;
      $('stat-gps-photos').textContent = photosWithGPS;
      
      // Update heatmap incrementally
      if (state.heatLayer && gpsPoints.length > 0) {
        state.heatLayer.setLatLngs(gpsPoints);
      }
    }

    try {
      const file = await handle.getFile();
      // Extract GPS and other EXIF metadata
      const metadata = await exifr.parse(file, { tiff: true, exif: true, gps: true });
      
      if (metadata) {
        // GPS
        if (typeof metadata.latitude === 'number' && typeof metadata.longitude === 'number') {
          photoData.lat = metadata.latitude;
          photoData.lng = metadata.longitude;
        }
        
        // Timeline
        if (metadata.DateTimeOriginal) {
          const date = new Date(metadata.DateTimeOriginal);
          if (!isNaN(date.getTime())) {
            const day = String(date.getDate()).padStart(2, '0');
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const year = date.getFullYear();
            photoData.dateKey = `${year}-${month}-${day}`;
          }
        }
        
        if (metadata.Make || metadata.Model) {
          let make = (metadata.Make || '').trim();
          let model = (metadata.Model || '').trim();
          if (make.toLowerCase() === 'apple') make = 'Apple';
          let camName = model;
          if (make && !model.toLowerCase().includes(make.toLowerCase())) {
            camName = `${make} ${model}`;
          }
          photoData.camName = camName.trim() || 'Desconhecida';
        }
      }
    } catch (e) {}

    state.allStatsData.push(photoData);
    
    // UI Feedback
    if (processedCount % 10 === 0 || processedCount === totalFiles) {
      $('stats-loading-text').textContent = `A extrair metadados... (${processedCount} / ${totalFiles})`;
      applyStatsFilters(false);
    }
  }

  // Final Fit Bounds
  $('stats-loading').classList.add('hidden');
  applyStatsFilters(true);
  setTimeout(() => { state._ignoreMapEvents = false; }, 800);
}

// ─── CROSS FILTERING ENGINE ───

function applyStatsFilters(fitMapBounds = false) {
  let photosWithGPS = 0;
  let timelineData = {}; 
  let camerasData = {}; 
  const gpsPoints = [];

  // Filter the full dataset
  let filteredData = state.allStatsData.filter(d => {
    if (state.statsFilters.date && d.dateKey !== state.statsFilters.date) return false;
    if (state.statsFilters.camera && d.camName !== state.statsFilters.camera) return false;
    if (state.statsFilters.bounds && d.lat !== undefined && d.lng !== undefined) {
      const p = L.latLng(d.lat, d.lng);
      if (!state.statsFilters.bounds.contains(p)) return false;
    }
    return true;
  });

  // Aggregate the filtered dataset
  filteredData.forEach(d => {
    if (d.lat !== undefined && d.lng !== undefined) {
      gpsPoints.push([d.lat, d.lng, 1]);
      photosWithGPS++;
    }
    if (d.dateKey) {
      timelineData[d.dateKey] = (timelineData[d.dateKey] || 0) + 1;
    }
    if (d.camName) {
      camerasData[d.camName] = (camerasData[d.camName] || 0) + 1;
    }
  });

  // Update Text UI
  $('stat-total-photos').textContent = filteredData.length;
  $('stat-gps-photos').textContent = photosWithGPS;

  // Render Sub-components
  renderHeatmap(gpsPoints, fitMapBounds);
  renderCharts(timelineData, camerasData);
}

// ─── Chart Setup ───

Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = 'Inter, sans-serif';

function renderCharts(timelineData, camerasData) {
  // 1. Timeline Chart
  const timelineCtx = $('timeline-chart').getContext('2d');
  
  // Sort timeline keys chronologically
  const timelineKeys = Object.keys(timelineData).sort();
  const timelineValues = timelineKeys.map(k => timelineData[k]);
  
  // Format labels nicely (e.g. "2023-01-15" -> "15 Jan 2023")
  const formatDay = (str) => {
    const [y, m, d] = str.split('-');
    const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    return date.toLocaleString('pt-PT', { day: 'numeric', month: 'short', year: '2-digit' });
  };
  const timelineLabels = timelineKeys.map(formatDay);

  if (state.timelineChart) {
    state.timelineChartKeys = timelineKeys;
    state.timelineChart.data.labels = timelineLabels;
    state.timelineChart.data.datasets[0].data = timelineValues;
    state.timelineChart.update();
  } else {
    state.timelineChartKeys = timelineKeys;
    // Gradient for the line chart fill
    const gradient = timelineCtx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(129, 140, 248, 0.5)'); // #818cf8
    gradient.addColorStop(1, 'rgba(129, 140, 248, 0.0)');

    state.timelineChart = new Chart(timelineCtx, {
      type: 'line',
      data: {
        labels: timelineLabels,
        datasets: [{
          label: 'Fotografias',
          data: timelineValues,
          borderColor: '#818cf8',
          backgroundColor: gradient,
          borderWidth: 2,
          pointBackgroundColor: '#a78bfa',
          pointBorderColor: '#fff',
          pointRadius: 3,
          pointHoverRadius: 6,
          fill: true,
          tension: 0.3 // Smooth curves
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255, 255, 255, 0.05)' }
          },
          x: {
            grid: { display: false }
          }
        }
      }
    });
  }

  // 2. Cameras Chart
  const camerasCtx = $('cameras-chart').getContext('2d');
  
  // Sort cameras by count descending
  const sortedCameras = Object.entries(camerasData).sort((a, b) => b[1] - a[1]);
  // Top 5 and group the rest as "Outras"
  const topCameras = sortedCameras.slice(0, 5);
  const otherCameras = sortedCameras.slice(5).reduce((sum, [_, count]) => sum + count, 0);
  if (otherCameras > 0) {
    topCameras.push(['Outras', otherCameras]);
  }
  
  const cameraLabels = topCameras.map(c => c[0]);
  const cameraValues = topCameras.map(c => c[1]);

  if (state.camerasChart) {
    state.camerasChart.data.labels = cameraLabels;
    state.camerasChart.data.datasets[0].data = cameraValues;
    state.camerasChart.update();
  } else {
    state.camerasChart = new Chart(camerasCtx, {
      type: 'doughnut',
      data: {
        labels: cameraLabels,
        datasets: [{
          data: cameraValues,
          backgroundColor: [
            '#818cf8', '#a78bfa', '#f472b6', '#38bdf8', '#34d399', '#94a3b8'
          ],
          borderWidth: 0,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: { color: '#e2e8f0', padding: 20 }
          }
        },
        cutout: '65%'
      }
    });
  }
}

function renderHeatmap(gpsPoints, fitMapBounds = false) {
  if (!state.leafletMap) {
    // Initialize map
    state.leafletMap = L.map('heatmap-container').setView([20, 0], 2);
    
    // Add base tile layer (CartoDB Positron - Light and minimalist)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(state.leafletMap);
  }

  // Create heat layer if not exists
  if (!state.heatLayer) {
    state.heatLayer = L.heatLayer([], {
      radius: 25,
      blur: 15,
      maxZoom: 10,
      gradient: {0.2: '#e2e8f0', 0.5: '#c4b5fd', 0.8: '#a78bfa', 1.0: '#818cf8'} // Soft, minimalist purple/indigo gradient
    }).addTo(state.leafletMap);
  }
  
  state.heatLayer.setLatLngs(gpsPoints);

  if (fitMapBounds && gpsPoints.length > 0) {
    const bounds = L.latLngBounds(gpsPoints.map(p => [p[0], p[1]]));
    state._ignoreMapEvents = true;
    state.leafletMap.fitBounds(bounds, { padding: [50, 50] });
    setTimeout(() => { state._ignoreMapEvents = false; }, 800);
  } else if (fitMapBounds && gpsPoints.length === 0) {
    state._ignoreMapEvents = true;
    state.leafletMap.setView([20, 0], 2);
    setTimeout(() => { state._ignoreMapEvents = false; }, 800);
  }
}
