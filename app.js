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
  selectedPhotos: new Set(),  // Set of names for group modal multi-select
  sideBySide: false,
  galleryType: null,
  gallerySelected: new Set(),
  activeSavedGroupHandle: null,
  activeSavedGroupName: null,
};

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
    for await (const [name, handle] of state.dirHandle.entries()) {
      if (handle.kind !== 'file') continue;
      if (name.startsWith('.')) continue;

      const ext = name.split('.').pop().toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        photos.push({ name, handle });
      }
    }

    // Sort by filename (natural sort: IMG_2 before IMG_10)
    photos.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );

    if (photos.length === 0) {
      $('folder-error').textContent = 'Nenhuma fotografia encontrada nesta pasta';
      return;
    }

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
 * Render the current photo and update all UI elements.
 */
async function renderPhoto() {
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
  $('photo-counter').textContent = (state.currentIndex + 1) + ' / ' + state.photos.length;
  $('stat-kept-count').textContent = state.stats.kept;
  $('stat-trashed-count').textContent = state.stats.trashed;
  $('stat-grouped-count').textContent = state.stats.grouped;

  // Progress bar
  $('progress-fill').style.width = ((state.currentIndex / state.photos.length) * 100) + '%';

  // Next photo preview
  renderNextPreview();

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
 * Render the next photo preview in the bottom-right corner.
 */
async function renderNextPreview() {
  const nextIdx = state.currentIndex + 1;
  const preview = $('next-preview');

  // Revoke previous preview URL
  if (state.nextObjectUrl) {
    URL.revokeObjectURL(state.nextObjectUrl);
    state.nextObjectUrl = null;
  }

  if (nextIdx < state.photos.length) {
    try {
      const url = await createObjectUrl(state.photos[nextIdx].handle);
      state.nextObjectUrl = url;
      $('next-photo').src = url;
      $('side-photo').src = url; // Also update side-by-side image
      preview.classList.add('visible');
    } catch {
      preview.classList.remove('visible');
    }
  } else {
    preview.classList.remove('visible');
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

/**
 * Display the group selection modal with all grouped photos.
 */
async function showGroupModal() {
  state.selectedPhotos = new Set(); // Reset selection
  const modal = $('group-modal');
  const grid = $('group-grid');
  grid.innerHTML = '';

  for (let i = 0; i < state.group.length; i++) {
    const entry = state.group[i];

    const item = document.createElement('div');
    item.className = 'group-item';
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
    });
    grid.appendChild(item);
  }

  modal.classList.add('active');
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
 * Cancel the group selection — keep all grouped photos.
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

  try {
    for (const entry of state.group) {
      await keepFile(entry.handle, entry.name);
    }
  } catch (err) {
    showToast('Erro ao guardar grupo: ' + err.message, 'error');
    return;
  }

  state.stats.kept += state.group.length;
  
  const groupStartIndex = state.currentIndex - state.group.length;
  state.undoStack.push({
    type: 'group',
    trashed: [],
    kept: state.group,
    groupStartIndex: groupStartIndex >= 0 ? groupStartIndex : 0,
  });

  state.group = [];
  showToast('Grupo cancelado — todas guardadas', 'info');
  renderPhoto();
}

/**
 * Revoke object URLs created for the group modal to free memory.
 */
function cleanupGroupModal() {
  const imgs = $('group-grid').querySelectorAll('div[data-object-url]');
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
  
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  
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
  const imgs = $('gallery-grid').querySelectorAll('div[data-object-url]');
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
    setTimeout(() => card.classList.add('exit-' + direction), 120);

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

    const rotation = state.dragDeltaX * 0.04;
    card.style.transform = 'translateX(' + state.dragDeltaX + 'px) rotate(' + rotation + 'deg)';

    // Show overlays based on drag direction
    const keepOv = card.querySelector('.overlay-keep');
    const trashOv = card.querySelector('.overlay-trash');

    if (state.dragDeltaX > 0) {
      keepOv.style.opacity = Math.min(state.dragDeltaX / 120, 1);
      trashOv.style.opacity = '0';
    } else {
      trashOv.style.opacity = Math.min(-state.dragDeltaX / 120, 1);
      keepOv.style.opacity = '0';
    }
  });

  card.addEventListener('pointerup', () => {
    if (!state.isDragging) return;
    state.isDragging = false;

    card.style.transition = '';
    card.style.transform = '';
    card.querySelector('.overlay-keep').style.opacity = '0';
    card.querySelector('.overlay-trash').style.opacity = '0';

    // Click without drag triggers fullscreen
    if (Math.abs(state.dragDeltaX) < 5) {
      toggleFullscreen();
      return;
    }

    // Trigger action if dragged past threshold
    const threshold = 120;
    if (state.isGrouping) {
      if (state.dragDeltaX > threshold) handleGroup(); // Right -> add to group
      else if (state.dragDeltaX < -threshold) endGrouping(); // Left -> stop grouping
    } else {
      if (state.dragDeltaX > threshold) handleKeep();
      else if (state.dragDeltaX < -threshold) handleTrash();
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

    // Group modal — only Escape
    if ($('group-modal').classList.contains('active')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelGroupSelection();
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
        case 'ArrowRight': case 'd': case 'D':
          if (!state.isGrouping) { e.preventDefault(); handleKeep(); } break;
        case 'ArrowLeft': case 'a': case 'A':
          if (!state.isGrouping) { e.preventDefault(); handleTrash(); } break;
        case 'm': case 'M':
          e.preventDefault(); handleGroup(); break;
        case 'z': case 'Z':
          if (!state.isGrouping) { e.preventDefault(); handleUndo(); } break;
        case ' ':
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
  const nextIdx = state.currentIndex + 1;
  if (nextIdx >= state.photos.length) return; // No next photo
  
  state.sideBySide = true;
  $('photo-stage').classList.add('side-by-side-mode');
  $('next-preview').style.display = 'none';
}

function disableSideBySide() {
  if (!state.sideBySide) return;
  state.sideBySide = false;
  $('photo-stage').classList.remove('side-by-side-mode');
  $('next-preview').style.display = '';
}

// ═══════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════

function setupEventListeners() {
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

  // Fullscreen viewer — click to close
  $('fullscreen-viewer').addEventListener('click', () => {
    $('fullscreen-viewer').classList.remove('active');
  });

  // Side photo click to disable
  $('side-photo-card').addEventListener('click', disableSideBySide);

  // Toggle side-by-side via preview click
  $('next-preview').addEventListener('click', toggleSideBySide);

  // Done screen — restart
  $('restart-btn').addEventListener('click', () => showScreen('folder'));
}
