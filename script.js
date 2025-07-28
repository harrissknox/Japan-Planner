/*
 * script.js
 *
 * A self-contained JavaScript module implementing the trip planning
 * application without relying on any external libraries.  It manages
 * state for three couples, renders a calendar and list of events,
 * tracks packing lists and provides a shared view combining all
 * itineraries.  All DOM manipulation happens here.
 */

// Define colour palettes used to distinguish between event types and
// couples.  These values mirror those in style.css.  Feel free to
// adjust them to suit your own preferences.
const EVENT_TYPE_COLORS = {
  // Assign a distinct pastel colour to each supported event type.  These
  // colours are chosen to harmonise with the overall theme while
  // differentiating between flights, lodging, activities and the newly
  // introduced commute, food and exploration categories.
  flight: '#e17055',      // orange-red
  lodging: '#0984e3',     // blue
  activity: '#00b894',    // green
  commute: '#fdcb6e',     // golden yellow
  food: '#fab1a0',        // peach
  exploration: '#55efc4'  // mint
};

// File paths to cute anime-style icons representing each event type.
// These images live in the images folder within the project.  They
// match the pastel palette used throughout the site and add a bit of
// whimsy without referencing specific characters or brands.
const EVENT_TYPE_ICONS = {
  // Map each event type to its corresponding chibi-style icon.  These
  // PNGs live in the images directory and were generated specifically
  // for this project.  Icons for commute, food and exploration were
  // added to reflect the expanded set of activities.
  flight: 'images/icon_flight.png',
  lodging: 'images/icon_lodging.png',
  activity: 'images/icon_activity.png',
  commute: 'images/icon_commute.png',
  food: 'images/icon_food.png',
  exploration: 'images/icon_exploration.png'
};

// Firebase configuration injected by the user.  These values are used to
// initialise the Firebase app and connect to the Firestore database.  In a
// production deployment you may wish to obfuscate or restrict these keys
// via environment variables or a back‑end proxy.  For development and
// collaboration, exposing them here is acceptable because database rules
// will control access.
const firebaseConfig = {
  apiKey: "AIzaSyCVvTGNJ0z3tWLB-ARcayaBpAmjFruYExM",
  authDomain: "japan-trip-planner-14298.firebaseapp.com",
  projectId: "japan-trip-planner-14298",
  // Use the canonical appspot.com bucket.  The previous
  // firebasestorage.app domain was incorrect and may prevent
  // initialisation.
  storageBucket: "japan-trip-planner-14298.appspot.com",
  messagingSenderId: "417800233433",
  appId: "1:417800233433:web:0d8aabb780fe0e443bf9c8"
};

// Initialise Firebase and obtain a Firestore instance.  The compat
// libraries loaded in index.html expose the global `firebase` object.  We
// perform initialisation outside of DOMContentLoaded so that it happens
// synchronously.  If initialisation fails (e.g., offline), db will be
// undefined and the planner will fall back to localStorage persistence.
let db;
// Control whether localStorage is used as a fallback persistence layer.
// When set to false, the planner will not attempt to load from or
// save to localStorage.  This is desirable for public deployments
// where collaboration relies solely on Firestore.
const useLocalStorage = false;
// Track the time of the last local update.  This value is compared
// against the `lastUpdated` timestamp stored in Firestore to
// prevent stale snapshots from overwriting more recent local
// changes.  Whenever the planner writes to Firestore, it sets
// `localUpdateTime` to the current epoch milliseconds.
let localUpdateTime = 0;

/**
 * Display an error message to the user.  If an element with id
 * `error-banner` exists, it updates its contents and makes it
 * visible.  Otherwise, it creates a new banner and inserts it
 * before the root element.  Use this when Firebase cannot be
 * initialised or when a save fails.
 *
 * @param {string} msg The message to display
 */
function displayError(msg) {
  let banner = document.getElementById('error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'error-banner';
    banner.className = 'error-banner';
    // Insert banner at the top of the body before the root container
    const root = document.getElementById('root');
    if (root && root.parentNode) {
      root.parentNode.insertBefore(banner, root);
    } else {
      document.body.insertBefore(banner, document.body.firstChild);
    }
  }
  banner.textContent = msg;
  banner.style.display = 'block';
}
try {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
} catch (e) {
  console.warn('Firebase initialisation failed:', e);
  db = null;
}

/**
 * Save the current planner state to Firestore.  If the database is
 * unavailable (db is null), this function does nothing.  The
 * document path 'planner/main' is used to store a single document
 * containing the entire couples array.  Firestore handles JSON
 * serialisation of nested objects and arrays automatically.
 */
function saveToFirestore() {
  if (!db) {
    // Reject if Firestore is unavailable.  Callers can choose to
    // handle this and remove local changes accordingly.
    return Promise.reject(new Error('Firestore not available'));
  }
  // When saving to Firestore, include a `lastUpdated` field with
  // the current time.  Also update the in-memory localUpdateTime so
  // that subsequent snapshots can be compared.  Firestore stores
  // numbers as doubles, which suffices for millisecond timestamps.
  const now = Date.now();
  localUpdateTime = now;
  const payload = { couples, lastUpdated: now };
  // Write the planner document and then read it back to verify that
  // the write succeeded.  If the verification fails, reject the
  // promise so callers can handle the error.
  const docRef = db.collection('planner').doc('main');
  return docRef.set(payload).then(() => {
    return docRef.get().then(snap => {
      const data = snap.exists ? snap.data() : null;
      // If the document is missing or the lastUpdated timestamp does not
      // match our localUpdateTime, treat this as a failure.  This
      // double-checks that our write reached the server and is
      // readable from the client.
      if (!data || data.lastUpdated !== now) {
        throw new Error('Write verification failed');
      }
    });
  });
}

/**
 * Subscribe to Firestore updates.  When the document at
 * 'planner/main' changes, this listener updates the in-memory
 * `couples` array and triggers a re-render.  If the document does
 * not yet exist, it will be created on the first save.  If the
 * database is unavailable, this function falls back to loadData()
 * and renders immediately.
 */
function initRealtimeUpdates() {
  if (!db) {
    // Unable to connect to Firestore.  Show an error and
    // continue rendering with empty data.  We do not fall back
    // to localStorage in public deployments to avoid diverging
    // copies.  Users will not be able to save changes.
    displayError('Cannot connect to the server. Changes will not be saved.');
    render();
    return;
  }
  db.collection('planner').doc('main').onSnapshot(doc => {
    // Skip local snapshots triggered by pending writes to prevent
    // outdated data from overwriting recent local changes.  The
    // metadata.hasPendingWrites property identifies snapshots that
    // reflect local changes not yet committed to the server.
    if (doc.metadata && doc.metadata.hasPendingWrites) {
      return;
    }
    // Skip local snapshots triggered by pending writes to prevent
    // outdated data from overwriting recent local changes.  The
    // metadata.hasPendingWrites property identifies snapshots that
    // reflect local changes not yet committed to the server.
    if (doc.metadata && doc.metadata.hasPendingWrites) {
      return;
    }
    if (doc.exists) {
      const data = doc.data();
      // Only merge data from Firestore if it is at least as recent as
      // the most recent local update.  The `lastUpdated` field is a
      // millisecond timestamp included in every save.  If it's
      // undefined, treat the snapshot as older (i.e. ignore it) to
      // avoid overwriting local changes.
      if (data && typeof data.lastUpdated === 'number' && data.lastUpdated >= localUpdateTime) {
        // Update our local marker before merging.  This ensures
        // subsequent saves use the server's timestamp as the base.
        localUpdateTime = data.lastUpdated;
        if (Array.isArray(data.couples)) {
          data.couples.forEach(savedCouple => {
            const current = couples.find(c => c.id === savedCouple.id);
            if (current) {
              current.name = savedCouple.name || current.name;
              current.events = Array.isArray(savedCouple.events) ? savedCouple.events : [];
              current.packingList = Array.isArray(savedCouple.packingList) ? savedCouple.packingList : [];
              current.preTripList = Array.isArray(savedCouple.preTripList) ? savedCouple.preTripList : [];
            }
          });
        }
      }
    } else {
      // Firestore document doesn't exist yet.  Attempt to load any
      // locally stored data and display it.  Users can then save to
      // Firestore by triggering any update.
      loadData();
    }
    // Always call render after snapshot to refresh the UI.  If
    // nothing changed, render is a no-op due to diffing.
    render();
  }, err => {
    console.error('Failed to subscribe to Firestore:', err);
    displayError('Failed to subscribe to server updates. Changes will not be saved.');
    render();
  });
}

const COUPLE_COLORS = {
  couple1: '#6c5ce7', // purple
  couple2: '#d63031', // red
  couple3: '#00b894'  // green
};

// Initialise the couples with empty events and packing lists.
const couples = [
  // Update couple names to reflect the actual travellers.  Each couple
  // maintains its own list of events, packing items and pre-trip
  // checklist tasks.  The ids remain stable so that colours and
  // references elsewhere in the code continue to function correctly.
  { id: 'couple1', name: 'Harrison & Abby', events: [], packingList: [], preTripList: [] },
  { id: 'couple2', name: 'Brandon & Mary', events: [], packingList: [], preTripList: [] },
  { id: 'couple3', name: 'Hudson & Savannah', events: [], packingList: [], preTripList: [] }
];

// -----------------------------------------------------------------------------
// Persistence helpers
//
// Travellers often close and reopen their browser while planning.  To ensure
// that their itinerary, packing list and pre‑trip tasks persist across
// sessions, we store the current state of the `couples` array in
// `localStorage` under a fixed key.  loadData() reads from localStorage and
// merges saved information back into our in‑memory structures, while
// saveData() serialises the minimal required fields to JSON and writes them
// back.  If localStorage is unavailable (e.g. private browsing or disabled
// storage), these functions silently fail.

/**
 * Load persisted data from localStorage and merge it into the current
 * `couples` array.  This function should be called once at startup before
 * the initial render.  It preserves the order of couples and only updates
 * recognised fields (name, events, packingList, preTripList) so that any
 * additional properties or functions remain intact.
 */
function loadData() {
  // Do not load from localStorage if disabled.  This avoids
  // presenting stale or divergent data when deploying publicly.
  if (!useLocalStorage) return;
  try {
    const raw = localStorage.getItem('japanTripPlannerData');
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.couples)) return;
    saved.couples.forEach(savedCouple => {
      const current = couples.find(c => c.id === savedCouple.id);
      if (current) {
        // Preserve the couple name if provided.  Users may customise the
        // names through code or future UI, so we restore it here.
        if (typeof savedCouple.name === 'string') {
          current.name = savedCouple.name;
        }
        // Replace arrays wholesale to avoid merging duplicates.  If
        // localStorage contains malformed data, fallback to empty arrays.
        current.events = Array.isArray(savedCouple.events) ? savedCouple.events : [];
        current.packingList = Array.isArray(savedCouple.packingList) ? savedCouple.packingList : [];
        current.preTripList = Array.isArray(savedCouple.preTripList) ? savedCouple.preTripList : [];
      }
    });
  } catch (err) {
    console.error('Failed to load persisted trip planner data:', err);
  }
}

/**
 * Persist the current state of the `couples` array to localStorage.  Only
 * serialise primitive values and arrays; functions and DOM nodes are not
 * stored.  This function should be invoked whenever the state mutates
 * (adding, deleting or toggling items).  Errors during saving are
 * logged but do not interrupt the user experience.
 */
function saveData() {
  // Skip saving to localStorage if disabled.  This prevents
  // divergent copies of the itinerary when the app is deployed
  // publicly.  Persisting locally is only useful during offline
  // development.
  if (!useLocalStorage) return;
  try {
    const payload = {
      couples: couples.map(c => ({
        id: c.id,
        name: c.name,
        events: c.events,
        packingList: c.packingList,
        preTripList: c.preTripList
      }))
    };
    localStorage.setItem('japanTripPlannerData', JSON.stringify(payload));
  } catch (err) {
    console.error('Failed to save trip planner data:', err);
  }
}

/**
 * Attempt to persist the current state to Firestore.  If the
 * underlying save fails (e.g. due to network or rules), this helper
 * will surface the error to the user via the error banner.  It
 * returns a promise that resolves or rejects with the result of
 * saveToFirestore().
 */
function safeSave() {
  return saveToFirestore().catch(err => {
    console.error('Failed to sync with Firestore:', err);
    displayError('Failed to sync with the server. Your changes may not be saved.');
    throw err;
  });
}

// Application-level state: which couple is active, the current view
// (calendar/list/packing) and which week of April 2026 is currently
// being displayed.  The trip is in April 2026, so we compute all
// weeks covering that month up front.  Each week begins on a
// Sunday.  currentWeekIndex refers into the `aprilWeeks` array.
let activeId = 'couple1';
let viewMode = 'calendar';

// Precompute week start dates (Sundays) covering April 2026.  We
// generate weeks starting from the Sunday before April 1 through
// the week that ends after April 30.  This allows navigation
// through all April weeks while still highlighting days outside
// April as part of adjacent weeks.
function generateAprilWeeks() {
  const weeks = [];
  const year = 2026;
  // The trip runs from April 4 to April 18, 2026.  Begin the first
  // week on the Sunday immediately before April 4 (March 29) and end
  // with the week that contains April 18.  This yields the minimal
  // set of weekly slices covering the trip.
  const tripStart = new Date(year, 3, 4); // April 4
  const tripEnd = new Date(year, 3, 18);  // April 18
  // Find the Sunday prior to the trip start
  const firstWeekStart = new Date(tripStart);
  firstWeekStart.setDate(tripStart.getDate() - tripStart.getDay());
  let weekStart = firstWeekStart;
  while (weekStart <= tripEnd) {
    weeks.push(new Date(weekStart));
    weekStart = new Date(weekStart);
    weekStart.setDate(weekStart.getDate() + 7);
  }
  return weeks;
}

const aprilWeeks = generateAprilWeeks();
let currentWeekIndex = 0;

// Entry point: build the interface once the DOM has loaded.
// When the document has loaded, restore any persisted state from
// localStorage and then render the planner.  Doing this in the
// DOMContentLoaded handler ensures the DOM is available for
// manipulation and the page reflects previously entered data.
document.addEventListener('DOMContentLoaded', () => {
  // Start listening to Firestore changes or fall back to localStorage.
  initRealtimeUpdates();
  // Render immediately to display the base UI while waiting for
  // Firestore.  Subsequent snapshots will trigger additional renders.
  render();
});

/**
 * Identify overlapping events across couples and render a summary
 * section.  An overlap occurs when two or more couples have events
 * on the same date with the same title (case-insensitive).
 *
 * @param {Array<Object>} events - A list of events with date, title,
 *   time and coupleId.
 * @returns {HTMLElement} A DOM element containing the overlaps
 *   summary.  If no overlaps exist, a small explanatory paragraph
 *   is returned instead.
 */

/**
 * Remove an event from the itinerary by its unique identifier.  This
 * helper searches through all couples' event arrays, finds the
 * matching event and removes it.  Afterwards it triggers a re-render
 * to update the UI.  If no event with the given ID exists, no
 * changes are made.
 *
 * @param {string} eventId - The ID of the event to remove
 */
function deleteEventById(eventId) {
  let removed;
  for (const c of couples) {
    const idx = c.events.findIndex(ev => ev.id === eventId);
    if (idx !== -1) {
      // Remove the event and keep a reference in case the save fails
      removed = c.events.splice(idx, 1)[0];
      break;
    }
  }
  // Persist changes both locally and remotely.  If the save
  // fails, put the event back so the UI remains consistent.
  saveData();
  safeSave().then(() => {
    render();
  }).catch(() => {
    if (removed) {
      // Restore the event to its couple
      const target = couples.find(c => c.id === removed.coupleId);
      if (target) {
        target.events.push(removed);
      }
    }
    render();
  });
}

/**
 * Render the enhanced shared view.  This function replaces the
 * original renderSharedView by adding a section that highlights
 * overlapping activities across couples.  It also preserves the
 * calendar/list toggles and colours events by couple.
 */
function renderSharedEnhanced() {
  const wrapper = document.createElement('div');
  // Heading
  const h2 = document.createElement('h2');
  h2.textContent = 'Shared Itinerary';
  wrapper.appendChild(h2);
  // Gather events across couples
  const allEvents = couples.flatMap(c => c.events.map(ev => ({ ...ev, coupleId: c.id })));
  // Overlap section
  const overlap = renderSharedOverlaps(allEvents);
  wrapper.appendChild(overlap);
  // Toggle bar
  const toggleBar = document.createElement('div');
  toggleBar.style.marginBottom = '0.5rem';
  const createToggle = (mode, label) => {
    const btn = document.createElement('button');
    btn.className = 'nav-button' + (viewMode === mode ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      viewMode = mode;
      render();
    });
    return btn;
  };
  toggleBar.appendChild(createToggle('calendar', 'Calendar View'));
  toggleBar.appendChild(createToggle('list', 'List View'));
  wrapper.appendChild(toggleBar);
  // Content
  if (viewMode === 'calendar') {
    wrapper.appendChild(renderCalendar(allEvents, ev => COUPLE_COLORS[ev.coupleId] || '#b2bec3'));
  } else {
    wrapper.appendChild(renderListView(allEvents, ev => COUPLE_COLORS[ev.coupleId] || '#b2bec3'));
  }
  return wrapper;
}

/**
 * Re-render the entire application.  This function clears the root
 * element and rebuilds the navigation bar and the content area
 * according to the current state.  It should be called whenever
 * underlying data changes (e.g., adding an event or toggling a
 * packing list item).
 */
function render() {
  const root = document.getElementById('root');
  root.innerHTML = '';
  root.appendChild(renderNavBar());
  const container = document.createElement('div');
  container.className = 'container';
  root.appendChild(container);
  if (activeId === 'shared') {
    // Use the enhanced shared view that includes overlapping activity summaries
    container.appendChild(renderSharedEnhanced());
  } else {
    const couple = couples.find(c => c.id === activeId);
    if (couple) {
      container.appendChild(renderCoupleView(couple));
    }
  }
}

/**
 * Build the top navigation bar.  Each button corresponds to a
 * couple or to the shared view.  Clicking a button updates the
 * application state and triggers a re-render.
 */
function renderNavBar() {
  const nav = document.createElement('nav');
  nav.className = 'nav-bar';
  // Couple buttons
  couples.forEach(couple => {
    const btn = document.createElement('button');
    btn.className = 'nav-button' + (activeId === couple.id ? ' active' : '');
    btn.textContent = couple.name;
    btn.addEventListener('click', () => {
      activeId = couple.id;
      render();
    });
    nav.appendChild(btn);
  });
  // Shared button
  const sharedBtn = document.createElement('button');
  sharedBtn.className = 'nav-button' + (activeId === 'shared' ? ' active' : '');
  sharedBtn.textContent = 'Shared';
  sharedBtn.addEventListener('click', () => {
    activeId = 'shared';
    // Reset view mode if currently on packing (not available in shared)
    if (viewMode === 'packing') viewMode = 'calendar';
    render();
  });
  nav.appendChild(sharedBtn);
  return nav;
}

/**
 * Render the page for a single couple.  This view includes tabs to
 * switch between calendar, list and packing views, the selected
 * presentation of events and the form to add new events.  All
 * elements are rebuilt every time renderCoupleView is invoked.
 */
function renderCoupleView(couple) {
  const wrapper = document.createElement('div');
  // Heading
  const heading = document.createElement('h2');
  heading.textContent = `${couple.name} Itinerary`;
  wrapper.appendChild(heading);
  // View toggles
  const toggleBar = document.createElement('div');
  toggleBar.style.marginBottom = '0.5rem';
  // Helper to create a toggle button
  const createToggle = (mode, label) => {
    const btn = document.createElement('button');
    btn.className = 'nav-button' + (viewMode === mode ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      viewMode = mode;
      render();
    });
    return btn;
  };
  toggleBar.appendChild(createToggle('calendar', 'Calendar View'));
  toggleBar.appendChild(createToggle('list', 'List View'));
  toggleBar.appendChild(createToggle('packing', 'Packing List'));
  // Additional view for tasks to complete before the trip begins.
  toggleBar.appendChild(createToggle('pretrip', 'Pre‑Trip Checklist'));
  wrapper.appendChild(toggleBar);
  // Render selected view
  if (viewMode === 'calendar') {
    wrapper.appendChild(renderCalendar(couple.events, ev => EVENT_TYPE_COLORS[ev.type] || '#b2bec3'));
  } else if (viewMode === 'list') {
    wrapper.appendChild(renderListView(couple.events, ev => EVENT_TYPE_COLORS[ev.type] || '#b2bec3'));
  } else if (viewMode === 'packing') {
    wrapper.appendChild(renderPackingList(couple));
  } else if (viewMode === 'pretrip') {
    wrapper.appendChild(renderPreTripList(couple));
  }
  // Event form
  wrapper.appendChild(renderEventForm(couple));
  return wrapper;
}

/**
 * Render the shared view.  This view combines events from all couples
 * and provides calendar/list toggles.  Colours are derived from the
 * couple rather than from the event type.
 */
function renderSharedView() {
  const wrapper = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = 'Shared Itinerary';
  wrapper.appendChild(heading);
  // View toggles (calendar/list only)
  const toggleBar = document.createElement('div');
  toggleBar.style.marginBottom = '0.5rem';
  // Reuse helper for toggle
  const createToggle = (mode, label) => {
    const btn = document.createElement('button');
    btn.className = 'nav-button' + (viewMode === mode ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      viewMode = mode;
      render();
    });
    return btn;
  };
  toggleBar.appendChild(createToggle('calendar', 'Calendar View'));
  toggleBar.appendChild(createToggle('list', 'List View'));
  wrapper.appendChild(toggleBar);
  // Gather all events with coupleId included
  const allEvents = couples.flatMap(c => c.events.map(ev => ({ ...ev, coupleId: c.id })));
  // First render the shared overlaps section.  This section lists
  // activities that appear in multiple couples' itineraries on the
  // same day.  It sits above the calendar or list view so travellers
  // can quickly see opportunities to plan together.
  wrapper.appendChild(renderSharedOverlaps(allEvents));
  // Then render the calendar or list view with colours keyed by couple
  if (viewMode === 'calendar') {
    wrapper.appendChild(renderCalendar(allEvents, ev => COUPLE_COLORS[ev.coupleId] || '#b2bec3'));
  } else {
    wrapper.appendChild(renderListView(allEvents, ev => COUPLE_COLORS[ev.coupleId] || '#b2bec3'));
  }
  return wrapper;
}

/**
 * Compute and render a list of overlapping activities across couples.
 * Two or more events are considered overlapping when they share the
 * same title (case-insensitive) and occur on the same date, but can
 * have different times.  The returned element contains a heading
 * followed by a list of these shared activities, including which
 * couples are participating and at what times.  If no overlaps are
 * found, a message is displayed instead.
 *
 * @param {Array} events - Array of events with at least {title, date, coupleId, time}
 */
function renderSharedOverlaps(events) {
  const section = document.createElement('div');
  section.className = 'overlap-section';
  const heading = document.createElement('h3');
  heading.textContent = 'Shared Activities Across Trip';
  section.appendChild(heading);
  // Group events by lowercased title only (ignore date) so that we
  // highlight activities that multiple couples have planned at
  // different times or days during the trip.  Each group will
  // contain all events with the same title regardless of date.
  const grouped = {};
  events.forEach(ev => {
    const key = ev.title.trim().toLowerCase();
    (grouped[key] = grouped[key] || []).push(ev);
  });
  // Filter titles where more than one distinct couple appears.  Use a
  // set to count unique couples per title.
  const overlappingKeys = Object.keys(grouped).filter(key => {
    const g = grouped[key];
    const coupleSet = new Set(g.map(ev => ev.coupleId));
    return coupleSet.size > 1;
  });
  if (!overlappingKeys.length) {
    const p = document.createElement('p');
    p.textContent = 'No shared activities across different couples yet.';
    section.appendChild(p);
    return section;
  }
  // Sort alphabetically by title for a consistent order
  overlappingKeys.sort((a, b) => a.localeCompare(b));
  overlappingKeys.forEach(key => {
    const group = grouped[key];
    // Create container for each shared activity title
    const itemDiv = document.createElement('div');
    itemDiv.className = 'overlap-item';
    // Title header (capitalised original title)
    const titleDiv = document.createElement('div');
    titleDiv.className = 'overlap-item-title';
    // Use the first occurrence to preserve the original casing
    const originalTitle = group[0].title;
    titleDiv.textContent = originalTitle;
    itemDiv.appendChild(titleDiv);
    // Details list: list each couple with date and time
    const ul = document.createElement('ul');
    ul.className = 'overlap-item-details';
    // Sort entries by date then time
    group.sort((a, b) => {
      const dComp = a.date.localeCompare(b.date);
      if (dComp !== 0) return dComp;
      const tA = a.time || '';
      const tB = b.time || '';
      return tA.localeCompare(tB);
    });
    group.forEach(ev => {
      const li = document.createElement('li');
      const couple = couples.find(c => c.id === ev.coupleId);
      const name = couple ? couple.name : ev.coupleId;
      // Format date
      const [yy, mm, dd] = ev.date.split('-').map(n => parseInt(n, 10));
      const dateObj = new Date(yy, mm - 1, dd);
      const dateStr = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      li.textContent = `${name} – ${dateStr}${ev.time ? ' at ' + ev.time : ''}`;
      ul.appendChild(li);
    });
    itemDiv.appendChild(ul);
    section.appendChild(itemDiv);
  });
  return section;
}

/**
 * Render a month-view calendar.  Given a list of events and a
 * function to determine the colour for each event, this function
 * builds a 6-row grid (42 cells) representing the current month
 * including days from the previous and next months to fill the grid.
 */
function renderCalendar(events, colorFn) {
  // Weekly view restricted to April 2026.  Compute the current
  // week's start date from the aprilWeeks array.  Each week is a
  // Sunday-through-Saturday slice.  Days outside of April are
  // displayed but grayed out via the 'other-month' class.
  const calendarDiv = document.createElement('div');
  calendarDiv.className = 'calendar';
  // Header with previous/next week controls
  const header = document.createElement('div');
  header.className = 'calendar-header';
  const prevBtn = document.createElement('button');
  prevBtn.textContent = '◀';
  prevBtn.addEventListener('click', () => {
    if (currentWeekIndex > 0) {
      currentWeekIndex--;
      render();
    }
  });
  const nextBtn = document.createElement('button');
  nextBtn.textContent = '▶';
  nextBtn.addEventListener('click', () => {
    if (currentWeekIndex < aprilWeeks.length - 1) {
      currentWeekIndex++;
      render();
    }
  });
  // Title showing the date range of the current week
  const title = document.createElement('div');
  title.className = 'calendar-title';
  const weekStart = aprilWeeks[currentWeekIndex];
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const options = { month: 'short', day: 'numeric' };
  title.textContent = `${weekStart.toLocaleDateString(undefined, options)} – ${weekEnd.toLocaleDateString(undefined, options)}, ${weekStart.getFullYear()}`;
  header.appendChild(prevBtn);
  header.appendChild(title);
  header.appendChild(nextBtn);
  calendarDiv.appendChild(header);
  // Build a table with one row for days and one row for events
  const table = document.createElement('table');
  table.className = 'calendar-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach((dow, idx) => {
    const th = document.createElement('th');
    const dayDate = new Date(weekStart);
    dayDate.setDate(weekStart.getDate() + idx);
    // Display day of week and date
    th.innerHTML = `<div>${dow}</div><div style="font-weight:bold">${dayDate.getDate()}</div>`;
    if (dayDate.getMonth() !== 3) th.classList.add('other-month');
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');
  for (let idx = 0; idx < 7; idx++) {
    const dayCell = document.createElement('td');
    const dayDate = new Date(weekStart);
    dayDate.setDate(weekStart.getDate() + idx);
    if (dayDate.getMonth() !== 3) dayCell.classList.add('other-month');
    // Build events list for this day
    const eventsDiv = document.createElement('div');
    eventsDiv.className = 'events';
    // Format date string for comparison
    const pad = n => (n < 10 ? '0' + n : '' + n);
    const iso = `${dayDate.getFullYear()}-${pad(dayDate.getMonth() + 1)}-${pad(dayDate.getDate())}`;
    const eventsForDay = events.filter(ev => ev.date === iso);
    // Sort by time if present
    eventsForDay.sort((a, b) => {
      const tA = a.time || '';
      const tB = b.time || '';
      return tA.localeCompare(tB);
    });
    eventsForDay.forEach(ev => {
      // Create a tag element to hold the icon, text and delete button.
      const tag = document.createElement('span');
      tag.className = 'event-tag';
      tag.style.backgroundColor = colorFn(ev);
      // Tooltip includes type and optional time for accessibility.
      tag.title = `${ev.title} (${ev.type}${ev.time ? ' at ' + ev.time : ''})`;
      // Append small icon corresponding to the event type.
      const iconSrc = EVENT_TYPE_ICONS[ev.type];
      if (iconSrc) {
        const img = document.createElement('img');
        img.src = iconSrc;
        img.alt = ev.type;
        tag.appendChild(img);
      }
      // Append a span containing the time and title.
      const textSpan = document.createElement('span');
      textSpan.textContent = ev.time ? `${ev.time} ${ev.title}` : ev.title;
      tag.appendChild(textSpan);
      // Add a small delete button.  Clicking it removes the event
      // without triggering any other handlers (stopPropagation).
      const delBtn = document.createElement('span');
      delBtn.className = 'delete-btn';
      delBtn.textContent = '×';
      delBtn.title = 'Delete this event';
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        deleteEventById(ev.id);
      });
      tag.appendChild(delBtn);
      eventsDiv.appendChild(tag);
    });
    dayCell.appendChild(eventsDiv);
    tr.appendChild(dayCell);
  }
  tbody.appendChild(tr);
  table.appendChild(tbody);
  calendarDiv.appendChild(table);
  return calendarDiv;
}

/**
 * Render a chronological list of events.  Events are grouped by date
 * and sorted ascending.  Each event displays its title, type and
 * optional cost and details.  A coloured bar down the left hints
 * at either the event type (in couple view) or the couple (in
 * shared view).
 */
function renderListView(events, colorFn) {
  const listDiv = document.createElement('div');
  listDiv.className = 'list-view';
  if (!events.length) {
    const p = document.createElement('p');
    p.textContent = 'No events yet. Use the form below to add flights, lodging, activities, commutes, food or exploration plans.';
    listDiv.appendChild(p);
    return listDiv;
  }
  // Sort events by date and time ascending.  Treat undefined times as
  // empty strings so they sort first.
  const sorted = events.slice().sort((a, b) => {
    const dComp = a.date.localeCompare(b.date);
    if (dComp !== 0) return dComp;
    const tA = a.time || '';
    const tB = b.time || '';
    return tA.localeCompare(tB);
  });
  // Group events by date
  const grouped = {};
  sorted.forEach(ev => {
    (grouped[ev.date] = grouped[ev.date] || []).push(ev);
  });
  Object.keys(grouped).forEach(date => {
    const dayDiv = document.createElement('div');
    dayDiv.className = 'list-day';
    const h4 = document.createElement('h4');
    // Create a Date object from the YYYY-MM-DD string in local time
    const [yy, mm, dd] = date.split('-').map(n => parseInt(n, 10));
    const dateObj = new Date(yy, mm - 1, dd);
    h4.textContent = dateObj.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    dayDiv.appendChild(h4);
    const ul = document.createElement('ul');
    ul.style.padding = 0;
    grouped[date].forEach(ev => {
      const li = document.createElement('li');
      li.className = 'list-item';
      li.style.borderLeftColor = colorFn(ev);
      const titleDiv = document.createElement('div');
      titleDiv.className = 'item-title';
      // Prepend a cute icon based on event type.  Using prepend
      // ensures the icon appears before the time and title.
      const iconSrc = EVENT_TYPE_ICONS[ev.type];
      if (iconSrc) {
        const img = document.createElement('img');
        img.src = iconSrc;
        img.alt = ev.type;
        img.className = 'list-icon';
        titleDiv.appendChild(img);
      }
      // Display time if present
      if (ev.time) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'item-time';
        timeSpan.textContent = `${ev.time} `;
        titleDiv.appendChild(timeSpan);
      }
      // Title
      const titleSpan = document.createElement('span');
      titleSpan.textContent = ev.title;
      titleDiv.appendChild(titleSpan);
      // Type
      const typeSpan = document.createElement('span');
      typeSpan.className = 'item-type';
      typeSpan.textContent = ` (${ev.type})`;
      titleDiv.appendChild(typeSpan);
      // Paid indicator or cost.  If the event has been marked as
      // paid, display a small badge; otherwise, show the cost if it
      // exists.  The cost is formatted with a preceding dollar sign.
      if (ev.paid) {
        const paidSpan = document.createElement('span');
        paidSpan.className = 'item-paid';
        paidSpan.textContent = 'Paid';
        titleDiv.appendChild(paidSpan);
      } else if (ev.cost) {
        const costSpan = document.createElement('span');
        costSpan.className = 'item-cost';
        costSpan.textContent = ` - $${ev.cost}`;
        titleDiv.appendChild(costSpan);
      }
      li.appendChild(titleDiv);
      // Details
      if (ev.details) {
        const detailsDiv = document.createElement('div');
        detailsDiv.style.fontSize = '0.8rem';
        detailsDiv.style.marginTop = '2px';
        detailsDiv.textContent = ev.details;
        li.appendChild(detailsDiv);
      }
      // Add delete button at the end of the list item.  This button
      // appears after the title and details and removes the event when
      // clicked.  Use a span with a class for consistent styling.
      const delBtn = document.createElement('span');
      delBtn.className = 'delete-btn';
      delBtn.textContent = '×';
      delBtn.title = 'Delete this event';
      delBtn.style.marginLeft = '8px';
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        deleteEventById(ev.id);
      });
      titleDiv.appendChild(delBtn);
      ul.appendChild(li);
    });
    dayDiv.appendChild(ul);
    listDiv.appendChild(dayDiv);
  });
  return listDiv;
}

/**
 * Render the packing list view.  Shows all current packing items
 * with checkboxes and provides an input to add new items.  Clicking
 * on a checkbox or the text toggles completion.  Items that are
 * checked appear with a strike-through.
 */
function renderPackingList(couple) {
  const section = document.createElement('div');
  section.className = 'packing-list';
  const h3 = document.createElement('h3');
  h3.textContent = 'Packing List';
  section.appendChild(h3);
  // Input line to add new items
  const inputContainer = document.createElement('div');
  inputContainer.className = 'packing-input';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Add item';
  inputContainer.appendChild(input);
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  inputContainer.appendChild(addBtn);
  section.appendChild(inputContainer);
  // Event handler to add item
  function addItem() {
    const text = input.value.trim();
    if (!text) return;
    couple.packingList.push({ text, checked: false });
    input.value = '';
    // Persist packing list locally and remotely
    saveData();
    safeSave().finally(() => {
      render();
    });
  }
  addBtn.addEventListener('click', addItem);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addItem();
    }
  });
  // List existing items
  const listContainer = document.createElement('div');
  listContainer.style.marginTop = '0.5rem';
  if (!couple.packingList.length) {
    const p = document.createElement('p');
    p.textContent = 'No items yet. Start adding packing items!';
    listContainer.appendChild(p);
  } else {
    couple.packingList.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'packing-item';
      // Checkbox to mark an item as packed/unpacked
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.checked;
      checkbox.addEventListener('change', () => {
        item.checked = !item.checked;
        saveData();
        safeSave().finally(() => {
          render();
        });
      });
      row.appendChild(checkbox);
      // Text span for the item description.  Clicking toggles the
      // packed state for convenience.
      const span = document.createElement('span');
      span.textContent = item.text;
      if (item.checked) span.classList.add('checked');
      span.addEventListener('click', () => {
        item.checked = !item.checked;
        saveData();
        safeSave().finally(() => {
          render();
        });
      });
      row.appendChild(span);
      // Delete button to remove the packing item
      const delBtn = document.createElement('span');
      delBtn.className = 'delete-btn';
      delBtn.textContent = '×';
      delBtn.title = 'Delete this item';
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        couple.packingList.splice(index, 1);
        saveData();
        safeSave().finally(() => {
          render();
        });
      });
      row.appendChild(delBtn);
      listContainer.appendChild(row);
    });
  }
  section.appendChild(listContainer);
  return section;
}

/**
 * Render a pre‑trip checklist for a couple.  Travellers can add
 * tasks they need to complete before departure (e.g., obtaining
 * passports, filling out hotel details).  Each task may optionally
 * include a due date prior to the trip start.  Tasks can be
 * checked off when completed or removed entirely.
 *
 * @param {Object} couple The couple whose checklist is being rendered.
 */
function renderPreTripList(couple) {
  const section = document.createElement('div');
  section.className = 'pretrip-list';
  const h3 = document.createElement('h3');
  h3.textContent = 'Pre‑Trip Checklist';
  section.appendChild(h3);
  // Input container for adding new tasks
  const inputContainer = document.createElement('div');
  inputContainer.className = 'pretrip-input';
  // Text input for task description
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.placeholder = 'Add a task (e.g., renew passport)';
  inputContainer.appendChild(textInput);
  // Optional due date input (before trip start)
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  // Constrain due dates to before the trip.  Use March 1 as an
  // earliest reasonable start date and the day before the trip
  // begins (April 3, 2026) as the latest.  Browsers treat these
  // attributes as inclusive.
  dateInput.min = '2026-03-01';
  dateInput.max = '2026-04-03';
  dateInput.title = 'Due date (optional)';
  inputContainer.appendChild(dateInput);
  // Add button
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  inputContainer.appendChild(addBtn);
  section.appendChild(inputContainer);
  // Helper to add a new task
  function addTask() {
    const text = textInput.value.trim();
    if (!text) return;
    const task = { text, checked: false };
    const due = dateInput.value;
    if (due) task.dueDate = due;
    couple.preTripList.push(task);
    textInput.value = '';
    dateInput.value = '';
    // Persist pre-trip tasks locally and remotely
    saveData();
    safeSave().finally(() => {
      render();
    });
  }
  addBtn.addEventListener('click', addTask);
  textInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTask();
    }
  });
  // List existing tasks
  const listDiv = document.createElement('div');
  listDiv.style.marginTop = '0.5rem';
  if (!couple.preTripList.length) {
    const p = document.createElement('p');
    p.textContent = 'No pre‑trip tasks yet. Add tasks to get ready for your journey!';
    listDiv.appendChild(p);
  } else {
    couple.preTripList.forEach((task, index) => {
      const row = document.createElement('div');
      row.className = 'pretrip-item';
      // Checkbox to mark completion
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = task.checked;
      checkbox.addEventListener('change', () => {
        task.checked = !task.checked;
        saveData();
        safeSave().finally(() => {
          render();
        });
      });
      row.appendChild(checkbox);
      // Text label containing the task description and optional due date
      const labelSpan = document.createElement('span');
      labelSpan.textContent = task.text;
      if (task.checked) labelSpan.classList.add('checked');
      labelSpan.addEventListener('click', () => {
        task.checked = !task.checked;
        saveData();
        safeSave().finally(() => {
          render();
        });
      });
      row.appendChild(labelSpan);
      // Due date display
      if (task.dueDate) {
        const [yy, mm, dd] = task.dueDate.split('-').map(n => parseInt(n, 10));
        const dObj = new Date(yy, mm - 1, dd);
        const dateStr = dObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const dueSpan = document.createElement('span');
        dueSpan.className = 'task-date';
        dueSpan.textContent = ` (by ${dateStr})`;
        row.appendChild(dueSpan);
      }
      // Delete button
      const delBtn = document.createElement('span');
      delBtn.className = 'delete-btn';
      delBtn.textContent = '×';
      delBtn.title = 'Delete this task';
      delBtn.style.marginLeft = '8px';
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        couple.preTripList.splice(index, 1);
        saveData();
        safeSave().finally(() => {
          render();
        });
      });
      row.appendChild(delBtn);
      listDiv.appendChild(row);
    });
  }
  section.appendChild(listDiv);
  return section;
}

/**
 * Render the form used to add new events to a couple's itinerary.
 * Submitting the form pushes a new event onto the couple's array
 * and re-renders the application.  The form resets after each
 * submission.
 */
function renderEventForm(couple) {
  const formSection = document.createElement('div');
  formSection.className = 'form-section';
  const h3 = document.createElement('h3');
  h3.textContent = 'Add New Event';
  formSection.appendChild(h3);
  const form = document.createElement('form');
  // Create form groups
  const group1 = document.createElement('div');
  group1.className = 'form-group';
  // Type select
  const typeLabel = document.createElement('label');
  typeLabel.textContent = 'Type';
  const typeSelect = document.createElement('select');
  // Provide a fixed ordering of event types.  Removed the obsolete
  // 'budget' option and introduced commute, food and exploration.
  ['flight','lodging','activity','commute','food','exploration'].forEach(optVal => {
    const opt = document.createElement('option');
    opt.value = optVal;
    opt.textContent = optVal.charAt(0).toUpperCase() + optVal.slice(1);
    typeSelect.appendChild(opt);
  });
  typeLabel.appendChild(typeSelect);
  group1.appendChild(typeLabel);
  // Date input.  Use the native date picker to allow users to pick
  // the day from a calendar.  Browsers will fall back to a text box
  // if the date picker is unsupported.  The value is stored as
  // YYYY-MM-DD.
  const dateLabel = document.createElement('label');
  dateLabel.textContent = 'Date';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  // Restrict the date picker to the dates of the trip: April 4–18, 2026.
  // Browsers treat the min/max attributes as inclusive.
  dateInput.min = '2026-04-04';
  dateInput.max = '2026-04-18';
  dateLabel.appendChild(dateInput);
  group1.appendChild(dateLabel);
  // Time input (optional).  A select element lists times in 15
  // minute increments.  An empty value at the top allows the user to
  // leave the time unspecified.
  const timeLabel = document.createElement('label');
  timeLabel.textContent = 'Time';
  const timeInput = document.createElement('select');
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '—';
  timeInput.appendChild(emptyOpt);
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const hh = h.toString().padStart(2, '0');
      const mm = m.toString().padStart(2, '0');
      const opt = document.createElement('option');
      opt.value = `${hh}:${mm}`;
      opt.textContent = `${hh}:${mm}`;
      timeInput.appendChild(opt);
    }
  }
  timeLabel.appendChild(timeInput);
  group1.appendChild(timeLabel);
  // Title input
  const titleLabel = document.createElement('label');
  titleLabel.textContent = 'Title';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Event title';
  titleLabel.appendChild(titleInput);
  group1.appendChild(titleLabel);
  // Cost input.  We no longer hide this field based on the type; any
  // event can have an associated cost.  Leaving it blank records
  // no cost.
  const costLabel = document.createElement('label');
  costLabel.textContent = 'Cost (USD)';
  const costInput = document.createElement('input');
  costInput.type = 'number';
  costInput.step = '0.01';
  costInput.min = '0';
  costInput.placeholder = '0.00';
  costLabel.appendChild(costInput);
  group1.appendChild(costLabel);

  // Paid checkbox: indicates that this event has already been paid
  // for.  When checked, the cost input is disabled and cleared.  This
  // allows travellers to mark prepaid activities without entering a cost.
  const paidLabel = document.createElement('label');
  // Align the label contents horizontally
  paidLabel.style.display = 'flex';
  paidLabel.style.alignItems = 'center';
  paidLabel.style.gap = '4px';
  const paidCheckbox = document.createElement('input');
  paidCheckbox.type = 'checkbox';
  paidLabel.appendChild(paidCheckbox);
  paidLabel.appendChild(document.createTextNode('Already paid'));
  group1.appendChild(paidLabel);
  // Toggle cost field disabled state based on paid checkbox
  paidCheckbox.addEventListener('change', () => {
    if (paidCheckbox.checked) {
      costInput.disabled = true;
      costInput.value = '';
    } else {
      costInput.disabled = false;
    }
  });

  // The paid checkbox has already been defined above.  Append
  // group1 to the form now that all its fields and labels have been
  // added.
  form.appendChild(group1);
  // Details group
  const group2 = document.createElement('div');
  group2.className = 'form-group';
  const detailsLabel = document.createElement('label');
  detailsLabel.style.flex = '1 1 100%';
  detailsLabel.textContent = 'Details (optional)';
  const detailsTextarea = document.createElement('textarea');
  detailsTextarea.rows = 2;
  detailsTextarea.placeholder = 'Additional information...';
  detailsLabel.appendChild(detailsTextarea);
  group2.appendChild(detailsLabel);
  form.appendChild(group2);
  // Actions
  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = 'Add Event';
  actions.appendChild(submitBtn);
  form.appendChild(actions);
  formSection.appendChild(form);
  // No need to toggle cost visibility anymore because cost can be
  // associated with any event type.
  // Handle submit
  form.addEventListener('submit', e => {
    e.preventDefault();
    const type = typeSelect.value;
    const isoDate = dateInput.value;
    const title = titleInput.value.trim();
    const details = detailsTextarea.value.trim();
    if (!isoDate || !title) return;
    // Assemble the new event.  We keep the couple id on the event so
    // that the shared view can colour code by couple.  Only include
    // optional fields when provided.
    const newEvent = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      date: isoDate,
      title,
      details: details || undefined,
      coupleId: couple.id
    };
    const timeStr = timeInput.value;
    if (timeStr) {
      newEvent.time = timeStr;
    }
    // Mark whether this event has already been paid.  If the cost
    // field has a value and the paid checkbox is unchecked, record
    // the cost; otherwise omit cost to signal that no payment is
    // expected or the user has marked it as paid.
    newEvent.paid = paidCheckbox.checked;
    if (!paidCheckbox.checked && costInput.value) {
      newEvent.cost = parseFloat(costInput.value);
    }
    couple.events.push(newEvent);
    // After pushing the event, mark it as paid and remove any cost
    // if the "Already paid" checkbox was checked.  We access
    // paidCheckbox here because it is defined when the form is
    // constructed.  This ensures downstream views know that no
    // payment is required.
    if (typeof paidCheckbox !== 'undefined' && paidCheckbox.checked) {
      newEvent.paid = true;
      if (newEvent.hasOwnProperty('cost')) delete newEvent.cost;
    }
    // Reset form fields.  We preserve the type selection because
    // travellers often add multiple events of the same type in a row.
    dateInput.value = '';
    timeInput.value = '';
    titleInput.value = '';
    detailsTextarea.value = '';
    costInput.value = '';
    paidCheckbox.checked = false;
    costInput.disabled = false;
    // Persist the updated events list.  Save locally only if enabled.
    saveData();
    // Attempt to save to Firestore.  If it fails, remove the event
    // and display an error.  Only re-render after the server write
    // completes to ensure that other clients receive the update.
    saveToFirestore().then(() => {
      render();
    }).catch(err => {
      console.error('Failed to save new event:', err);
      // Remove the event we just added
      couple.events.pop();
      displayError('Failed to save the event to the server. Please try again.');
      render();
    });
  });
  // Disable the submit button entirely when Firestore is unavailable.
  if (!db) {
    submitBtn.disabled = true;
    submitBtn.title = 'Cannot add events while offline';
  }
  return formSection;
}