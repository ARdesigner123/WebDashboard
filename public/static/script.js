// ==========================================
// 1. CONFIGURATION & STATE
// ==========================================
const API_BASE_URL = String(window.DASHBOARD_API_BASE_URL || '').replace(/\/+$/, '');
const BASE_HOST = API_BASE_URL || ((window.location.protocol === 'file:' || !window.location.origin || window.location.origin === 'null') ? "http://localhost:8080" : window.location.origin);
const NODE_BACKEND_URL = BASE_HOST; 
const DEMO_API_URL = `${BASE_HOST}/api/mes-proxy`;
const MES_API_URL = DEMO_API_URL;

const GOOGLE_SHEETS_WEBHOOK = "https://script.google.com/macros/s/AKfycbx5m6lZ2foS6d9PlwbNweLQvK_uu0gFLWksa-hLX9YLIh1T6eijPKifNyQcfqxgY4gZJQ/exec";
const GOOGLE_SHEET_URL = "https://docs.google.com/spreadsheets/d/1cs-L2-L-TjEemEWnd5ZLcRZzTq-Fo6JZa3NGr0ER9RI/edit";

const OVERALL_STATUS_WEBHOOK = "https://script.google.com/macros/s/AKfycbzHON8OJlCtV4qD3bkOZZcRkT6HHpgpl64bXq7MbILaA6x_AO85XRvuB2oXJJ6HOBOq/exec";
const OVERALL_SHEET_URL = "https://docs.google.com/spreadsheets/d/1oNuj3v3-KVyXDayxjPHYMhW6GJXBUoBwwVo__u0HLzI/edit";

let WO_GID_MAP = {}; 

let urgentWOs_wo = [];
let urgentWOs_pn = [];
let lastLocalWOUpdateTimestamp = Date.now();
let currentSearchMode = 'wo';

try {
    const localSavedWo = localStorage.getItem('bizlink_urgent_wos_wo') || localStorage.getItem('bizlink_urgent_wos');
    if (localSavedWo !== null) urgentWOs_wo = JSON.parse(localSavedWo);
    const localSavedPn = localStorage.getItem('bizlink_urgent_wos_pn');
    if (localSavedPn !== null) urgentWOs_pn = JSON.parse(localSavedPn);
} catch(e) {}

Object.defineProperty(window, 'urgentWOs', {
    get() {
        return currentSearchMode === 'pn' ? urgentWOs_pn : urgentWOs_wo;
    },
    set(val) {
        if (currentSearchMode === 'pn') {
            urgentWOs_pn = Array.isArray(val) ? val : [];
        } else {
            urgentWOs_wo = Array.isArray(val) ? val : [];
        }
    },
    configurable: true
});

function saveUrgentWOsToStorage() {
    try {
        lastLocalWOUpdateTimestamp = Date.now();
        const key = currentSearchMode === 'pn' ? 'demo_urgent_wos_pn' : 'demo_urgent_wos_wo';
        localStorage.setItem(key, JSON.stringify(window.urgentWOs || []));
    } catch(e) {}
}
let pctCache = {}; 
let totalWHCache = {};
let completedWHCache = {};
let lastRecordedPct = {}; 
let historyQueue = [];
let globalDataCache = {}; 
let productDesCache = {}; 
let activeLines = ['WH']; 

// ⏱️ Global Countdown Timer State
let currentIntervalMinutes = 30; // 30 minutes by default
let countdownSecondsLeft = 1800; // 1800 seconds by default
let isAutoSyncing = false; 
let isPlaceholderAutoUpdateEnabled = false; // Default OFF as requested
let isDeletingWOs = false; // Deletion lock state

function handlePlaceholderAutoUpdateChange(val) {
    isPlaceholderAutoUpdateEnabled = (val === "on");
    showStatus(`Auto Update (Placeholder & WH Summary): ${isPlaceholderAutoUpdateEnabled ? 'ON' : 'OFF'}`, isPlaceholderAutoUpdateEnabled ? "green" : "gray");
}

function isMatchingWORow(row, targetWO) {
    if (!row || !targetWO) return false;
    const target = String(targetWO).trim().toLowerCase();
    if (!target) return false;

    const fieldsToCheck = [
        row.TopMfgOrderName,
        row.FatherMfgOrderName, // Bundle / parent order link
        row.MfgOrderName,
        row.mfgOrder,
        row.mfgOrderName,
        row.WorkOrder,
        row.workOrder,
        row.ParentMfgOrder,
        row.parentMfgOrder,
        row.TraverlerCard,
        row.TravelerCard,
        row.ContainerName
    ];

    return fieldsToCheck.some(val => {
        if (val === undefined || val === null) return false;
        const s = String(val).trim().toLowerCase();
        if (!s) return false;
        // Exact hit, or the field carries the WO plus a suffix (`4010838188-1`).
        // The old `target.includes(s)` branch also matched whenever a SHORT field
        // value (a partial TravellerCard / ContainerName) happened to be a
        // substring of the searched WO, which dragged rows from other WOs into
        // this WO and produced bogus Total WH / Completion % numbers.
        return s === target || s.includes(target);
    });
}

// Single source of truth for "which MES rows belong to this WO".
// searchContainer() and fetchSingleUrgentRackWO() both fill globalDataCache
// through this, so the WO Summary can no longer disagree with itself depending
// on which call happened to write the cache last.
function selectRowsForWO(rawRows, wo) {
    if (!Array.isArray(rawRows) || rawRows.length === 0) return [];
    return rawRows.filter(r => isMatchingWORow(r, wo));
}

function isLineWH(row) {
    if (!row) return false;
    const specNameRaw = String(row.SpecName || row.specName || row.specname || row.SPECNAME || "");
    const specNameClean = specNameRaw.toLowerCase().replace(/[^a-z0-9]/gi, '');
    return specNameClean === "linewh" || specNameClean.includes("linewh");
}

function getRowLineCategory(row) {
    if (!row) return "WH";

    let mfgLine = String(row.MfgLineName || row.mfgLineName || "").toUpperCase().trim();
    let specName = String(row.SpecName || row.specName || "").toUpperCase().trim();
    let wfName = String(row.WorkflowName || row.workflowName || "").toUpperCase().trim();

    // 1. Primary check: MfgLineName (ABSOLUTE SOURCE OF TRUTH if populated!)
    if (mfgLine && mfgLine !== "NULL" && mfgLine !== "UNDEFINED") {
        if (mfgLine.includes("BB") || mfgLine.includes("BI")) return "BB";
        if (mfgLine.includes("SI")) return "SI";
        if (mfgLine.includes("MA")) return "MA";
        if (mfgLine.includes("PCB")) return "PCB";
        if (mfgLine.includes("SM")) return "SM";
        if (mfgLine.includes("WH")) return "WH";
    }

    // 2. Secondary check: WorkflowName
    if (wfName && wfName !== "NULL" && wfName !== "UNDEFINED") {
        if (wfName.includes("BB") || wfName.includes("BI")) return "BB";
        if (wfName.includes("SI")) return "SI";
        if (wfName.includes("MA")) return "MA";
        if (wfName.includes("WH")) return "WH";
    }

    // 3. Tertiary check: SpecName
    if (specName && specName !== "NULL" && specName !== "UNDEFINED") {
        if (specName.includes("BB") || specName.includes("BI")) return "BB";
        if (specName.includes("SI")) return "SI";
        if (specName.includes("MA")) return "MA";
        if (specName.includes("WH")) return "WH";
    }

    return "WH"; // Default fallback
}

function rowMatchesLine(row, line) {
    if (!row) return false;

    let targetLine = String(line || "").toUpperCase().trim();
    if (targetLine === 'BI') targetLine = 'BB'; // Alias BI as BB

    let mfgLine = String(row.MfgLineName || row.mfgLineName || "").toUpperCase().trim();

    // 1. If MfgLineName exists and is populated, it is the ABSOLUTE SOURCE OF TRUTH!
    if (mfgLine && mfgLine !== "NULL" && mfgLine !== "UNDEFINED") {
        if (targetLine === 'WH') {
            return !mfgLine.includes('MA') && !mfgLine.includes('BB') && !mfgLine.includes('SI') && !mfgLine.includes('BI');
        }
        if (targetLine === 'BB') {
            return mfgLine.includes('BB') || mfgLine.includes('BI');
        }
        if (targetLine === 'SI') {
            return mfgLine.includes('SI');
        }
        return mfgLine.includes(targetLine);
    }

    // 2. Otherwise fall back to overall line category
    let category = getRowLineCategory(row);
    if (targetLine === 'BB') return category === 'BB';
    if (targetLine === 'SI') return category === 'SI';
    if (targetLine === 'WH') return category === 'WH';

    return category === targetLine;
}

function calculateWOCompletion(wo, lines = activeLines) {
    const data = globalDataCache[wo] || [];
    if (!data || data.length === 0) {
        return { total: 0, completed: 0, pctStr: "--%", pctNum: 0 };
    }

    const linesArray = Array.isArray(lines) && lines.length > 0 ? lines : ['WH'];

    let total = 0;
    let completed = 0;

    data.forEach(row => {
        let matchesAnyLine = linesArray.some(line => rowMatchesLine(row, line));
        if (matchesAnyLine) {
            total++;

            let isCompleted = false;
            if (row.ContainerStatus && String(row.ContainerStatus).toLowerCase().includes('completed')) {
                isCompleted = true;
            } else if (row.SpecName && String(row.SpecName).toLowerCase().includes("line wh")) {
                isCompleted = true;
            }

            if (isCompleted) {
                completed++;
            }
        }
    });

    if (total === 0) {
        return { total: 0, completed: 0, pctStr: "0.00%", pctNum: 0 };
    }

    let pctNum = (completed / total) * 100;
    let pctStr = pctNum.toFixed(2) + "%";

    return { total, completed, pctStr, pctNum };
}

function updateWOListCompletionPercentages() {
    Object.keys(globalDataCache).forEach(wo => {
        const pctCell = document.getElementById(`urgent-pct-${wo}`);
        if (pctCell) {
            const res = calculateWOCompletion(wo, activeLines);
            pctCache[wo] = res.pctStr;
            totalWHCache[wo] = res.total;
            completedWHCache[wo] = res.completed;
            if (res.total > 0 || res.pctStr !== "--%") {
                pctCell.innerText = res.pctStr;
                pctCell.style.fontStyle = "normal";
                pctCell.style.fontWeight = "bold";
                pctCell.style.color = (res.completed === res.total && res.total > 0) ? '#52c41a' : '#faad14';
            }
        }
    });
}

let isFetchingMES = false;
let isSearching = false; 
let woDates = {}; 
let currentSortMode = 'manual'; 

let dragSrcEl = null;
let isDraggingRow = false; 
let abortExport = false;

const FALLBACK_STEPS_SEC = [21600, 10800, 3600, 1800, 900, 300, 60, 30, 15, 8, 4, 1];

let undoStack = [];
let redoStack = [];
let globalAuthToken = localStorage.getItem('mes_token') || ""; 
let localDjangoToken = localStorage.getItem('django_token') || "";
let currentAuthMode = 'login';

// ============================================================================
// 🚨 TRANSPARENT AUTHENTICATION FETCH INTERCEPTOR (DUAL TOKEN AUTH)
// ============================================================================
const originalFetch = window.fetch;

function readCookie(name) {
    const match = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
    return match ? decodeURIComponent(match[1]) : '';
}

// DRF's SessionAuthentication enforces CSRF on any request that carries a
// Django session cookie. It needs BOTH halves of the double-submit cookie:
// the `csrftoken` cookie on the request, and the same value echoed back in
// the `X-CSRFToken` header. Missing either half logs
// "Forbidden (CSRF cookie not set.): /api/mes-proxy" and returns 403.
// `serve_index` normally sets the cookie with the HTML shell; this is only a
// safety net for when the page was opened without it (e.g. /index.html).
let csrfPrimePromise = null;
let csrfPrimeFailed = false;
function ensureCsrfCookie() {
    if (readCookie('csrftoken')) return Promise.resolve();
    if (csrfPrimeFailed || window.location.protocol === 'file:') return Promise.resolve();
    if (!csrfPrimePromise) {
        csrfPrimePromise = originalFetch('/', { credentials: 'same-origin' })
            .then(() => { if (!readCookie('csrftoken')) csrfPrimeFailed = true; })
            .catch(() => { csrfPrimeFailed = true; })
            .finally(() => { csrfPrimePromise = null; });
    }
    return csrfPrimePromise;
}

window.fetch = async function(resource, init) {
    let url = typeof resource === 'string' ? resource : (resource instanceof URL ? resource.href : '');
    if (API_BASE_URL && typeof resource === 'string' && resource.startsWith('/api/')) {
        resource = `${API_BASE_URL}${resource}`;
        url = resource;
    }
    
    if (url.includes('/api/')) {
        init = init || {};
        if (!init.headers) {
            init.headers = {};
        }

        // Session + CSRF cookies must travel with every API call.
        if (!init.credentials) init.credentials = API_BASE_URL ? 'include' : 'same-origin';

        // Echo the CSRF cookie back on EVERY /api/ call - including the auth
        // routes, which are otherwise skipped below.
        await ensureCsrfCookie();
        const csrfToken = readCookie('csrftoken');
        if (csrfToken) {
            if (init.headers instanceof Headers) {
                init.headers.set('X-CSRFToken', csrfToken);
            } else {
                init.headers['X-CSRFToken'] = csrfToken;
            }
        }

        const isAuthRoute = url.includes('/api/auth/login') || url.includes('/api/auth/registration') || url.includes('/api/mes-login');
        
        if (!isAuthRoute) {
            let origAuth = null;
            if (init.headers instanceof Headers) {
                origAuth = init.headers.get('Authorization');
            } else {
                origAuth = init.headers['Authorization'];
            }
            
            // Extract or fallback to stored MES Bearer token for proxies
            let mesToken = null;
            if (origAuth && origAuth.startsWith('Bearer ')) {
                mesToken = origAuth;
            } else {
                const storedMesToken = globalAuthToken || localStorage.getItem('mes_token') || localStorage.getItem('accessToken');
                if (storedMesToken) {
                    mesToken = storedMesToken.startsWith('Bearer ') ? storedMesToken : ('Bearer ' + storedMesToken);
                }
            }

            // Move or attach X-MES-Authorization header so Django proxies can extract and forward it
            if ((url.includes('/api/task-report') || url.includes('/api/mes-proxy')) && mesToken) {
                if (init.headers instanceof Headers) {
                    init.headers.set('X-MES-Authorization', mesToken);
                } else {
                    init.headers['X-MES-Authorization'] = mesToken;
                }
            }
            
            // Seamlessly attach our local Django Token Authentication header
            if (localDjangoToken) {
                if (init.headers instanceof Headers) {
                    init.headers.set('Authorization', 'Token ' + localDjangoToken);
                } else {
                    init.headers['Authorization'] = 'Token ' + localDjangoToken;
                }
            }
        }
    }
    return originalFetch(resource, init);
};

// ============================================================================
// FRONTEND DUAL AUTHENTICATION ROUTINES
// ============================================================================
async function handleAuthAction() {
    const statusBox = document.getElementById('loginStatus');
    if (!statusBox) return;
    statusBox.innerText = "";
    statusBox.style.color = "var(--text-secondary)";
    
    const user = document.getElementById('mesUser').value.trim();
    const pass = document.getElementById('mesPass').value.trim();
    const btn = document.getElementById('loginBtn');
    
    if (user.length < 5) {
        statusBox.innerText = "Username must be at least 5 characters long.";
        statusBox.style.color = "#ff4d4f";
        return;
    }
    if (pass.length < 5) {
        statusBox.innerText = "Password must be at least 5 characters long.";
        statusBox.style.color = "#ff4d4f";
        return;
    }
    if (!/\d/.test(pass)) {
        statusBox.innerText = "Password must include at least one number.";
        statusBox.style.color = "#ff4d4f";
        return;
    }
    if (!/[^A-Za-z0-9]/.test(pass)) {
        statusBox.innerText = "Password must include at least one special character.";
        statusBox.style.color = "#ff4d4f";
        return;
    }
    
    try {
        if (btn) {
            btn.disabled = true;
            btn.innerText = "Authenticating...";
        }
        statusBox.innerText = "Authenticating your account...";
        
        const mesResp = await fetch('/api/mes-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userName: user, password: pass })
        });
        
        const data = await mesResp.json().catch(() => ({}));

        if (!mesResp.ok || data.error) {
            let errMsg = data.error || data.message || "Authentication failed. Please check your username and password.";
            throw new Error(errMsg);
        }

        finishLocalLogin(data, user);
        
    } catch (error) {
        console.error("MES Auth Error:", error);
        statusBox.innerText = error.message;
        statusBox.style.color = "#ff4d4f";
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Secure Login";
        }
    }
}
function finishLocalLogin(data, username) {
    let token = data.token || data.accessToken || data.django_token_key || null;
    if (token && !String(token).startsWith('Bearer ')) {
        token = 'Bearer ' + String(token);
    }
    if (!token) throw new Error("Local authentication succeeded, but the session token was not returned.");
    if (!data.django_token_key) throw new Error("Your local authentication token was not created correctly.");

    globalAuthToken = token;
    localStorage.setItem('mes_token', token);
    localDjangoToken = data.django_token_key;
    localStorage.setItem('django_token', localDjangoToken);
    localStorage.setItem('mes_username', data.username || username);
    localStorage.setItem('demo_user_name', data.username || username);

    const authTokenEl = document.getElementById('authToken');
    if (authTokenEl) authTokenEl.value = token;
    const loginScreen = document.getElementById('globalLoginScreen');
    if (loginScreen) loginScreen.style.display = 'none';
    const mainContent = document.getElementById('mainAppContent');
    if (mainContent) mainContent.style.display = 'flex';
    const chatbotToggle = document.getElementById('chatbot-toggle');
    if (chatbotToggle) chatbotToggle.style.display = 'flex';
    initApp();
}

async function handleGuestLogin() {
    const statusBox = document.getElementById('loginStatus');
    const btn = document.getElementById('guestLoginBtn');
    if (!statusBox) return;

    statusBox.innerText = 'Starting a guest session...';
    statusBox.style.color = 'var(--text-secondary)';
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Starting guest session...';
    }

    try {
        const response = await fetch('/api/guest-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) {
            throw new Error(data.error || data.message || 'Guest login failed.');
        }
        finishLocalLogin(data, 'dashboard-guest');
    } catch (error) {
        console.error('Guest Login Error:', error);
        statusBox.innerText = error.message;
        statusBox.style.color = '#ff4d4f';
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Login as a guest';
        }
    }
}
window.handleAuthAction = handleAuthAction;
window.handleGuestLogin = handleGuestLogin;
window.handlePlaceholderAutoUpdateChange = handlePlaceholderAutoUpdateChange;

// 🚨 NEW: Chart Configuration State
let currentChartType = 'bar';
let activeChartInstance = null;

// Local Storage Engine for Custom Excel Sheets
let savedExcelSheets = JSON.parse(localStorage.getItem('bizlink_excel_inventory')) || [
    { id: 'default', name: 'Urgent Rack WO Live', url: GOOGLE_SHEET_URL }
];

let myUserId = localStorage.getItem('bizlink_user_id');
if (!myUserId) {
    myUserId = 'user_' + Math.floor(Math.random() * 10000);
    localStorage.setItem('bizlink_user_id', myUserId);
}

// ==========================================
// 🚨 EXCEL SWITCHER LOGIC
// ==========================================
function toggleExcelSwitch(e) {
    if (e) e.stopPropagation();
    const modal = document.getElementById('excelSwitchModal');
    if (!modal) return;

    if (modal.style.display === 'none' || !modal.style.display) {
        modal.style.display = 'flex';
        renderExcelInventory();
    } else {
        modal.style.display = 'none';
    }
}

function addExcelToInventory() {
    const nameInput = document.getElementById('customExcelName');
    const urlInput = document.getElementById('customExcelUrl');
    const name = nameInput.value.trim();
    const url = urlInput.value.trim();
    
    if(!name || !url) return alert("Please provide both a Sheet Name and a valid Google Sheet URL.");
    
    const newItem = { id: 'excel_' + Date.now(), name: name, url: url };
    savedExcelSheets.push(newItem);
    localStorage.setItem('bizlink_excel_inventory', JSON.stringify(savedExcelSheets));
    
    nameInput.value = '';
    urlInput.value = '';
    renderExcelInventory();
}

function renderExcelInventory() {
    const list = document.getElementById('excelInventoryList');
    if (!list) return;
    list.innerHTML = '';
    
    savedExcelSheets.forEach(item => {
        let cleanName = item.name.replace(/'/g, "\\'");
        list.innerHTML += `
            <div style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; padding: 12px 16px; border-radius: 12px; border: 1px solid #e2e8f0; cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 1px 3px rgba(0,0,0,0.03);" onclick="switchExcelSheet('${item.url}', '${cleanName}')" onmouseover="this.style.borderColor='#059669'; this.style.background='#f0fdf4'; this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 12px rgba(5,150,105,0.12)';" onmouseout="this.style.borderColor='#e2e8f0'; this.style.background='#f8fafc'; this.style.transform='none'; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.03)';">
                <div style="display: flex; align-items: center; gap: 10px; overflow: hidden;">
                    <div style="background: #dcfce7; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0;">📊</div>
                    <span style="font-size: 12.5px; font-weight: 700; color: #1e293b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px;">${item.name}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 11px; background: linear-gradient(135deg, #059669 0%, #047857 100%); color: #ffffff; padding: 4px 12px; border-radius: 20px; font-weight: 700; box-shadow: 0 2px 6px rgba(5,150,105,0.2);">Open</span>
                    ${item.id !== 'default' ? `<span style="color: #94a3b8; font-weight: bold; padding: 4px 8px; cursor: pointer; border-radius: 6px; transition: all 0.2s;" onclick="removeExcelSheet('${item.id}', event)" onmouseover="this.style.color='#ef4444'; this.style.background='#fee2e2';" onmouseout="this.style.color='#94a3b8'; this.style.background='transparent';" title="Remove Sheet">🗑️</span>` : ''}
                </div>
            </div>
        `;
    });
}

function removeExcelSheet(id, event) {
    event.stopPropagation();
    savedExcelSheets = savedExcelSheets.filter(i => i.id !== id);
    localStorage.setItem('bizlink_excel_inventory', JSON.stringify(savedExcelSheets));
    renderExcelInventory();
}

function switchExcelSheet(url, name) {
    document.getElementById('excelIframe').src = url;
    document.getElementById('excelViewerTitle').innerText = `Spreadsheet: ${name}`;
    toggleExcelSwitch(); 
}

let currentTab = 'wo';

// Position of each tab in the top bar - used to work out whether the user is
// moving left or right so the animation slides in the matching direction.
const TAB_INDEX_MAP = {
    'wo': 0,
    'pn': 1,
    'overall': 2,
    'excel': 3,
    'manpower': 4,
    'task': 5,
    'live-assembly': 6
};

function getTabContainerId(tabKey) {
    if (tabKey === 'wo' || tabKey === 'pn' || tabKey === 'excel') return 'view-shared-wo';
    if (tabKey === 'overall') return 'view-overall';
    if (tabKey === 'manpower') return 'view-manpower';
    if (tabKey === 'task') return 'view-task';
    if (tabKey === 'live-assembly') return 'view-live-assembly';
    return 'view-shared-wo';
}

// 🎬 PRESENTATION SLIDE TAB TRANSITION ENGINE
//
// The transition has two shapes:
//   1. "Cross slide" -> the two tabs render in DIFFERENT view containers, so
//      both are visible at once and slide past each other.
//   2. "Swap"        -> the two tabs share ONE view container (WO <-> Part
//      Number <-> Excel all use #view-shared-wo). There is nothing to slide
//      between, so the container plays a single out -> in keyframe run and the
//      content is swapped while the container is fully transparent.
//      (Before this branch existed, WO -> Part Number showed NO transition.)
//
// Motion is driven purely by the transform/opacity keyframes in style.css, so
// the browser runs it on the compositor instead of re-laying-out the tables
// every frame (which is what made the old version stutter).

const TAB_VIEW_IDS = ['view-shared-wo', 'view-overall', 'view-manpower', 'view-task', 'view-live-assembly'];

const VIEW_ANIM_CLASSES = [
    'view-anim-in-fwd', 'view-anim-in-bwd',
    'view-anim-out-fwd', 'view-anim-out-bwd',
    'view-swap-fwd', 'view-swap-bwd'
];

// Keep in sync with the durations declared in style.css.
const VIEW_SWAP_DURATION = 560;   // full run of viewSwapForward / viewSwapBackward
const VIEW_SWAP_CONTENT_AT = 185; // 33% of 560ms -> container is transparent here
const VIEW_OUT_DURATION = 420;    // cross slide - outgoing view
const VIEW_IN_DURATION = 560;     // cross slide - incoming view

function resetViewAnim(el) {
    if (!el) return;
    if (el._viewAnimTimer) { clearTimeout(el._viewAnimTimer); el._viewAnimTimer = null; }
    if (el._viewSwapTimer) { clearTimeout(el._viewSwapTimer); el._viewSwapTimer = null; }
    if (VIEW_ANIM_CLASSES.some(cls => el.classList.contains(cls))) {
        VIEW_ANIM_CLASSES.forEach(cls => el.classList.remove(cls));
        // Flush the removal so that re-adding the same class straight away
        // restarts the animation instead of silently letting it carry on.
        void el.offsetWidth;
    }
}

// Restarts the staggered inner content reveal for a view container.
function replayContentReveal(el) {
    if (!el) return;
    el.classList.remove('tab-slide-active');
    void el.offsetWidth; // force a reflow so the child animations restart
    el.classList.add('tab-slide-active');
}

function switchTab(tabId) {
    if (!tabId) return;

    const prevTabKey = currentTab || 'wo';
    const prevIdx = TAB_INDEX_MAP[prevTabKey] !== undefined ? TAB_INDEX_MAP[prevTabKey] : 0;
    const newIdx = TAB_INDEX_MAP[tabId] !== undefined ? TAB_INDEX_MAP[tabId] : 0;
    const isForward = newIdx >= prevIdx;

    const prevContainerId = getTabContainerId(prevTabKey);
    const newContainerId = getTabContainerId(tabId);
    const prevContainer = document.getElementById(prevContainerId);
    const newContainer = document.getElementById(newContainerId);

    // Deactivate all tab header buttons
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

    // Hide excel switch modal if open
    const excelModal = document.getElementById('excelSwitchModal');
    if (excelModal) excelModal.style.display = 'none';

    // Activate the target header immediately so the sliding indicator starts
    // moving on the very first frame of the transition.
    const newTabBtn = document.getElementById('tab-' + tabId);
    if (newTabBtn) newTabBtn.classList.add('active');
    currentTab = tabId;
    updateTabSlidingIndicator();

    // Cancel anything already in flight so rapid clicking can never leave a
    // view stuck halfway through an animation, and hide every view that is
    // neither the incoming nor the outgoing one (the outgoing view has to stay
    // visible so it can finish sliding out).
    TAB_VIEW_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        resetViewAnim(el);
        if (id !== newContainerId && id !== prevContainerId) el.style.display = 'none';
    });

    const sameContainer = (prevContainerId === newContainerId);

    // Re-selecting the tab that is already open: no motion, just make sure the
    // view is showing (callers rely on this path being synchronous).
    if (tabId === prevTabKey || !newContainer) {
        if (newContainer) {
            newContainer.style.display = 'flex';
            newContainer.classList.add('tab-slide-active');
        }
        applyTabContent(tabId, null);
        return;
    }

    newContainer.style.display = 'flex';

    if (sameContainer) {
        // ---- Shared container (e.g. WO <-> Part Number <-> Excel): one single
        //      out -> swap -> in keyframe run on the container itself.
        newContainer.classList.add(isForward ? 'view-swap-fwd' : 'view-swap-bwd');
        newContainer._viewSwapTimer = setTimeout(() => {
            newContainer._viewSwapTimer = null;
            if (currentTab !== tabId) return; // user already clicked another tab
            applyTabContent(tabId, null);
            replayContentReveal(newContainer);
        }, VIEW_SWAP_CONTENT_AT);

        const swapClass = isForward ? 'view-swap-fwd' : 'view-swap-bwd';
        newContainer._viewAnimTimer = setTimeout(() => {
            newContainer._viewAnimTimer = null;
            newContainer.classList.remove(swapClass);
        }, VIEW_SWAP_DURATION);
    } else {
        // ---- Different containers: the old view slides out while the new view
        //      slides in. They share one grid cell, so they overlap instead of
        //      squashing each other to half height.
        if (prevContainer) {
            const outClass = isForward ? 'view-anim-out-fwd' : 'view-anim-out-bwd';
            prevContainer.classList.add(outClass);
            prevContainer._viewAnimTimer = setTimeout(() => {
                prevContainer._viewAnimTimer = null;
                if (prevContainer !== newContainer) prevContainer.style.display = 'none';
                resetViewAnim(prevContainer);
            }, VIEW_OUT_DURATION);
        }

        const inClass = isForward ? 'view-anim-in-fwd' : 'view-anim-in-bwd';
        newContainer.classList.add(inClass);

        // keepVisible stops the hide loop below from killing the outgoing view
        // before it has finished animating.
        applyTabContent(tabId, prevContainer);
        replayContentReveal(newContainer);

        newContainer._viewAnimTimer = setTimeout(() => {
            newContainer._viewAnimTimer = null;
            newContainer.classList.remove(inClass);
        }, VIEW_IN_DURATION);
    }
}

function applyTabContent(tabId, keepVisible) {
    const newContainerId = getTabContainerId(tabId);

    // Hide every view except the one we are switching to. The outgoing view is
    // passed in as `keepVisible` so it is not yanked away before it has
    // finished animating out.
    TAB_VIEW_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el && id !== newContainerId && el !== keepVisible) {
            el.style.display = 'none';
        }
    });

    document.getElementById('panel-wo-summary').style.display = 'none';
    document.getElementById('panel-excel-viewer').style.display = 'none';

    if (tabId === 'wo') {
        currentSearchMode = 'wo';
        if (document.getElementById('tab-wo')) document.getElementById('tab-wo').classList.add('active');
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.placeholder = "Search Multiple WOs...";
        document.getElementById('view-shared-wo').style.display = 'flex';
        document.getElementById('panel-wo-summary').style.display = 'flex';
        document.getElementById('globalSearch').style.visibility = 'visible';

        const btnPlaceholder = document.getElementById('btnSyncPlaceholder');
        const btnWhSummary = document.getElementById('btnSyncWhSummary');
        const autoUpdateSelect = document.getElementById('placeholderAutoUpdateSelect');
        if (btnPlaceholder) btnPlaceholder.style.display = 'inline-flex';
        if (btnWhSummary) btnWhSummary.style.display = 'inline-flex';
        if (autoUpdateSelect) autoUpdateSelect.style.display = 'inline-block';

        initUrgentRackTable();
        syncUrgentRack();
        updateMainViews();
    } else if (tabId === 'pn') {
        currentSearchMode = 'pn';
        if (document.getElementById('tab-pn')) document.getElementById('tab-pn').classList.add('active');
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.placeholder = "Search Part Numbers...";
        document.getElementById('view-shared-wo').style.display = 'flex';
        document.getElementById('panel-wo-summary').style.display = 'flex';
        document.getElementById('globalSearch').style.visibility = 'visible';

        const btnPlaceholder = document.getElementById('btnSyncPlaceholder');
        const btnWhSummary = document.getElementById('btnSyncWhSummary');
        const autoUpdateSelect = document.getElementById('placeholderAutoUpdateSelect');
        if (btnPlaceholder) btnPlaceholder.style.display = 'none';
        if (btnWhSummary) btnWhSummary.style.display = 'none';
        if (autoUpdateSelect) autoUpdateSelect.style.display = 'none';

        initUrgentRackTable();
        syncUrgentRack();
        updateMainViews();
    } else if (tabId === 'overall') {
        if (document.getElementById('tab-overall')) document.getElementById('tab-overall').classList.add('active');
        document.getElementById('view-overall').style.display = 'flex';
        document.getElementById('globalSearch').style.visibility = 'hidden';
        updateOverallDatesText();
    } else if (tabId === 'excel') {
        if (document.getElementById('tab-excel')) document.getElementById('tab-excel').classList.add('active');
        document.getElementById('view-shared-wo').style.display = 'flex';
        document.getElementById('panel-excel-viewer').style.display = 'flex';
        document.getElementById('globalSearch').style.visibility = 'visible';
        
        const iframe = document.getElementById('excelIframe');
        if (iframe && (iframe.src === "about:blank" || iframe.src.includes("about:blank"))) {
            iframe.src = savedExcelSheets[0].url; 
            document.getElementById('excelViewerTitle').innerText = `Spreadsheet: ${savedExcelSheets[0].name}`;
        }
    } else if (tabId === 'task') {
        if (document.getElementById('tab-task')) document.getElementById('tab-task').classList.add('active');
        document.getElementById('view-task').style.display = 'flex';
        document.getElementById('globalSearch').style.visibility = 'hidden';
    } else if (tabId === 'manpower') {
        if (document.getElementById('tab-manpower')) document.getElementById('tab-manpower').classList.add('active');
        document.getElementById('view-manpower').style.display = 'flex';
        document.getElementById('globalSearch').style.visibility = 'hidden';
        
        if (document.getElementById('manpowerTableBody') && document.getElementById('manpowerTableBody').children.length === 0) {
            addManpowerRow();
        }
    } else if (tabId === 'live-assembly') {
        if (document.getElementById('tab-live-assembly')) {
            document.getElementById('tab-live-assembly').classList.add('active');
        }
        if (document.getElementById('view-live-assembly')) {
            document.getElementById('view-live-assembly').style.display = 'flex';
        }
        document.getElementById('globalSearch').style.visibility = 'hidden';
    }

}

function updateTabSlidingIndicator() {
    const activeTab = document.querySelector('.tabs-nav-container .tab.active');
    const indicator = document.getElementById('tabSlidingIndicator');
    if (activeTab && indicator) {
        indicator.style.left = activeTab.offsetLeft + 'px';
        indicator.style.width = activeTab.offsetWidth + 'px';
        indicator.style.height = activeTab.offsetHeight + 'px';
        indicator.style.top = activeTab.offsetTop + 'px';
        indicator.style.opacity = '1';
    }
}

window.addEventListener('resize', updateTabSlidingIndicator);
window.addEventListener('load', () => setTimeout(updateTabSlidingIndicator, 50));
document.addEventListener('DOMContentLoaded', () => setTimeout(updateTabSlidingIndicator, 50));

async function fetchGidMap() {
    try {
        const response = await fetch(`${GOOGLE_SHEETS_WEBHOOK}?action=getGids`);
        if (response.ok) {
            WO_GID_MAP = await response.json();
        }
    } catch (e) {
        console.warn("Could not fetch GID map:", e);
    }
}

async function initApp() {
    try { fetchGidMap(); } catch (e) {} 
    
    // Render local WOs immediately on load/login so user sees them without delay!
    if (urgentWOs && urgentWOs.length > 0) {
        initUrgentRackTable();
        fetchUrgentRackData();
    }

    try { await syncUrgentRack(); } catch (e) { console.warn("Sync urgent rack error:", e); } 
    try { fetchUrgentRackData(); } catch (e) { console.warn("Fetch urgent rack error:", e); }
    
    setInterval(() => {
        try { syncUrgentRack(); } catch (e) {}
    }, 5000); 

    setInterval(() => {
        try { fetchUrgentRackData(); } catch (e) {}
        try { fetchGidMap(); } catch (e) {} 
    }, 300000);

    // Automatically sync all WH WO Status data to Google Sheets (Placeholder tab & WH Summary tabs) every 1 hour (60 mins) if enabled!
    setInterval(async () => {
        if (isPlaceholderAutoUpdateEnabled && urgentWOs && urgentWOs.length > 0) {
            console.log("[Auto-Sync] Running scheduled 1-hour automated sync of Placeholder & WH Summary tabs...");
            try { 
                await syncAllTesting(urgentWOs, true); 
                await syncAllToRespectiveTabs(true);
            } catch (e) {
                console.warn("[Auto-Sync] Error during 1-hour auto update:", e);
            }
        }
    }, 3600000); // 1 hour = 3,600,000 ms

    // Initialize the countdown timer and register the hourly automated sync
    startOverallSyncCountdown();
}

window.addEventListener('beforeunload', function () {
    fetch(`${NODE_BACKEND_URL}/api/users/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: myUserId }),
        keepalive: true 
    });
});

const colKeys = [
    "MfgOrderName", "ProductName", "OrderQty", "Qty", "SpecName", "TaskListName", 
    "ActiveStatus", "ContainerStatus", "MfgLineName", "WorkflowName", "PlannedStartDate", 
    "PlannedCompletionDate", "CustomerName", "CustomerProduct", "TopMfgOrderName", 
    "FatherMfgOrderName", "ContainerName", "TraverlerCard", "EmployeeName", "OnHold", 
    "ManTime", "TotalTime", "HeEmployeeName", "TxnDate"
];

async function syncLiveSheetTabs(wosArray, switchToFirst = true) {
    if (wosArray.length === 0) return;

    const iframe = document.getElementById('excelIframe');
    let firstWO = wosArray[0];
    let firstExists = !!WO_GID_MAP[firstWO];

    if (switchToFirst && firstExists && document.getElementById('panel-excel-viewer').style.display === 'flex') {
        iframe.src = `${GOOGLE_SHEET_URL}#gid=${WO_GID_MAP[firstWO]}`;
    }

    let validPayloads = [];
    for (let wo of wosArray) {
        const data = globalDataCache[wo] || [];
        if (data.length === 0) continue;
        let records2D = [colKeys];
        data.forEach(row => {
            records2D.push(colKeys.map(key => {
                let val = row[key];
                if (key === "TravelerCard") val = row["TravelerCard"] || row["TraverlerCard"];
                return val !== undefined && val !== null ? String(val).trim() : "";
            }));
        });
        const total = totalWHCache[wo] !== undefined ? totalWHCache[wo] : 0;
        const completed = completedWHCache[wo] !== undefined ? completedWHCache[wo] : 0;
        const pct = pctCache[wo] || "0.00%";

        validPayloads.push({ 
            wo: wo, 
            records: records2D,
            total: total,
            completed: completed,
            pct: pct
        });
    }

    if (validPayloads.length === 0) return;

    const payload = {
        sync_type: "update_live_tabs",
        data: validPayloads
    };

    try {
        await fetch(GOOGLE_SHEETS_WEBHOOK, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        });
        
        if (switchToFirst && !firstExists && document.getElementById('panel-excel-viewer').style.display === 'flex') {
            setTimeout(async () => {
                await fetchGidMap();
                if (WO_GID_MAP[firstWO]) iframe.src = `${GOOGLE_SHEET_URL}#gid=${WO_GID_MAP[firstWO]}`;
            }, 3500);
        }
    } catch (e) {
        console.error("Failed to push live tab update:", e);
    }
}

async function loginToMES() {
    return handleAuthAction();
}

function handleSearchEnter(event) {
    if (event.key === "Enter") {
        event.preventDefault(); 
        searchContainer(); 
    }
}

if (!myUserId) {
    myUserId = localStorage.getItem('bizlink_user_id') || ('usr_' + Math.random().toString(36).substring(2, 11));
    localStorage.setItem('bizlink_user_id', myUserId);
}

let myUserName = localStorage.getItem('demo_user_name') || localStorage.getItem('bizlink_user_name') || localStorage.getItem('mes_username') || '';
if (!myUserName) {
    myUserName = 'demo-user';
    localStorage.setItem('demo_user_name', myUserName);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function syncUrgentRack() {
    if (isDraggingRow || isSearching || isDeletingWOs) return; 

    const now = Date.now();
    const isRecentlyUpdatedLocally = (now - lastLocalWOUpdateTimestamp) < 15000;

    try {
        const timestamp = new Date().getTime();
        const response = await fetch(`${NODE_BACKEND_URL}/api/urgent-wos?list_type=${currentSearchMode}&t=${timestamp}`);
        if (!response.ok) return;
        
        const fetchedWOs = await response.json();
        
        // Safety check: abort if deletion or search is currently in progress
        if (isDeletingWOs || isSearching) return;

        // Protection: If server returned empty array BUT local urgentWOs has items, do NOT wipe local; push local to server!
        if (Array.isArray(fetchedWOs) && fetchedWOs.length === 0 && window.urgentWOs.length > 0) {
            initUrgentRackTable();
            fetchUrgentRackData();
            fetch(`${NODE_BACKEND_URL}/api/urgent-wos/reorder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedWOs: window.urgentWOs, list_type: currentSearchMode })
            }).catch(() => {});
            return;
        }

        // Protection: If local urgentWOs was recently updated, push local to server to ensure server syncs up
        if (isRecentlyUpdatedLocally && window.urgentWOs.length > 0) {
            initUrgentRackTable();
            fetchUrgentRackData();
            fetch(`${NODE_BACKEND_URL}/api/urgent-wos/reorder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedWOs: window.urgentWOs, list_type: currentSearchMode })
            }).catch(() => {});
            return;
        }

        const currentStr = JSON.stringify(window.urgentWOs);
        const fetchedStr = JSON.stringify(fetchedWOs);
        
        if (currentStr !== fetchedStr) {
            window.urgentWOs = fetchedWOs;
            saveUrgentWOsToStorage();
            initUrgentRackTable();
            fetchUrgentRackData(); 
        }
        
        flushHistoryQueue();
    } catch (err) {
        console.error("Sync Error:", err);
    }
}

// =========================================================
// 1. BULLETPROOF GLOBAL EVENT LISTENER
// =========================================================
document.addEventListener('change', function(e) {
    if (e.target && e.target.classList && e.target.classList.contains('urgent-checkbox')) {
        updateMainViews();
    }
});

document.addEventListener('click', function(e) {
    // Check if the user clicked inside a table row
    const row = e.target.closest('.clickable-row');
    if (!row) return;

    const checkbox = row.querySelector('.urgent-checkbox');
    if (!checkbox) return;

    // If they clicked the row (but not the checkbox itself), toggle the checkbox manually
    if (e.target.tagName.toLowerCase() !== 'input') {
        checkbox.checked = !checkbox.checked;
        updateMainViews();
    }
});

// Fix the Select All checkbox behavior
window.toggleAllUrgent = function(masterBox) {
    const checkboxes = document.querySelectorAll('.urgent-checkbox');
    checkboxes.forEach(cb => cb.checked = masterBox.checked);
    updateMainViews();
};


// =========================================================
// 2. CLEANED UP TABLE GENERATOR
// =========================================================
function initUrgentRackTable(autoCheckWOs = [], resetSelection = false) {
    if (!Array.isArray(autoCheckWOs)) autoCheckWOs = [autoCheckWOs];
    
    let checkedWOs = [];
    if (resetSelection) {
        checkedWOs = [...autoCheckWOs];
    } else {
        checkedWOs = Array.from(document.querySelectorAll('.urgent-checkbox:checked')).map(cb => cb.value);
        autoCheckWOs.forEach(wo => {
            if (urgentWOs.includes(wo) && !checkedWOs.includes(wo)) {
                checkedWOs.push(wo);
            }
        });
    }

    const tbody = document.getElementById("urgentBody");
    if (!tbody) return;
    tbody.innerHTML = ""; // Clear table
    
    const table = document.getElementById("urgentTable");
    if (table) table.style.tableLayout = "fixed";
    
    const selectAll = document.getElementById("selectAllUrgent");
    if(selectAll) selectAll.checked = false;
    
    urgentWOs.forEach(wo => {
        const tr = document.createElement("tr");
        tr.className = "clickable-row";
        tr.dataset.wo = wo; 
        
        tr.draggable = true;
        tr.addEventListener('dragstart', handleDragStart);
        tr.addEventListener('dragenter', handleDragEnter);
        tr.addEventListener('dragover', handleDragOver);
        tr.addEventListener('dragleave', handleDragLeave);
        tr.addEventListener('drop', handleDrop);
        tr.addEventListener('dragend', handleDragEnd);
        
        let cachedPct = "Loading...";
        if (globalDataCache[wo]) {
            const res = calculateWOCompletion(wo, activeLines);
            if (res.total > 0 || res.pctStr !== "--%") {
                cachedPct = res.pctStr;
                pctCache[wo] = res.pctStr;
            }
        } else if (pctCache[wo]) {
            cachedPct = pctCache[wo];
        }

        const cachedColor = cachedPct === "100.00%" ? "#52c41a" : (cachedPct === "Loading..." ? "#aaa" : "#faad14");
        const cachedStyle = cachedPct === "Loading..." ? "font-style: italic;" : "font-weight: bold; font-style: normal;";
        const isChecked = checkedWOs.includes(wo) ? "checked" : "";
        const cachedProdDes = productDesCache[wo] || "Loading...";

        tr.innerHTML = `
            <td style="width: 30px; text-align: center;">
                <input type="checkbox" value="${wo}" class="urgent-checkbox" ${isChecked} onchange="updateMainViews()">
            </td>
            <td style="width: 160px; white-space: nowrap; color: #1890ff; font-weight: 500; font-size: 11px;">☰ ${wo}</td>
            <td style="width: 110px;">
                <div style="width: 100%; font-size: 10px; color: #555; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;" id="urgent-desc-${wo}" title="${cachedProdDes}">${cachedProdDes}</div>
            </td>
            <td id="urgent-pct-${wo}" style="width: 50px; text-align: right; color: ${cachedColor}; ${cachedStyle}">${cachedPct}</td>
        `;
        tbody.appendChild(tr);
    });
    
    updateMainViews(); 
}

function handleDragStart(e) {
    if (e.target.tagName.toLowerCase() === 'input') {
        e.preventDefault();
        return;
    }
    isDraggingRow = true; 
    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
    this.classList.add('dragging');
}

function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault(); 
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDragEnter(e) {
    this.classList.add('over'); 
}

function handleDragLeave(e) {
    this.classList.remove('over'); 
}

function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    
    if (dragSrcEl !== this) {
        let parent = this.parentNode;
        let siblings = Array.from(parent.children);
        let draggedIndex = siblings.indexOf(dragSrcEl);
        let targetIndex = siblings.indexOf(this);

        if (draggedIndex < targetIndex) {
            parent.insertBefore(dragSrcEl, this.nextSibling);
        } else {
            parent.insertBefore(dragSrcEl, this);
        }

        currentSortMode = 'manual'; 
        let newOrder = [];
        document.querySelectorAll('#urgentBody tr').forEach(tr => {
            newOrder.push(tr.dataset.wo);
        });
        
        urgentWOs = newOrder; 
        
        fetch(`${NODE_BACKEND_URL}/api/urgent-wos/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderedWOs: window.urgentWOs, list_type: currentSearchMode })
        }).catch(err => console.error(err));
    }
    return false;
}

function handleDragEnd(e) {
    isDraggingRow = false; 
    this.classList.remove('dragging');
    let rows = document.querySelectorAll('#urgentBody tr');
    rows.forEach(row => row.classList.remove('over'));
}

function toggleAllUrgent(masterBox) {
    const checkboxes = document.querySelectorAll('.urgent-checkbox');
    checkboxes.forEach(cb => cb.checked = masterBox.checked);
    updateMainViews();
}

function syncAllToPlaceholder() {
    if (!urgentWOs || urgentWOs.length === 0) {
        showStatus("No Work Orders to sync.", "orange");
        return;
    }
    syncAllTesting(urgentWOs);
}

async function syncAllToRespectiveTabs(isSilent = false) {
    if (!urgentWOs || urgentWOs.length === 0) {
        if (!isSilent) showStatus("No Work Orders to sync.", "orange");
        return;
    }

    const overlay = document.getElementById('excelLoadingOverlay');
    const progressText = document.getElementById('excelLoadingProgress');
    const progressBar = document.getElementById('excelLoadingBar');
    const loadingTitle = document.getElementById('excelLoadingTitle');

    if (!isSilent) {
        switchTab('excel');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
        }
        if (loadingTitle) loadingTitle.innerText = "Synchronizing WH Summary...";
        if (progressText) progressText.innerText = "Fetching latest live data from MES database...";
        if (progressBar) progressBar.style.width = '5%';
    }

    try {
        await fetchUrgentRackData();
    } catch (err) {
        console.warn("Failed to fetch fresh MES data before syncing:", err);
    }

    if (!isSilent) {
        if (progressText) progressText.innerText = `Starting synchronization of ${urgentWOs.length} Work Orders...`;
        if (progressBar) progressBar.style.width = '10%';
    }

    let completedCount = 0;
    const totalWOs = urgentWOs.length;

    for (let i = 0; i < totalWOs; i++) {
        const wo = urgentWOs[i];
        if (!isSilent) {
            if (progressText) progressText.innerText = `Updating Work Order: ${wo} (${i + 1} of ${totalWOs})...`;
            const pct = Math.round(((i + 1) / totalWOs) * 90) + 10;
            if (progressBar) progressBar.style.width = `${pct}%`;
        }

        try {
            await syncLiveSheetTabs([wo], !isSilent);
            completedCount++;
        } catch (err) {
            console.error(`Failed to sync WO: ${wo}`, err);
        }
    }

    if (!isSilent) {
        if (progressBar) progressBar.style.width = '100%';
        if (progressText) {
            progressText.innerText = `Successfully updated ${completedCount} of ${totalWOs} Work Orders!`;
        }

        try {
            await fetchGidMap();
            const firstWO = urgentWOs[0];
            const iframe = document.getElementById('excelIframe');
            if (iframe && WO_GID_MAP[firstWO]) {
                iframe.src = `${GOOGLE_SHEET_URL}#gid=${WO_GID_MAP[firstWO]}`;
            }
        } catch (err) {}

        setTimeout(() => {
            if (overlay) {
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.style.display = 'none';
                    overlay.style.opacity = '1';
                }, 300);
            }
            showStatus(`Successfully synchronized ${completedCount} Work Orders to Google Sheets!`, "green");
        }, 1500);
    }
} 

async function syncAllTesting(selectedWOs, isSilent = false) {
    if (selectedWOs.length === 0) return;

    const overlay = document.getElementById('excelLoadingOverlay');
    const progressText = document.getElementById('excelLoadingProgress');
    const progressBar = document.getElementById('excelLoadingBar');
    const loadingTitle = document.getElementById('excelLoadingTitle');

    if (!isSilent) {
        switchTab('excel');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
        }
        if (loadingTitle) loadingTitle.innerText = "Synchronizing Placeholder Tab...";
        if (progressText) progressText.innerText = "Fetching latest live data from MES database...";
        if (progressBar) progressBar.style.width = '10%';
    }

    try {
        const missingWOs = selectedWOs.filter(wo => !globalDataCache[wo] || globalDataCache[wo].length === 0);
        if (missingWOs.length > 0) {
            if (!isSilent && progressText) progressText.innerText = `Fetching live records for ${missingWOs.length} selected Work Order(s)...`;
            await Promise.all(missingWOs.map(wo => fetchSingleUrgentRackWO(wo)));
        }
    } catch (err) {
        console.warn("Failed to fetch fresh MES data for selected WOs:", err);
    }

    if (!isSilent) {
        if (progressText) progressText.innerText = "Extracting and formatting consolidated records...";
        if (progressBar) progressBar.style.width = '40%';
    }

    let testingRecords = [colKeys];
    for (let wo of selectedWOs) {
        const data = globalDataCache[wo] || [];
        data.forEach(row => {
            testingRecords.push(colKeys.map(key => {
                let val = row[key];
                if (key === "TravelerCard") val = row["TravelerCard"] || row["TraverlerCard"];
                return val !== undefined && val !== null ? String(val).trim() : "";
            }));
        });
    }

    if (!isSilent && progressBar) progressBar.style.width = '60%';

    if (testingRecords.length === 1) {
        if (!isSilent) {
            if (overlay) overlay.style.display = 'none';
            showStatus("No data found for selected Work Orders.", "orange");
        }
        return;
    }

    const payload = {
        sync_type: "sync_all_testing",
        records: testingRecords
    };

    if (!isSilent) {
        if (progressText) progressText.innerText = "Pushing data to Google Spreadsheet...";
        if (progressBar) progressBar.style.width = '80%';
    }

    try {
        await fetch(GOOGLE_SHEETS_WEBHOOK, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        });

        if (!isSilent) {
            if (progressBar) progressBar.style.width = '100%';
            if (progressText) progressText.innerText = "Successfully updated Placeholder sheet!";

            const iframe = document.getElementById('excelIframe');
            if (iframe) {
                iframe.src = `${GOOGLE_SHEET_URL}?gid=2088749144#gid=2088749144`;
            }

            setTimeout(() => {
                if (overlay) {
                    overlay.style.opacity = '0';
                    setTimeout(() => {
                        overlay.style.display = 'none';
                        overlay.style.opacity = '1';
                    }, 300);
                }
                showStatus("Successfully synchronized all selected WOs to 'Placeholder' tab!", "green");
            }, 1500);
        }

    } catch (e) {
        console.error("Failed to push testing tab update:", e);
        if (!isSilent) {
            if (overlay) overlay.style.display = 'none';
            showStatus("Failed to sync to 'Placeholder' tab.", "red");
        }
    }
}

function onSummaryCheckboxChange(wo, isChecked) {
    const urgentCb = document.querySelector(`.urgent-checkbox[value="${wo}"]`);
    if (urgentCb) {
        urgentCb.checked = isChecked;
        updateMainViews();
    }
}

function toggleAllSummary(masterBox) {
    const checkboxes = document.querySelectorAll('.summary-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = masterBox.checked;
        const urgentCb = document.querySelector(`.urgent-checkbox[value="${cb.value}"]`);
        if (urgentCb) urgentCb.checked = masterBox.checked;
    });
    updateMainViews();
}

async function searchContainer() {
    const inputVal = document.getElementById('searchInput').value;
    const isWO = currentSearchMode === 'wo';
    const itemLabel = isWO ? "Work Order(s)" : "Part Number(s) / Product Name(s)";

    if (!inputVal.trim()) return alert(`Please enter ${itemLabel}`);

    isSearching = true; 

    const searchItems = inputVal.split(/[\s,\n\r\t]+/).map(w => w.trim()).filter(w => w !== "");
    document.getElementById('searchInput').value = ""; 
    
    let addedCount = 0;
    let notFound = [];
    let newWOsToAdd = [];
    let existingWOsToBump = [];
    
    const btn = document.querySelector('.search-container button');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Searching...";
    }

    try {
        const results = await Promise.all(searchItems.map(async (queryItem) => {
            const payload = {
                "page": 1,
                "rows": 3000,
                "sort": "",
                "order": "desc",
                "wheres": "[]",
                "mfgOrder": isWO ? queryItem : "",
                "MfgOrderName": isWO ? queryItem : "",
                "ProductName": isWO ? "" : queryItem,
                "CompletionDateEnd": "",
                "CompletionDateStart": "",
                "CustomerName": "",
                "LotStatus": "",
                "MfgLine": "",
                "OrderStatus": "",
                "StartDateEnd": "",
                "StartDateStart": "",
                "TraverlerCard": ""
            };

            try {
                const response = await fetch(MES_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                let rawRows = [];
                if (response.ok) {
                    const rawResponse = await response.json();
                    rawRows = rawResponse.RTDAT || rawResponse.rows || rawResponse.data || (Array.isArray(rawResponse) ? rawResponse : []);
                }

                let woMap = {};
                if (rawRows && rawRows.length > 0) {
                    const cleanQuery = queryItem.trim().toLowerCase();
                    const matchedWOSet = new Set();
                    
                    rawRows.forEach(row => {
                        if (!isWO) {
                            const rowPN = String(row.ProductName || row.productName || row.CustomerProduct || "").trim().toLowerCase();
                            if (rowPN && rowPN === cleanQuery) {
                                let woName = row.MfgOrderName || row.mfgOrder || row.mfgOrderName || row.WorkOrder;
                                if (woName) matchedWOSet.add(String(woName).trim());
                            }
                        } else {
                            const rowWO = String(row.MfgOrderName || row.mfgOrder || row.mfgOrderName || row.WorkOrder || "").trim().toLowerCase();
                            // `cleanQuery.includes(rowWO)` was dropped on purpose: it
                            // matched any row whose WO happened to be a short substring
                            // of the searched value, pulling unrelated rows (and
                            // therefore unrelated WOs) into the result set.
                            if (rowWO && (rowWO === cleanQuery || rowWO.includes(cleanQuery))) {
                                let woName = row.MfgOrderName || row.mfgOrder || row.mfgOrderName || row.WorkOrder;
                                if (woName) matchedWOSet.add(String(woName).trim());
                            }
                        }
                    });

                    matchedWOSet.forEach(wo => {
                        woMap[wo] = selectRowsForWO(rawRows, wo);
                    });
                }

                const success = Object.keys(woMap).length > 0;
                return { item: queryItem, woMap, rawRows, success };
            } catch (error) {
                console.error(`Error querying MES for ${itemLabel} ${queryItem}:`, error);
                return { item: queryItem, woMap: {}, rawRows: [], success: false };
            }
        }));

        for (let res of results) {
            if (res.success) {
                Object.keys(res.woMap).forEach(wo => {
                    const woRawRows = res.woMap[wo];
                    globalDataCache[wo] = woRawRows;
                    const pnMatchRow = woRawRows.find(r => r.ProductName && String(r.ProductName).trim().toLowerCase() === res.item.trim().toLowerCase()) || woRawRows[0];
                    if (pnMatchRow && pnMatchRow.ProductName) {
                        productDesCache[wo] = pnMatchRow.ProductName;
                    }
                    const existingIdx = urgentWOs.indexOf(wo);
                    if (existingIdx > -1) {
                        urgentWOs.splice(existingIdx, 1);
                        existingWOsToBump.push(wo);
                    } else {
                        newWOsToAdd.push(wo);
                        addedCount++;
                    }
                });
            } else {
                notFound.push(res.item);
            }
        }

        if (existingWOsToBump.length > 0) {
            urgentWOs.unshift(...existingWOsToBump.reverse());
        }

        if (addedCount > 0) {
            urgentWOs.unshift(...newWOsToAdd.reverse()); 
            saveUrgentWOsToStorage();
            try {
                await fetch(`${NODE_BACKEND_URL}/api/urgent-wos/add`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ wos: newWOsToAdd, list_type: currentSearchMode })
                });
            } catch (err) {}
        } 

        if (existingWOsToBump.length > 0 || addedCount > 0) {
            saveUrgentWOsToStorage();
            try {
                await fetch(`${NODE_BACKEND_URL}/api/urgent-wos/reorder`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderedWOs: window.urgentWOs, list_type: currentSearchMode })
                });
            } catch (err) {}
        }

        const validSearchedWOs = [...newWOsToAdd, ...existingWOsToBump];

        initUrgentRackTable(validSearchedWOs, true);

        if (validSearchedWOs.length > 0) {
            validSearchedWOs.forEach(wo => {
                const newlyAddedRow = document.querySelector(`tr[data-wo="${wo}"] .urgent-checkbox`);
                if (newlyAddedRow) newlyAddedRow.checked = true;
                const res = calculateWOCompletion(wo, activeLines);
                totalWHCache[wo] = res.total;
                completedWHCache[wo] = res.completed;
                pctCache[wo] = res.pctStr;
            });
            updateMainViews();

            const scrollArea = document.querySelector('.left-panel .scrollable-content');
            if (scrollArea) scrollArea.scrollTop = 0;
        }

        // Display popup message for items that do not exist in MES Database
        if (notFound.length > 0) {
            alert(`⚠️ The following ${isWO ? "Work Order(s)" : "Part Number(s)"} do not exist in the MES Database and were not added to the WH WO Status list:\n\n` + notFound.join("\n"));
        }

        // 🚀 Reset button state IMMEDIATELY so the user sees "Search" as soon as WOs appear in the list!
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Search";
        }
        isSearching = false;

        // 📊 Run background fetch of MES data only (does NOT write to Placeholder/WH Summary).
        // Searching WOs/Part Numbers must NOT auto-update Google Sheets — that only happens
        // via the manual "Placeholder"/"WH Summary" buttons or the gated 1-hour auto-sync.
        fetchUrgentRackData();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Search";
        }
        isSearching = false;
    } 
}

async function addMultipleUrgentWOs() {
    const inputStr = prompt("Paste Work Orders to ADD (separated by spaces, commas, or dots):");
    if (!inputStr) return;
    document.getElementById('searchInput').value = inputStr;
    searchContainer();
}

async function deleteSelectedWOs() {
    const checkboxes = document.querySelectorAll('.urgent-checkbox:checked');
    if (checkboxes.length === 0) return alert("Please select at least one Work Order to delete.");
    if (!confirm(`Are you sure you want to remove ${checkboxes.length} selected Work Order(s)?`)) return;

    isDeletingWOs = true;
    const activeSearchMode = currentSearchMode; // Explicitly capture active search mode ('wo' or 'pn')
    const wosToRemove = Array.from(checkboxes).map(cb => cb.value);
    
    // ⚡ Optimistic UI update: Save undo state and remove immediately from active list
    if (typeof saveState === 'function') saveState();

    if (activeSearchMode === 'pn') {
        urgentWOs_pn = urgentWOs_pn.filter(wo => !wosToRemove.includes(wo));
    } else {
        urgentWOs_wo = urgentWOs_wo.filter(wo => !wosToRemove.includes(wo));
    }

    const activeList = activeSearchMode === 'pn' ? urgentWOs_pn : urgentWOs_wo;
    const isAllDeleted = activeList.length === 0;
    
    // Clean up cache only if the WO is no longer present in EITHER tab list
    wosToRemove.forEach(wo => {
        if (!urgentWOs_wo.includes(wo) && !urgentWOs_pn.includes(wo)) {
            delete globalDataCache[wo];
            delete totalWHCache[wo];
            delete completedWHCache[wo];
            delete pctCache[wo];
            delete productDesCache[wo];
        }
    });
    
    saveUrgentWOsToStorage();

    // Re-render UI views instantly
    initUrgentRackTable();
    updateMainViews();
    
    try {
        const removeResp = await fetch(`${NODE_BACKEND_URL}/api/urgent-wos/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                wos: wosToRemove,
                clear_all: isAllDeleted,
                list_type: activeSearchMode
            })
        });

        if (removeResp.ok) {
            const resData = await removeResp.json();
            if (resData && Array.isArray(resData.wos)) {
                if (activeSearchMode === 'pn') {
                    urgentWOs_pn = isAllDeleted ? [] : resData.wos;
                } else {
                    urgentWOs_wo = isAllDeleted ? [] : resData.wos;
                }
                saveUrgentWOsToStorage();
            }
        }

        if (isAllDeleted) {
            if (activeSearchMode === 'pn') {
                urgentWOs_pn = [];
            } else {
                urgentWOs_wo = [];
            }
            saveUrgentWOsToStorage();
            
            await fetch(`${NODE_BACKEND_URL}/api/urgent-wos/reorder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedWOs: [], list_type: activeSearchMode })
            }).catch(() => {});
        }
    } catch (err) {
        console.error("Error sending remove_urgent request:", err);
    } finally {
        initUrgentRackTable();
        updateMainViews();
        setTimeout(() => {
            isDeletingWOs = false;
            syncUrgentRack(); 
        }, 1000);
    }
}

function sortUrgentWOs() {
    if (currentSortMode === 'manual') {
        initUrgentRackTable();
        updateMainViews();
        return;
    }

    urgentWOs.sort((a, b) => {
        if (currentSortMode === 'completion') {
            let pctA = parseFloat(pctCache[a]) || 0;
            let pctB = parseFloat(pctCache[b]) || 0;
            return pctB - pctA; 
        } else {
            let dateA = woDates[a] || Infinity;
            let dateB = woDates[b] || Infinity;
            return dateA - dateB; 
        }
    });

    if (urgentWOs.length > 0) {
        fetch(`${NODE_BACKEND_URL}/api/urgent-wos/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderedWOs: urgentWOs, list_type: currentSearchMode })
        }).catch(err => {});
    }

    initUrgentRackTable();
    updateMainViews();
}

async function fetchUrgentRackData() {
    if (isFetchingMES) return; 
    isFetchingMES = true;
    try {
        const batchSize = 10;
        for (let i = 0; i < urgentWOs.length; i += batchSize) {
            const batch = urgentWOs.slice(i, i + batchSize);
            await Promise.all(batch.map(wo => fetchSingleUrgentRackWO(wo)));
        }
    } finally {
        isFetchingMES = false;
        sortUrgentWOs();
    }
}

// One in-flight MES request per WO, plus a per-WO sequence number.
// The 5s rack sync, the 5 minute refresh, the post-search refresh and
// updateMainViews() can all ask for the same WO at the same time; without
// this a slower/stale response could land last and overwrite good data with a
// partial or empty result (the "Total WH 1 / Completed 0" symptom).
const woFetchInFlight = {};
const woFetchSeq = {};

function fetchSingleUrgentRackWO(wo) {
    if (woFetchInFlight[wo]) return woFetchInFlight[wo];

    const seq = (woFetchSeq[wo] = (woFetchSeq[wo] || 0) + 1);
    const promise = doFetchSingleUrgentRackWO(wo, seq);
    const cleanup = () => {
        if (woFetchInFlight[wo] === promise) delete woFetchInFlight[wo];
    };
    promise.then(cleanup, cleanup);

    woFetchInFlight[wo] = promise;
    return promise;
}

async function doFetchSingleUrgentRackWO(wo, seq) {
    try {
        const payload = {
            "page": 1,
            "rows": 3000,
            "sort": "",
            "order": "desc",
            "wheres": "[]",
            "mfgOrder": wo,
            "MfgOrderName": wo,
            "CompletionDateEnd": "",
            "CompletionDateStart": "",
            "CustomerName": "",
            "LotStatus": "",
            "MfgLine": "",
            "OrderStatus": "",
            "ProductName": "",
            "StartDateEnd": "",
            "StartDateStart": "",
            "TraverlerCard": ""
        };

        const response = await fetch(MES_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (response.ok) {
            const rawResponse = await response.json();
            let rawRows = rawResponse.RTDAT || rawResponse.rows || rawResponse.data || (Array.isArray(rawResponse) ? rawResponse : []);
            
            // A newer request for this WO started while we were waiting -
            // discard this (older) answer instead of letting it win.
            if (woFetchSeq[wo] !== seq) return;

            // Same row selection as searchContainer(), so both writers that fill
            // globalDataCache[wo] always agree on the row set.
            const data = selectRowsForWO(rawRows, wo);

            if (data.length === 0) {
                // MES transiently returned nothing usable for this WO. Keep
                // whatever we already had: wiping globalDataCache here is what
                // made the WO Summary suddenly drop to Total WH 1 / 0.00%.
                return;
            }

            globalDataCache[wo] = data;

            const res = calculateWOCompletion(wo, activeLines);
            totalWHCache[wo] = res.total;
            completedWHCache[wo] = res.completed;
            pctCache[wo] = res.pctStr;

            if (lastRecordedPct[wo] !== res.pctNum) {
                lastRecordedPct[wo] = res.pctNum;
                historyQueue.push({ wo_number: wo, pct: res.pctNum });
            }

            if (data.length > 0 && data[0].ProductName) {
                productDesCache[wo] = data[0].ProductName;
            }

            // Non-blocking background fetch for optional Product Description (only if missing or "--")
            if (!productDesCache[wo] || productDesCache[wo] === "--") {
                productDesCache[wo] = "--"; 
                fetch('/api/task-report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        "SpecName": "", "EmployeeName": "", "IsTiming": "0", 
                        "StartTimeArray": [], "MfgLineName": "", "ProductName": "", 
                        "TaskName": "", "WorkOrder": "", "WorkOrderArray": [wo] 
                    })
                }).then(res => res.ok ? res.json() : []).then(trData => {
                    if (Array.isArray(trData)) {
                        for (let r of trData) {
                            let desc = r.ProductDes || r.ProductDesc || r.ProductDescription;
                            if (desc && desc.trim() !== "" && (!productDesCache[wo] || productDesCache[wo] === "--")) {
                                productDesCache[wo] = desc.trim();
                                const descCell = document.getElementById(`urgent-desc-${wo}`);
                                if (descCell) {
                                    descCell.innerText = productDesCache[wo];
                                    descCell.title = productDesCache[wo];
                                }
                                const selectedWOs = Array.from(document.querySelectorAll('.urgent-checkbox:checked')).map(cb => cb.value);
                                if (selectedWOs.includes(wo)) renderSummaryTable(selectedWOs);
                                break;
                            }
                        }
                    }
                }).catch(() => {});
            }

            const pctCell = document.getElementById(`urgent-pct-${wo}`);
            if (pctCell) {
                pctCell.innerText = res.pctStr;
                pctCell.style.fontStyle = "normal";
                pctCell.style.fontWeight = "bold";
                pctCell.style.color = (res.completed === res.total && res.total > 0) ? '#52c41a' : '#faad14';
            }
        }
    } catch (error) {
        if (!pctCache[wo]) {
            const pctCell = document.getElementById(`urgent-pct-${wo}`);
            if (pctCell) {
                pctCell.innerText = "Error";
                pctCell.style.color = "red";
            }
        }
    }
}

// ==========================================
// 4. MAIN VIEWS (SUMMARY & PIVOTS)
// ==========================================
function toggleLine(line) {
    const idx = activeLines.indexOf(line);
    if (idx > -1) {
        if (activeLines.length > 1) activeLines.splice(idx, 1);
    } else {
        activeLines.push(line);
    }
    
    document.querySelectorAll('.btn-toggle').forEach(btn => {
        if (activeLines.includes(btn.innerText)) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    
    updateWOListCompletionPercentages();
    updateMainViews();
}

// Register the DataLabels plugin globally for Chart.js safely
if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
    try {
        Chart.register(ChartDataLabels);
    } catch (e) {
        console.warn("Could not register ChartDataLabels:", e);
    }
}

// 🚨 NEW: State for tracking which WOs are selected for the chart filter
let unselectedChartWOs = [];
let chartSelectedWOs = [];

function setChartType(type) {
    currentChartType = type;
    document.getElementById('chart-btn-bar').classList.remove('active');
    document.getElementById('chart-btn-pie').classList.remove('active');
    document.getElementById(`chart-btn-${type}`).classList.add('active');
    updateMainViews();
}

// =========================================================
// 3. SAFE MAIN VIEWS UPDATER
// =========================================================
async function updateMainViews() {
    // Ensure safety nets exist just in case they were accidentally deleted
    window.unselectedChartWOs = window.unselectedChartWOs || [];
    window.chartSelectedWOs = window.chartSelectedWOs || [];

    const checkedUrgentBoxes = Array.from(document.querySelectorAll('.urgent-checkbox:checked')).map(cb => cb.value);
    const selectedWOs = Array.from(new Set(checkedUrgentBoxes));

    // Clean up blacklist and calculate chart WOs
    window.unselectedChartWOs = window.unselectedChartWOs.filter(wo => selectedWOs.includes(wo));
    window.chartSelectedWOs = selectedWOs.filter(wo => !window.unselectedChartWOs.includes(wo));

    const sumCont = document.getElementById('summaryContainer');
    const pivCont = document.getElementById('pivotContainer');
    const chartCont = document.getElementById('chartContainer');

    // Make sure containers are visible
    if (sumCont) { sumCont.style.display = 'flex'; sumCont.style.flexDirection = 'column'; }
    if (pivCont) { pivCont.style.display = 'flex'; pivCont.style.flexDirection = 'column'; }
    if (chartCont) { chartCont.style.display = 'flex'; chartCont.style.flexDirection = 'column'; }

    // Live fetch for any missing data first (only fetch if never queried before or empty)
    const missingWOs = selectedWOs.filter(wo => !globalDataCache[wo] || globalDataCache[wo].length === 0);
    if (missingWOs.length > 0) {
        try {
            await Promise.all(missingWOs.map(wo => fetchSingleUrgentRackWO(wo)));
        } catch (err) {
            console.warn("[updateMainViews] Error fetching missing WOs:", err);
        }
    }

    // Render modules safely
    if (typeof buildWODropdown === 'function') buildWODropdown(selectedWOs);
    if (typeof renderSummaryTable === 'function') renderSummaryTable(selectedWOs);
    if (typeof renderPivotTables === 'function') renderPivotTables(window.chartSelectedWOs);
    if (typeof renderChart === 'function') renderChart(window.chartSelectedWOs);
}

// 🚨 NEW: Dynamic Dropdown Builder
function buildWODropdown(allWOs) {
    const wrapper = document.getElementById('woChartDropdownWrapper');
    const menu = document.getElementById('woChartDropdown');
    if (!wrapper || !menu) return;
    
    wrapper.style.display = 'block';
    let html = '';
    
    allWOs.forEach(wo => {
        // It is checked if it's NOT in the blacklist
        let checked = !unselectedChartWOs.includes(wo) ? 'checked' : '';
        html += `<label style="display:flex; align-items:center; gap:6px; font-size:11px; font-weight:bold; color:#555; cursor:pointer; margin-bottom:6px;">
                    <input type="checkbox" value="${wo}" ${checked} onchange="handleWOChartFilterChange(this)"> ${wo}
                 </label>`;
    });
    
    menu.innerHTML = html;
}

// 🚨 NEW: Handles Check/Uncheck inside the chart dropdown
function handleWOChartFilterChange(cb) {
    if (cb.checked) {
        // Remove from blacklist
        unselectedChartWOs = unselectedChartWOs.filter(w => w !== cb.value);
    } else {
        // Add to blacklist
        if (!unselectedChartWOs.includes(cb.value)) unselectedChartWOs.push(cb.value);
    }
    
    // Recalculate what goes to the chart
    const currentSelectedWOs = Array.from(document.querySelectorAll('.urgent-checkbox:checked')).map(checkbox => checkbox.value);
    chartSelectedWOs = currentSelectedWOs.filter(wo => !unselectedChartWOs.includes(wo));

    renderPivotTables(chartSelectedWOs);
    renderChart(chartSelectedWOs);
}

function formatDateDisplay(val) {
    if (!val || val === "null" || val === "undefined") return "--";
    let s = String(val).trim();
    if (s.includes("T")) s = s.split("T")[0];
    if (s.includes(" ")) s = s.split(" ")[0];
    return s || "--";
}

function renderSummaryTable(selectedWOs) {
    const thead = document.getElementById("summaryHead");
    const tbody = document.getElementById("summaryBody");
    if (!thead || !tbody) return;

    const isWO = currentSearchMode === 'wo';

    let thHtml = "";
    if (isWO) {
        thHtml = `<tr>
            <th style="width: 20px; text-align: center;"><input type="checkbox" id="selectAllSummary" onclick="toggleAllSummary(this)" checked></th>
            <th>WO</th>
            <th>Total WH WO</th>
            <th>Completed WH WO</th>
            <th>Completion %</th>
            <th>Remaining Time</th>
            <th>Product Des</th>
            <th>Customer</th>
            <th>Total Records</th>
        </tr>`;
    } else {
        thHtml = `<tr>
            <th style="width: 20px; text-align: center;"><input type="checkbox" id="selectAllSummary" onclick="toggleAllSummary(this)" checked></th>
            <th>WO</th>
            <th>TraverlerCard</th>
            <th>PN</th>
            <th>QTY</th>
            <th>PlannedStart</th>
            <th>PlannedComplete</th>
            <th>SpecName</th>
        </tr>`;
    }
    thead.innerHTML = thHtml;

    if (!selectedWOs || selectedWOs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${isWO ? 9 : 8}" style="text-align: center; color: #888; padding: 25px; font-style: italic;">Select Work Orders from the table on the left to view summary details.</td></tr>`;
        const totalRemainingTimeEl = document.getElementById("totalRemainingTime");
        if (totalRemainingTimeEl) {
            const spanValue = totalRemainingTimeEl.querySelector("span");
            if (spanValue) spanValue.innerText = "0.00";
        }
        return;
    }

    // In Part Number mode, sort selected WOs from oldest PlannedStartDate to earliest
    if (!isWO && Array.isArray(selectedWOs)) {
        selectedWOs.sort((a, b) => {
            const rawA = globalDataCache[a] || [];
            const dataA = rawA.filter(r => !isLineWH(r));
            const dateAStr = dataA.length > 0 ? (dataA[0].PlannedStartDate || "") : "";

            const rawB = globalDataCache[b] || [];
            const dataB = rawB.filter(r => !isLineWH(r));
            const dateBStr = dataB.length > 0 ? (dataB[0].PlannedStartDate || "") : "";

            if (!dateAStr && !dateBStr) return 0;
            if (!dateAStr) return 1;
            if (!dateBStr) return -1;

            const timeA = new Date(dateAStr).getTime();
            const timeB = new Date(dateBStr).getTime();
            if (isNaN(timeA) && isNaN(timeB)) return 0;
            if (isNaN(timeA)) return 1;
            if (isNaN(timeB)) return -1;

            return timeA - timeB;
        });
    }

    let tbHtml = "";
    let grandRemainingTime = 0;

    selectedWOs.forEach(wo => {
        const rawData = globalDataCache[wo] || [];
        if (rawData.length === 0) {
            // Never silently drop the row. An empty cache now shows an explicit
            // "no data" row instead of the row vanishing (or worse, showing a
            // Total WH of 0 / 0.00% that looks like real data).
            tbHtml += `<tr>
                <td style="text-align: center;"><input type="checkbox" value="${wo}" class="summary-checkbox" checked onchange="onSummaryCheckboxChange('${wo}', this.checked)"></td>
                <td style="white-space: nowrap; font-weight:bold; color: #1890ff;">${wo}</td>
                <td colspan="${isWO ? 7 : 6}" style="text-align:center; color:#faad14; font-style:italic; padding: 12px;">⏳ No MES data received for this WO yet</td>
            </tr>`;
            return;
        }
        const data = isWO ? rawData : rawData.filter(r => !isLineWH(r));
        if (data.length === 0) return;

        const firstRow = data[0] || {};

        if (isWO) {
            const productDes = firstRow.ProductName || productDesCache[wo] || "--";
            const customer = firstRow.CustomerName || "--";
            const totalRecords = data.length;

            const completion = calculateWOCompletion(wo, activeLines);
            const totalWHWO = completion.total;
            const completedWHWO = completion.completed;
            const completionPct = completion.pctStr;
            const pctNum = completion.pctNum;

            let totalTimeMinutes = 0;
            let remainingTimeMinutes = 0;

            data.forEach(row => {
                let matchesLine = activeLines.some(line => rowMatchesLine(row, line));
                if (matchesLine) {
                    let isCompleted = false;
                    if (row.ContainerStatus && String(row.ContainerStatus).toLowerCase().includes('completed')) {
                        isCompleted = true;
                    } else if (row.SpecName && String(row.SpecName).toLowerCase().includes('line wh')) {
                        isCompleted = true;
                    }

                    let orderQty = parseFloat(row.OrderQty) || 0;
                    let manTime = parseFloat(row.ManTime) || 0;
                    let taskTime = orderQty * manTime;

                    totalTimeMinutes += taskTime;
                    if (!isCompleted) {
                        remainingTimeMinutes += taskTime;
                    }
                }
            });

            grandRemainingTime += remainingTimeMinutes;
            const remainingHrs = (remainingTimeMinutes / 60).toFixed(2);
            const totalHrs = (totalTimeMinutes / 60).toFixed(2);
            const timeStr = `${remainingHrs} / ${totalHrs} hrs`;

            let pctColor = "#1890ff";
            if (pctNum >= 100) pctColor = "#52c41a";
            else if (pctNum < 50) pctColor = "#ff4d4f";

            tbHtml += `<tr>
                <td style="text-align: center;"><input type="checkbox" value="${wo}" class="summary-checkbox" checked onchange="onSummaryCheckboxChange('${wo}', this.checked)"></td>
                <td class="wo-num-cell" style="font-weight:bold; color: #1890ff;">${wo}</td>
                <td style="text-align: center; font-weight:bold;">${totalWHWO}</td>
                <td style="text-align: center; font-weight:bold; color: #52c41a;">${completedWHWO}</td>
                <td style="text-align: center; font-weight:bold; color: ${pctColor}">${completionPct}</td>
                <td style="text-align: center; font-weight:bold; color: #d97706; white-space: nowrap;">${timeStr}</td>
                <td style="font-weight:bold; color: #333; max-width: 200px; word-break: break-word;">${productDes}</td>
                <td style="max-width: 160px; word-break: break-word;">${customer}</td>
                <td style="text-align: center;">${totalRecords}</td>
            </tr>`;

        } else {
            const pn = firstRow.ProductName || productDesCache[wo] || "--";
            const qty = firstRow.OrderQty !== undefined && firstRow.OrderQty !== null ? firstRow.OrderQty : (firstRow.Qty !== undefined && firstRow.Qty !== null ? firstRow.Qty : "--");
            const plannedStart = formatDateDisplay(firstRow.PlannedStartDate);
            const plannedComplete = formatDateDisplay(firstRow.PlannedCompletionDate);

            // Collect unique spec names (including Line WH)
            const specSet = new Set();
            data.forEach(r => { if (r.SpecName) specSet.add(String(r.SpecName).trim()); });
            const specNameStr = specSet.size > 0 ? Array.from(specSet).join(", ") : "--";

            // Collect unique traveler card values
            const cardSet = new Set();
            data.forEach(r => {
                let card = r.TraverlerCard || r.traverlerCard || r.TravelerCard || r.travelerCard;
                if (card && String(card).trim() !== "" && String(card).trim() !== "null" && String(card).trim() !== "undefined") {
                    cardSet.add(String(card).trim());
                }
            });
            const travelerCardStr = cardSet.size > 0 ? Array.from(cardSet).join(", ") : (firstRow.TraverlerCard || firstRow.traverlerCard || "--");

            // Calculate CT (Remaining Time in hours) for total remaining time indicator
            let remainingTime = 0;
            data.forEach(row => {
                let matchesLine = activeLines.some(line => rowMatchesLine(row, line));
                if (matchesLine) {
                    let isCompleted = false;
                    if (row.ContainerStatus && String(row.ContainerStatus).toLowerCase().includes('completed')) {
                        isCompleted = true;
                    } 
                    else if (row.SpecName && String(row.SpecName).toLowerCase().includes('line wh')) {
                        isCompleted = true;
                    }

                    let orderQty = parseFloat(row.OrderQty) || 0;
                    let manTime = parseFloat(row.ManTime) || 0;
                    let taskTime = orderQty * manTime;

                    if (!isCompleted) {
                        remainingTime += taskTime;
                    }
                }
            });

            grandRemainingTime += remainingTime;

            tbHtml += `<tr>
                <td style="text-align: center;"><input type="checkbox" value="${wo}" class="summary-checkbox" checked onchange="onSummaryCheckboxChange('${wo}', this.checked)"></td>
                <td style="white-space: nowrap; font-weight:bold; color: #1890ff;">${wo}</td>
                <td style="white-space: nowrap; font-weight:bold; color: #333;">${travelerCardStr}</td>
                <td style="white-space: nowrap; font-weight:bold; color: #333;">${pn}</td>
                <td>${qty}</td>
                <td style="white-space: nowrap;">${plannedStart}</td>
                <td style="white-space: nowrap;">${plannedComplete}</td>
                <td style="white-space: normal; word-break: break-word; max-width: 200px;">${specNameStr}</td>
            </tr>`;
        }
    });

    tbody.innerHTML = tbHtml;

    const totalRemainingTimeEl = document.getElementById("totalRemainingTime");
    if (totalRemainingTimeEl) {
        const spanValue = totalRemainingTimeEl.querySelector("span");
        if (spanValue) spanValue.innerText = (grandRemainingTime / 60).toFixed(2);
    }
}

function renderPivotTables(selectedWOs) {
    let wrapper = document.getElementById('pivotTablesWrapper');
    if (!wrapper) return;
    let pivotHtml = "";
    
    if (!selectedWOs || selectedWOs.length === 0) {
        selectedWOs = Array.from(new Set([
            ...Array.from(document.querySelectorAll('.summary-checkbox:checked')).map(cb => cb.value),
            ...Array.from(document.querySelectorAll('.urgent-checkbox:checked')).map(cb => cb.value)
        ]));
    }

    if (!selectedWOs || selectedWOs.length === 0) {
        wrapper.innerHTML = `<div style="padding: 20px; text-align: center; color: #888; font-style: italic;">No Work Orders selected for Chart Analysis.</div>`;
        return;
    }

    const selectedLines = Array.from(document.querySelectorAll('.chart-line-filter:checked')).map(cb => cb.value);
    const activeSubLines = Array.from(document.querySelectorAll('.mfg-line-filter:checked')).map(cb => cb.value);
    const lineFilters = selectedLines.length > 0 ? selectedLines : ["WH", "BB", "SI"];
    let seenContainers = new Set();
    
    selectedWOs.forEach(wo => {
        const data = globalDataCache[wo] || [];
        let specCounts = {};
        
        data.forEach(row => {
            // Include all SpecNames (including Line WH)!

            // Only filter by sub-lines if sub-line checkboxes are active!
            if (activeSubLines.length > 0 && !activeSubLines.includes(row.MfgLineName)) {
                return;
            }

            let specificLine = getRowLineCategory(row);
            if (!lineFilters.includes(specificLine)) return;

            let specStr = (row.SpecName || row.specName || "").trim();
            if (!specStr || specStr.toLowerCase() === "not stated" || specStr.toLowerCase() === "null" || specStr.toLowerCase() === "none" || specStr === "--") {
                specStr = "No Spec / Unknown";
            }

            // Create a unique key per container, line, and SpecName to avoid duplicate counting
            let containerKey = "";
            if (row.ContainerName && String(row.ContainerName).trim() !== "") {
                containerKey = String(row.ContainerName).trim();
            } else {
                containerKey = `${row.MfgOrderName || ''}_${row.TaskListName || ''}_${row.PlannedStartDate || ''}_${row.OrderQty || 0}`;
            }

            let uniqueKey = `${containerKey}_${specificLine}_${specStr}`;
            if (seenContainers.has(uniqueKey)) {
                return;
            }
            seenContainers.add(uniqueKey);
            
            let qty = parseFloat(row.OrderQty) || parseFloat(row.Qty) || 0;
            
            if (!specCounts[specStr]) {
                specCounts[specStr] = { qty: 0, count: 0 };
            }
            specCounts[specStr].qty += qty;
            specCounts[specStr].count += 1;
        });
        
        if (Object.keys(specCounts).length > 0) {
            pivotHtml += `
            <div style="background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 15px; width: 100%; box-sizing: border-box;">
                <h4 style="margin: 0 0 10px 0; color: #1890ff; text-align: center;">WO: ${wo}</h4>
                <table class="compact-table" style="background: white; width: 100%;">
                    <thead>
                        <tr>
                            <th style="text-align: center;">SpecName (Category)</th>
                            <th style="text-align: center;">Total Quantity</th>
                            <th style="text-align: center;">Task Count</th>
                        </tr>
                    </thead>
                    <tbody>`;
            for (let spec of Object.keys(specCounts).sort()) {
                pivotHtml += `<tr>
                    <td style="text-align: center;">${spec}</td>
                    <td style="text-align: center;"><span style="font-weight:bold;">${specCounts[spec].qty}</span></td>
                    <td style="text-align: center; color: #888; font-size: 12px;">${specCounts[spec].count} rows</td>
                </tr>`;
            }
            pivotHtml += `</tbody></table></div>`;
        } else {
            pivotHtml += `<div style="padding: 10px; text-align: center;"><i>No matching data under current filters for ${wo}...</i></div>`;
        }
    });
    wrapper.innerHTML = pivotHtml;
}

// =========================================================
// 4. SAFE CHART RENDERER (Fixes crash on Chart Object)
// =========================================================
// =========================================================
// 4. PURE NATIVE HTML5 CANVAS CHART ENGINE (Zero External Libraries!)
// =========================================================
// =========================================================
// 4. PURE NATIVE HTML5 CANVAS CHART ENGINE (Interactive & Zero External Libraries!)
// =========================================================
function renderChart(selectedWOs) {
    const canvas = document.getElementById('analyticsChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Auto-fit canvas size to parent container
    const parent = canvas.parentElement;
    const width = parent ? parent.clientWidth : 400;
    const height = parent ? parent.clientHeight : 220;
    
    // Scale for crisp high-DPI rendering
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    // Initialize hitboxes array for interactive clicks & hovers
    canvas.__chartHitBoxes = [];

    // Bind event listeners once
    if (!canvas.__eventsBound) {
        canvas.__eventsBound = true;

        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const hit = findChartHit(canvas, mx, my);
            canvas.style.cursor = hit ? 'pointer' : 'default';
        });

        canvas.addEventListener('click', (e) => {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const hit = findChartHit(canvas, mx, my);
            if (hit) openChartModal(hit);
        });
    }

    if (!selectedWOs || selectedWOs.length === 0) {
        selectedWOs = Array.from(new Set([
            ...Array.from(document.querySelectorAll('.summary-checkbox:checked')).map(cb => cb.value),
            ...Array.from(document.querySelectorAll('.urgent-checkbox:checked')).map(cb => cb.value)
        ]));
    }

    if (!selectedWOs || selectedWOs.length === 0) {
        ctx.font = "13px Inter, sans-serif";
        ctx.fillStyle = "#888888";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Select Work Orders on the left to display Data Visualization.", width / 2, height / 2);
        return; 
    }

    const selectedLines = Array.from(document.querySelectorAll('.chart-line-filter:checked')).map(cb => cb.value);
    const activeSubLines = Array.from(document.querySelectorAll('.mfg-line-filter:checked')).map(cb => cb.value);
    const activeLines = selectedLines.length > 0 ? selectedLines : ["WH", "BB", "SI"];

    const isPNTab = currentSearchMode === 'pn';

    let aggregatedData = {};
    let specLineWOSet = {};
    let specLineRows = {};
    let specRows = {};
    let seenContainers = new Set();

    selectedWOs.forEach(wo => {
        const data = globalDataCache[wo] || [];
        data.forEach(row => {
            // Include all SpecNames (including Line WH)!

            if (activeSubLines.length > 0 && !activeSubLines.includes(row.MfgLineName)) return;

            let specificLine = getRowLineCategory(row);
            if (!activeLines.includes(specificLine)) return; 

            let specStr = (row.SpecName || row.specName || "").trim();
            if (!specStr || specStr.toLowerCase() === "not stated" || specStr.toLowerCase() === "null" || specStr.toLowerCase() === "none" || specStr === "--") {
                specStr = "No Spec / Unknown";
            }

            let containerKey = "";
            if (row.ContainerName && String(row.ContainerName).trim() !== "") {
                containerKey = String(row.ContainerName).trim();
            } else {
                containerKey = `${row.MfgOrderName || ''}_${row.TaskListName || ''}_${row.PlannedStartDate || ''}_${row.OrderQty || 0}`;
            }

            let uniqueChartKey = `${containerKey}_${specificLine}_${specStr}`;
            if (seenContainers.has(uniqueChartKey)) return; 
            
            seenContainers.add(uniqueChartKey);
            
            let qty = parseFloat(row.OrderQty) || parseFloat(row.Qty) || 0;

            if (!aggregatedData[specStr]) {
                aggregatedData[specStr] = { WH: 0, BB: 0, SI: 0 };
                specLineWOSet[specStr] = { WH: new Set(), BB: new Set(), SI: new Set() };
                specLineRows[specStr] = { WH: [], BB: [], SI: [] };
                specRows[specStr] = [];
            }

            if (isPNTab) {
                // In Second Tab (Part Number Mode), count unique Work Orders per Spec & Line
                const currentWO = row.MfgOrderName || row.mfgOrder || wo;
                specLineWOSet[specStr][specificLine].add(currentWO);
                aggregatedData[specStr][specificLine] = specLineWOSet[specStr][specificLine].size;
            } else {
                // In First Tab (Work Order Mode), sum total quantities
                aggregatedData[specStr][specificLine] += qty;
            }

            specLineRows[specStr][specificLine].push(row);
            specRows[specStr].push(row);
        });
    });

    const labels = Object.keys(aggregatedData).sort();
    if (labels.length === 0) {
        ctx.font = "13px Inter, sans-serif";
        ctx.fillStyle = "#888888";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No SpecName data available for selected Work Orders.", width / 2, height / 2);
        return;
    }

    const colorMap = {
        'WH': { bg: '#1890ff', border: '#096dd9' }, 
        'BB': { bg: '#52c41a', border: '#389e0d' },   
        'SI': { bg: '#722ed1', border: '#531dab' }  
    };

    if (currentChartType === 'bar') {
        let maxVal = 0;
        labels.forEach(spec => {
            activeLines.forEach(line => {
                if (aggregatedData[spec][line] > maxVal) maxVal = aggregatedData[spec][line];
            });
        });

        if (maxVal === 0) maxVal = 10;
        maxVal = Math.ceil(maxVal * 1.15);

        const padLeft = 45;
        const padRight = 15;
        const padTop = 20;
        const padBottom = 65; // Increased padding for rotated X-labels
        const chartWidth = width - padLeft - padRight;
        const chartHeight = height - padTop - padBottom;

        const gridSteps = 4;
        ctx.lineWidth = 1;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.font = "10px Inter, sans-serif";
        ctx.fillStyle = "#888888";

        for (let i = 0; i <= gridSteps; i++) {
            const val = Math.round((maxVal / gridSteps) * i);
            const y = padTop + chartHeight - (chartHeight / gridSteps) * i;

            ctx.strokeStyle = "#e8e8e8";
            ctx.beginPath();
            ctx.moveTo(padLeft, y);
            ctx.lineTo(width - padRight, y);
            ctx.stroke();

            ctx.fillText(val, padLeft - 6, y);
        }

        ctx.strokeStyle = "#cccccc";
        ctx.beginPath();
        ctx.moveTo(padLeft, padTop + chartHeight);
        ctx.lineTo(width - padRight, padTop + chartHeight);
        ctx.stroke();

        const groupWidth = chartWidth / labels.length;
        const numLines = activeLines.length;
        const barWidth = Math.max(3, Math.min(22, (groupWidth * 0.7) / numLines));

        labels.forEach((spec, gIdx) => {
            const groupX = padLeft + gIdx * groupWidth + groupWidth / 2;
            const startX = groupX - (barWidth * numLines) / 2;

            activeLines.forEach((line, lIdx) => {
                const val = aggregatedData[spec][line] || 0;
                const barH = (val / maxVal) * chartHeight;
                const x = startX + lIdx * barWidth;
                const y = padTop + chartHeight - barH;

                if (val > 0) {
                    ctx.fillStyle = colorMap[line] ? colorMap[line].bg : '#1890ff';
                    ctx.fillRect(x, y, barWidth - 1, barH);

                    // Register Hitbox for Bar Click
                    canvas.__chartHitBoxes.push({
                        type: 'bar',
                        x: x,
                        y: y,
                        width: barWidth - 1,
                        height: barH,
                        spec: spec,
                        line: line,
                        val: val,
                        rows: specLineRows[spec][line] || []
                    });

                    if (val > 0) {
                        ctx.fillStyle = "#1e293b";
                        ctx.font = barWidth < 8 ? "bold 8px Inter, sans-serif" : "bold 9px Inter, sans-serif";
                        ctx.textAlign = "center";
                        ctx.textBaseline = "bottom";
                        ctx.fillText(val, x + (barWidth - 1) / 2, y - 1);
                    }
                }
            });

            // 🎯 Rotated X-axis label (-30 deg slant) with smaller 9px font
            ctx.save();
            ctx.translate(groupX, padTop + chartHeight + 8);
            ctx.rotate(-Math.PI / 6);
            ctx.fillStyle = "#555";
            ctx.font = "9px Inter, sans-serif";
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            let displayLabel = spec.length > 15 ? spec.substring(0, 14) + "…" : spec;
            ctx.fillText(displayLabel, 0, 0);
            ctx.restore();
        });

        let legendX = width / 2 - (activeLines.length * 50) / 2;
        const legendY = height - 12;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.font = "11px Inter, sans-serif";

        activeLines.forEach((line) => {
            if (!colorMap[line]) return;
            ctx.fillStyle = colorMap[line].bg;
            ctx.fillRect(legendX, legendY - 5, 12, 10);
            ctx.fillStyle = "#333";
            ctx.fillText(line, legendX + 16, legendY);
            legendX += 60;
        });

    } else if (currentChartType === 'pie') {
        let pieTotals = [];
        let grandTotal = 0;

        labels.forEach(spec => {
            let total = 0;
            activeLines.forEach(line => {
                total += aggregatedData[spec][line] || 0;
            });
            if (total > 0) {
                pieTotals.push({ label: spec, value: total, rows: specRows[spec] || [] });
                grandTotal += total;
            }
        });

        if (grandTotal === 0) {
            ctx.font = "13px Inter, sans-serif";
            ctx.fillStyle = "#888888";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("No data matching filters to display Pie Chart.", width / 2, height / 2);
            return;
        }

        const pieColors = [
            '#1890ff', '#52c41a', '#722ed1', '#fa8c16', '#eb2f96', 
            '#13c2c2', '#fadb14', '#fa541c', '#2f54eb', '#a0d911'
        ];

        const centerX = width / 2;
        const centerY = (height - 30) / 2;
        const radius = Math.min(centerX, centerY) - 20;

        let startAngle = -Math.PI / 2;

        pieTotals.forEach((item, idx) => {
            const sliceAngle = (item.value / grandTotal) * (2 * Math.PI);
            const endAngle = startAngle + sliceAngle;
            const color = pieColors[idx % pieColors.length];
            const pct = Math.round((item.value / grandTotal) * 100);

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.arc(centerX, centerY, radius, startAngle, endAngle);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Register Hitbox for Pie Slice Click
            canvas.__chartHitBoxes.push({
                type: 'pie',
                centerX: centerX,
                centerY: centerY,
                radius: radius,
                startAngle: startAngle,
                endAngle: endAngle,
                spec: item.label,
                line: 'All Lines',
                val: item.value,
                pct: pct,
                rows: item.rows
            });

            if (pct >= 5) {
                const midAngle = startAngle + sliceAngle / 2;
                const labelX = centerX + Math.cos(midAngle) * (radius * 0.65);
                const labelY = centerY + Math.sin(midAngle) * (radius * 0.65);

                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 11px Inter, sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(`${pct}%`, labelX, labelY);
            }

            startAngle = endAngle;
        });

        let legendX = 20;
        const legendY = height - 12;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.font = "10px Inter, sans-serif";

        pieTotals.slice(0, 5).forEach((item, idx) => {
            const color = pieColors[idx % pieColors.length];
            ctx.fillStyle = color;
            ctx.fillRect(legendX, legendY - 4, 10, 8);
            ctx.fillStyle = "#333";
            let lbl = item.label.length > 8 ? item.label.substring(0, 7) + "…" : item.label;
            ctx.fillText(`${lbl} (${item.value})`, legendX + 13, legendY);
            legendX += 70;
        });
    }
}

// 🎯 Canvas Hit Test Helper
function findChartHit(canvas, mx, my) {
    if (!canvas.__chartHitBoxes) return null;
    for (let hit of canvas.__chartHitBoxes) {
        if (hit.type === 'bar') {
            if (mx >= hit.x && mx <= hit.x + hit.width && my >= hit.y && my <= hit.y + hit.height) {
                return hit;
            }
        } else if (hit.type === 'pie') {
            const dx = mx - hit.centerX;
            const dy = my - hit.centerY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist <= hit.radius) {
                let angle = Math.atan2(dy, dx);
                let start = hit.startAngle;
                let end = hit.endAngle;
                if (angle < start) angle += 2 * Math.PI;
                if (angle >= start && angle <= end) return hit;
            }
        }
    }
    return null;
}

// 🎯 Open Detail Breakdown Modal on Chart Click with Smooth Animation
function openChartModal(hit) {
    const modal = document.getElementById('chartDetailModal');
    if (!modal) return;

    const unitLabel = currentSearchMode === 'pn' ? 'WOs' : 'pcs';
    document.getElementById('chartModalSpec').innerText = hit.spec || '-';
    document.getElementById('chartModalLine').innerText = hit.line || 'All Lines';
    document.getElementById('chartModalQty').innerText = hit.pct ? `${hit.val} ${unitLabel} (${hit.pct}%)` : `${hit.val} ${unitLabel}`;
    document.getElementById('chartModalRecordCount').innerText = hit.rows ? hit.rows.length : 0;

    const tbody = document.getElementById('chartModalTableBody');
    if (tbody) {
        let html = '';
        if (hit.rows && hit.rows.length > 0) {
            hit.rows.forEach((r, idx) => {
                // TopMFG = TopMfgOrderName from the GetWoDetailedStatusQuery API
                // (the bundle / parent order link). Fall back to the father order.
                const topMfg = r.TopMfgOrderName || r.FatherMfgOrderName || '-';
                const traveler = r.TravelerCard || r.TraverlerCard || r.ContainerName || '-';
                const orderQty = (r.OrderQty !== undefined && r.OrderQty !== null) ? r.OrderQty : 0;
                const esc = escapeHtml;
                html += `
                    <tr class="chart-detail-row" style="--row-idx: ${idx};">
                        <td class="chart-detail-key" title="${esc(String(topMfg))}">${esc(String(topMfg))}</td>
                        <td class="chart-detail-wo" title="${esc(String(r.MfgOrderName || '-'))}">${esc(String(r.MfgOrderName || '-'))}</td>
                        <td>
                            <span class="chart-detail-line-badge">${esc(String(r.MfgLineName || '-'))}</span>
                        </td>
                        <td class="chart-detail-traveler" title="${esc(String(traveler))}">${esc(String(traveler))}</td>
                        <td class="chart-detail-pn" title="${esc(String(r.ProductName || '-'))}">${esc(String(r.ProductName || '-'))}</td>
                        <td class="chart-detail-task" title="${esc(String(r.TaskListName || '-'))}">${esc(String(r.TaskListName || '-'))}</td>
                        <td class="chart-detail-qty">${esc(String(orderQty))}</td>
                    </tr>
                `;
            });
        } else {
            html = `<tr><td colspan="7" class="chart-detail-empty">No detailed container records found for this segment.</td></tr>`;
        }
        tbody.innerHTML = html;
    }

    // Display flex and trigger smooth entry animation
    modal.classList.remove('chart-modal-closing');
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            modal.classList.add('chart-modal-open');
        });
    });
}

function closeChartModal() {
    const modal = document.getElementById('chartDetailModal');
    if (!modal || modal.classList.contains('chart-modal-closing')) return;

    modal.classList.remove('chart-modal-open');
    modal.classList.add('chart-modal-closing');

    setTimeout(() => {
        modal.style.display = 'none';
        modal.classList.remove('chart-modal-closing');
    }, 280);
}

// Add Escape key handler for closing the breakdown modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('chartDetailModal');
        if (modal && (modal.style.display === 'flex' || modal.classList.contains('chart-modal-open'))) {
            closeChartModal();
        }
    }
});

function copyRawData() {
    let selectedWOs = Array.from(document.querySelectorAll('.summary-checkbox:checked')).map(cb => cb.value);
    if (selectedWOs.length === 0) {
        selectedWOs = Array.from(document.querySelectorAll('.urgent-checkbox:checked')).map(cb => cb.value);
    }
    if (selectedWOs.length === 0) return alert("Please select at least one Work Order in the table on the left to copy.");

    // Filter strictly by the currently active lines selected in WO Detailed Status (e.g. WH, BB, SI)
    const targetLines = (Array.isArray(activeLines) && activeLines.length > 0) ? activeLines : ['WH', 'BB', 'SI'];

    let excelData = colKeys.join("\t") + "\n";
    let rowCount = 0;

    selectedWOs.forEach(wo => {
        const data = globalDataCache[wo] || [];
        data.forEach(row => {
            const matches = targetLines.some(line => rowMatchesLine(row, line));
            if (!matches) return;

            const rowData = colKeys.map(key => {
                let val = row[key];
                return val !== undefined && val !== null ? String(val).trim() : "";
            });
            excelData += rowData.join("\t") + "\n";
            rowCount++;
        });
    });

    if (rowCount === 0) return alert(`No data available to copy for the selected Work Order(s) under line filter (${targetLines.join(', ')}).`);

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(excelData).then(() => {
            alert(`Copied ${rowCount} container records (${targetLines.join(', ')}) to clipboard!`);
        }).catch(err => {
            alert("Failed to copy to clipboard.");
        });
    } else {
        try {
            const textArea = document.createElement("textarea");
            textArea.value = excelData;
            textArea.style.position = "fixed";
            textArea.style.left = "-999999px";
            textArea.style.top = "-999999px";
            
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            
            if (successful) alert(`Copied ${rowCount} container records (${targetLines.join(', ')}) to clipboard!`);
            else alert("Browser blocked clipboard access.");
        } catch (err) {
            console.error("Fallback copy failed", err);
            alert("Failed execution. Your browser blocked the copy action.");
        }
    }
}

function exportRawData() {
    let selectedWOs = Array.from(document.querySelectorAll('.summary-checkbox:checked')).map(cb => cb.value);
    if (selectedWOs.length === 0) {
        selectedWOs = Array.from(document.querySelectorAll('.urgent-checkbox:checked')).map(cb => cb.value);
    }
    if (selectedWOs.length === 0) return alert("Please select at least one Work Order in the table on the left to export.");

    // Filter strictly by the currently active lines selected in WO Detailed Status (e.g. WH, BB, SI)
    const targetLines = (Array.isArray(activeLines) && activeLines.length > 0) ? activeLines : ['WH', 'BB', 'SI'];

    let exportData = [];
    
    selectedWOs.forEach(wo => {
        const data = globalDataCache[wo] || [];
        data.forEach(row => {
            const matches = targetLines.some(line => rowMatchesLine(row, line));
            if (!matches) return;

            let newRow = {};
            colKeys.forEach(key => {
                let val = row[key];
                newRow[key] = val !== undefined && val !== null ? String(val).trim() : "";
            });
            exportData.push(newRow);
        });
    });

    if (exportData.length === 0) return alert(`No data available to export for the selected Work Order(s) under line filter (${targetLines.join(', ')}).`);

    const today = new Date().toISOString().split('T')[0];
    const lineTag = targetLines.join('_');
    const fileName = `BizLink_WO_Detailed_Status_${lineTag}_${today}.xlsx`;
    exportToExcel(exportData, "WO Detailed Status", fileName, colKeys);
}

async function exportToExcel(data, sheetName = "Data", defaultFilename = "BizLink_Export.xlsx", headers = null, isEthanTask = false, woHistoryData = null) {
    if (!data || data.length === 0) {
        alert("No data available to export.");
        return;
    }

    const fileName = defaultFilename.endsWith('.xlsx') ? defaultFilename : `${defaultFilename}.xlsx`;

    try {
        if (typeof XLSX !== 'undefined') {
            let worksheet;
            if (Array.isArray(data[0])) {
                worksheet = XLSX.utils.aoa_to_sheet(data);
            } else {
                worksheet = XLSX.utils.json_to_sheet(data, headers ? { header: headers } : undefined);
            }

            function isTaskPackingWithEndTime(row) {
                const taskStr = String(row["Task"] || row["TaskListName"] || "").toUpperCase();
                const endTime = String(row["End Time"] || row["EndTime"] || "").trim();
                const hasEndTime = endTime !== "" && endTime !== "null" && endTime !== "undefined" && endTime !== "--" && endTime !== "#N/A";
                return taskStr.includes("PACKING") && hasEndTime;
            }

            function getWoTargetRows(dataset) {
                const targetRowNums = new Set();
                dataset.forEach((r, idx) => {
                    if (isTaskPackingWithEndTime(r)) {
                        targetRowNums.add(idx + 2);
                    }
                });
                return targetRowNums;
            }

            if (isEthanTask) {
                const maxDataRow = data.length + 1;
                worksheet['!rows'] = [];
                for (let r = 0; r < maxDataRow; r++) {
                    worksheet['!rows'][r] = {};
                }
                const targetRowsData = getWoTargetRows(data);

                // Populate formula and values for Column R (Actual CT) and Column S (Standard CT) in Raw Data sheet
                data.forEach((row, idx) => {
                    const rowNum = idx + 2; // Row 1 is header, data starts at Row 2
                    const orderQty = parseFloat(row["Order Qty"]) || 0;
                    const unitCt = parseFloat(row["Unit CT"]) || 0;
                    const lotQty = parseFloat(row["Lot Qty"]) || 1;
                    const procTime = parseFloat(row["Processing Time"]) || 0;
                    const isTarget = targetRowsData.has(rowNum);

                    // Explicitly force NUMERIC types for Excel/LibreOffice Calc
                    worksheet[`E${rowNum}`] = { t: 'n', v: lotQty };
                    worksheet[`F${rowNum}`] = { t: 'n', v: orderQty };
                    worksheet[`O${rowNum}`] = { t: 'n', v: procTime };
                    worksheet[`Q${rowNum}`] = { t: 'n', v: unitCt };

                    if (isTarget) {
                        const wo = String(row["Work Order"] || "").trim();
                        const woRows = data.filter(r => String(r["Work Order"] || "").trim() === wo);
                        const totalActualCt = (woRows.reduce((sum, r) => sum + (parseFloat(r["Processing Time"]) || 0), 0)) / 60.0;
                        const singleStdCt = (unitCt * orderQty) / 60.0;

                        worksheet[`R${rowNum}`] = {
                            t: 'n',
                            v: Math.round(totalActualCt * 10000) / 10000,
                            f: `=SUMIF($A$2:$A$${maxDataRow}, A${rowNum}, $O$2:$O$${maxDataRow})/60`
                        };

                        worksheet[`S${rowNum}`] = {
                            t: 'n',
                            v: Math.round(singleStdCt * 10000) / 10000,
                            f: `=(Q${rowNum}*F${rowNum})/60`
                        };
                    } else {
                        worksheet[`R${rowNum}`] = { t: 's', v: '' };
                        worksheet[`S${rowNum}`] = { t: 's', v: '' };
                        // Hide non-matching rows by default!
                        worksheet['!rows'][rowNum - 1] = { hidden: true };
                    }
                });
                
                // Add AutoFilter across headers
                const lastCol = XLSX.utils.encode_col((headers ? headers.length : 24) - 1);
                worksheet['!autofilter'] = { ref: `A1:${lastCol}${maxDataRow}` };
            }

            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, sheetName); // "Raw Data"

            if (isEthanTask) {
                const packingDataRows = data.filter(r => isTaskPackingWithEndTime(r));
                const distinctWOs = [...new Set(packingDataRows.map(r => String(r["Work Order"] || "").trim()).filter(Boolean))];
                const pivotRows = [
                    ["Work Order", "Standard CT", "Actual CT", "Total Order Qty", "Record Count"]
                ];

                distinctWOs.forEach((wo, pIdx) => {
                    const rowNum = pIdx + 2;
                    const woRows = data.filter(r => String(r["Work Order"] || "").trim() === wo);
                    const targetRow = woRows.find(r => isTaskPackingWithEndTime(r)) || woRows[0] || {};
                    const targetUct = parseFloat(targetRow["Unit CT"]) || 0;
                    const targetOqty = parseFloat(targetRow["Order Qty"]) || 0;
                    const woStdCt = (targetUct * targetOqty) / 60.0;
                    const woActualCt = (woRows.reduce((acc, r) => acc + (parseFloat(r["Processing Time"]) || 0), 0)) / 60.0;
                    const woSingleQty = woRows.length > 0 ? (parseFloat(woRows[0]["Order Qty"]) || 0) : 0;

                    pivotRows.push([
                        wo,
                        { t: 'n', v: Math.round(woStdCt * 10000) / 10000, f: `=SUMIF('Raw Data'!$A$2:$A$${maxDataRow}, A${rowNum}, 'Raw Data'!$S$2:$S$${maxDataRow})` },
                        { t: 'n', v: Math.round(woActualCt * 10000) / 10000, f: `=SUMIF('Raw Data'!$A$2:$A$${maxDataRow}, A${rowNum}, 'Raw Data'!$R$2:$R$${maxDataRow})` },
                        { t: 'n', v: woSingleQty, f: `=VLOOKUP(A${rowNum}, 'Raw Data'!$A$2:$F$${maxDataRow}, 6, 0)` },
                        { t: 'n', v: woRows.length, f: `=COUNTIF('Raw Data'!$A$2:$A$${maxDataRow}, A${rowNum})` }
                    ]);
                });

                if (distinctWOs.length > 0) {
                    const totRow = distinctWOs.length + 2;
                    pivotRows.push([
                        "Total",
                        { f: `=SUM(B2:B${totRow - 1})` },
                        { f: `=SUM(C2:C${totRow - 1})` },
                        { f: `=SUM(D2:D${totRow - 1})` },
                        { f: `=SUM(E2:E${totRow - 1})` }
                    ]);
                }

                const pivotSheet = XLSX.utils.aoa_to_sheet(pivotRows);
                XLSX.utils.book_append_sheet(workbook, pivotSheet, "PivotTable1");
            }

            const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
            const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                a.remove();
                window.URL.revokeObjectURL(url);
            }, 1000);
            return;
        }
    } catch (err) {
        console.warn("[exportToExcel] Client SheetJS export failed, trying server-side XLSX export:", err);
    }

    // Backend OpenPyXL Server-side XLSX Fallback
    try {
        const res = await fetch(`${BASE_HOST}/api/export-excel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                records: data,
                headers: headers,
                filename: fileName,
                sheet_name: sheetName,
                is_ethan_task: isEthanTask,
                wo_history_records: woHistoryData
            })
        });
        if (!res.ok) throw new Error('Server export failed');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            a.remove();
            window.URL.revokeObjectURL(url);
        }, 1000);
    } catch (err) {
        console.error("[exportToExcel] Server-side XLSX export error:", err);
        alert("Unable to generate XLSX file.");
    }
}

// 🚨 NEW: Dynamic Manpower Calculator Functions (With Achievable Logic & Split Shift Inputs)
function addManpowerRow() {
    const tbody = document.getElementById('manpowerTableBody');
    const tr = document.createElement('tr');
    const rowId = 'mp-' + Date.now();
    tr.id = rowId;
    
    tr.innerHTML = `
        <td>
            <select class="datetime-input" style="width: 100%; box-sizing: border-box;" id="day-${rowId}">
                <option value="Monday">Monday</option>
                <option value="Tuesday">Tuesday</option>
                <option value="Wednesday">Wednesday</option>
                <option value="Thursday">Thursday</option>
                <option value="Friday">Friday</option>
                <option value="Saturday">Saturday</option>
                <option value="Sunday">Sunday</option>
            </select>
        </td>
        <td>
            <input type="number" class="datetime-input" style="width: 100%; box-sizing: border-box; text-align: center;" id="people-ot-${rowId}" placeholder="0" min="0" oninput="updateShiftLabel('${rowId}')">
        </td>
        <td>
            <input type="number" class="datetime-input" style="width: 100%; box-sizing: border-box; text-align: center;" id="people-noot-${rowId}" placeholder="0" min="0" oninput="updateShiftLabel('${rowId}')">
        </td>
        <td>
            <input type="text" class="datetime-input" style="width: 100%; box-sizing: border-box;" id="wo-${rowId}" placeholder="e.g. 4010745571" onchange="updateShiftLabel('${rowId}')">
        </td>
        <td style="font-weight: bold; color: #faad14; text-align: center;" id="rem-${rowId}">-- hrs</td>
        <td style="font-weight: bold; text-align: center; font-size: 14px;" id="achieve-${rowId}">--</td>
        <td style="text-align: center;">
            <button class="btn-primary" style="background-color: #52c41a; font-size: 11px;" onclick="calculateManpower('${rowId}')">Calculate</button>
            <button class="btn-primary btn-danger" style="font-size: 11px; margin-left: 5px;" onclick="removeManpowerRow('${rowId}')">✖</button>
        </td>
    `;
    tbody.appendChild(tr);
}

function removeManpowerRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) row.remove();
}

async function calculateManpower(rowId) {
    const woInput = document.getElementById(`wo-${rowId}`).value;
    const wos = woInput.split(/[\s,\.]+/).map(w => w.trim()).filter(w => w !== "");
    
    if (wos.length === 0) return alert("Please enter at least one WO.");
    
    const peopleOTInput = document.getElementById(`people-ot-${rowId}`).value;
    const peopleNoOTInput = document.getElementById(`people-noot-${rowId}`).value;
    
    const numPeopleOT = parseFloat(peopleOTInput) || 0; 
    const numPeopleNoOT = parseFloat(peopleNoOTInput) || 0; 
    
    const remCell = document.getElementById(`rem-${rowId}`);
    const achieveCell = document.getElementById(`achieve-${rowId}`);
    
    remCell.innerText = "Calc...";
    remCell.style.color = "#faad14";
    achieveCell.innerText = "⏳";

    let totalRemainingMinutes = 0;

    for (let wo of wos) {
        try {
            let data = globalDataCache[wo];
            if (!data) {
                const response = await fetch(MES_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ "mfgOrder": wo })
                });
                if (response.ok) {
                    const resJson = await response.json();
                    data = resJson.RTDAT || [];
                    globalDataCache[wo] = data; 
                } else {
                    data = [];
                }
            }
            
            data.forEach(row => {
                let matchesLine = activeLines.some(line => row.MfgLineName && String(row.MfgLineName).includes(line));
                
                if (matchesLine) {
                    let isCompleted = false;
                    if (row.ContainerStatus && String(row.ContainerStatus).toLowerCase().includes('completed')) {
                        isCompleted = true;
                    } else if (row.SpecName && String(row.SpecName).includes('Line WH')) {
                        isCompleted = true;
                    }
                    
                    if (!isCompleted) {
                        let orderQty = parseFloat(row.OrderQty) || 0;
                        let manTime = parseFloat(row.ManTime) || 0;
                        totalRemainingMinutes += (orderQty * manTime);
                    }
                }
            });
        } catch (err) {
            console.error(`Failed to fetch ${wo}`, err);
        }
    }
    
    let totalRemainingHours = totalRemainingMinutes / 60;
    
    remCell.innerText = totalRemainingHours.toFixed(2) + " hrs";
    remCell.style.color = "#001529";
    
    // 🚨 Calculate total capacity mixing OT and No-OT hours
    let totalCapacity = (numPeopleOT * 10) + (numPeopleNoOT * 8);
    
    // Logic to decide if it gets a Green Tick or Red Cross
    if (totalRemainingHours === 0) {
        achieveCell.innerHTML = `<span style="color: #52c41a;">✅ Done</span>`;
    } else if (totalCapacity >= totalRemainingHours) {
        achieveCell.innerHTML = `<span style="color: #52c41a;">✅ Yes (${totalCapacity}h)</span>`;
    } else {
        achieveCell.innerHTML = `<span style="color: #ff4d4f;">❌ No (${totalCapacity}h)</span>`;
    }
}

function updateShiftLabel(rowId) {
    const remCell = document.getElementById(`rem-${rowId}`);
    if (remCell.innerText !== "-- hrs" && remCell.innerText !== "Calc...") {
        calculateManpower(rowId);
    }
}

function stopProcessing() {
    abortExport = true;
    showStatus("Halting process and compiling safe data...", "orange");
}

function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function formatDateForAPI(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function fetchFromAPI(token, startStr, endStr, woArray) {
    let timeArray = [];
    if (startStr && endStr) {
        timeArray = [startStr, endStr];
    }

    const payload = {
        "SpecName": "",
        "EmployeeName": "", 
        "IsTiming": "0", 
        "StartTimeArray": timeArray,
        "MfgLineName": "", 
        "ProductName": "", 
        "TaskName": "", 
        "WorkOrder": "", 
        "WorkOrderArray": woArray || [] 
    };
    
    const response = await fetch('/api/task-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': token },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server status ${response.status}`);
    }
    return await response.json();
}

async function processChunk(token, startMs, endMs, stepIndex, woArray, retryCount = 0) {
    if (startMs > endMs || abortExport) return [];

    const startStr = formatDateForAPI(new Date(startMs));
    const endStr = formatDateForAPI(new Date(endMs));
    
    try {
        showStatus(`Fetching chunk: ${startStr.split(' ')[1]} to ${endStr.split(' ')[1]}...`, "orange");
        await delay(200);
        const data = await fetchFromAPI(token, startStr, endStr, woArray);

        if (Array.isArray(data) && data.length >= 3000) {
            throw new Error(`Silent cap detected (${data.length} rows). Slicing deeper to guarantee zero data loss.`);
        }

        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.warn(`Chunk failed (${startStr} - ${endStr}):`, error.message);
        
        const isSilentCap = String(error.message || "").includes("Silent cap detected");

        // If not a data cap overload, attempt up to 2 retries at the current chunk size
        if (!isSilentCap && retryCount < 2 && !abortExport) {
            console.log(`Retrying chunk (${retryCount + 1}/2) after pause...`);
            await delay(1000);
            return await processChunk(token, startMs, endMs, stepIndex, woArray, retryCount + 1);
        }

        // Only slice into smaller time intervals if we hit the 3000-row silent cap overload
        if (isSilentCap && stepIndex + 1 < FALLBACK_STEPS_SEC.length) {
            const nextSec = FALLBACK_STEPS_SEC[stepIndex + 1];
            const nextMs = nextSec * 1000; 
            
            const timeLabel = nextSec >= 3600 ? `${nextSec / 3600}-hour` : (nextSec >= 60 ? `${nextSec / 60}-minute` : `${nextSec}-second`);
            showStatus(`Overload detected (${startStr.split(' ')[1]} to ${endStr.split(' ')[1]}). Pausing, then slicing into ${timeLabel} chunks...`, "orange");
            
            await delay(1500);
            
            let chunkResults = [];
            for (let cur = startMs; cur <= endMs; cur += nextMs) {
                if (abortExport) break;
                let next = Math.min(cur + nextMs - 1000, endMs);
                if (next < cur) next = cur; 
                
                const subData = await processChunk(token, cur, next, stepIndex + 1, woArray, 0);
                if (abortExport) break; 
                chunkResults = chunkResults.concat(subData);
            }
            return chunkResults;
        } else {
            if (!isSilentCap) {
                showStatus(`Connection/Server hiccup at ${startStr.split(' ')[1]}. Skipping failed segment.`, "orange");
            }
            return []; 
        }
    }
}

async function fetchAndProcess(action) {
    abortExport = false; 
    const token = document.getElementById('authToken').value.trim();
    const useDateFilter = document.getElementById('useDateFilter').checked;
    
    const woInput = document.getElementById('taskWoInput').value.trim();
    const woArray = woInput ? woInput.split(/[\s,\.]+/).map(w => w.trim()).filter(w => w !== "") : [];
    
    const startDate = document.getElementById('startDate').value;
    const startTime = document.getElementById('startTime').value;
    const endDate = document.getElementById('endDate').value;
    const endTime = document.getElementById('endTime').value;
    
    const statusDiv = document.getElementById('statusMessage');
    const dlBtn = document.getElementById('downloadBtn');
    const copyBtn = document.getElementById('copyTaskBtn');
    const stopBtn = document.getElementById('stopProcessBtn');

    statusDiv.innerText = "";
    statusDiv.style.backgroundColor = "transparent";

    if (!token) { showStatus("Please login first.", "red"); return; }
    
    if (!useDateFilter && woArray.length === 0) {
        showStatus("Error: You must enter at least one Work Order if you disable the Date Filter!", "red"); 
        return;
    }

    let startMs, endMs;
    if (useDateFilter) {
        if (!startDate || !startTime || !endDate || !endTime) { 
            showStatus("All date/time fields required when Date Filter is on.", "red"); 
            return; 
        }
        const formStart = startTime.length === 5 ? `${startTime}:00` : startTime;
        const formEnd = endTime.length === 5 ? `${endTime}:00` : endTime;
        startMs = new Date(`${startDate}T${formStart}`).getTime();
        endMs = new Date(`${endDate}T${formEnd}`).getTime();
        if (startMs >= endMs) { showStatus("End time must be after start time.", "red"); return; }
    }

    try {
        dlBtn.style.display = 'none';
        copyBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        
        let allData = [];
        let completedUpToMs = startMs; 

        if (!useDateFilter) {
            showStatus(`Fetching full lifetime history for ${woArray.length} Work Order(s)...`, "orange");
            const realStart = "";
            const realEnd = "";
            
            for (let wo of woArray) {
                if (abortExport) break;
                showStatus(`Pulling full history for WO: ${wo}...`, "orange");
                await delay(300); 
                try {
                    const data = await fetchFromAPI(token, realStart, realEnd, [wo]);
                    if (abortExport) break;
                    if (Array.isArray(data)) allData = allData.concat(data);
                } catch (err) {
                    console.warn(`Failed to fetch WO ${wo}`, err);
                }
            }
            if (abortExport) {
                showStatus(`Process stopped. Formatting completely fetched Work Orders...`, "orange");
            }
        } else {
            const INITIAL_STEP_INDEX = 0; 
            const initialIntervalMs = FALLBACK_STEPS_SEC[INITIAL_STEP_INDEX] * 1000;

            for (let cur = startMs; cur <= endMs; cur += initialIntervalMs) {
                if (abortExport) break;
                let next = Math.min(cur + initialIntervalMs - 1000, endMs);
                if (next < cur) next = cur; 

                const chunkData = await processChunk(token, cur, next, INITIAL_STEP_INDEX, woArray);
                
                if (abortExport) break; 
                allData = allData.concat(chunkData);
                completedUpToMs = next + 1000; 
            }

            if (abortExport) {
                let processedMs = completedUpToMs - startMs;
                let processedDays = Math.floor(processedMs / (24 * 60 * 60 * 1000));
                
                if (processedDays >= 1) {
                    showStatus(`Process stopped. Formatting the first ${processedDays} fully completed day(s)...`, "orange");
                    let cutoffMs = startMs + (processedDays * 24 * 60 * 60 * 1000);
                    allData = allData.filter(row => {
                        let t = new Date(row.StartTime ? row.StartTime.replace(' ', 'T') : 0).getTime();
                        return t < cutoffMs;
                    });
                } else {
                    showStatus(`Process stopped. 24 hours not fully completed. No data generated.`, "red");
                    return; 
                }
            }
        }

        // 🚨 NEW: Filter allData by the base line and/or checked Mfg Lines before doing the "0 records" check!
        const includeAllLines = document.getElementById('includeAllLines').checked;
        const baseLineSelectEl = document.getElementById('baseMfgLineSelect');
        const baseMfgLine = baseLineSelectEl ? baseLineSelectEl.value : '3070';
        const selectedLines = Array.from(document.querySelectorAll('.mfg-line-filter:checked')).map(cb => cb.value);

        console.log(`[Task Exporter] Filtering data. Total records fetched: ${allData.length}`);
        console.log(`[Task Exporter] Parameters - includeAllLines: ${includeAllLines}, baseMfgLine: "${baseMfgLine}", selectedLines:`, selectedLines);

        if (includeAllLines) {
            // "Fetch All Lines" is checked - filter strictly by rows belonging ONLY to the selected base line prefix (e.g. '3070' or '3060') and exclude the other completely.
            allData = allData.filter(row => {
                if (!row.MfgLineName) return false;
                const lineName = String(row.MfgLineName).trim();
                
                if (baseMfgLine === 'ALL') {
                    return lineName.includes('3060') || lineName.includes('3070');
                } else {
                    // Strict check: if baseMfgLine is "3060", lineName MUST contain "3060", and MUST NOT contain "3070"!
                    // If baseMfgLine is "3070", lineName MUST contain "3070", and MUST NOT contain "3060"!
                    const targetMatch = lineName.includes(baseMfgLine);
                    const otherLine = baseMfgLine === '3070' ? '3060' : '3070';
                    const otherMatch = lineName.includes(otherLine);
                    return targetMatch && !otherMatch;
                }
            });
        } else {
            // "Fetch All Lines" is unchecked - filter strictly by the specific checked checkboxes
            allData = allData.filter(row => {
                if (!row.MfgLineName) return false;
                const lineName = String(row.MfgLineName);
                return selectedLines.some(line => lineName.includes(line));
            });
        }
        
        // 👔 Check if Ethan's Task mode is selected
        const isEthanTask = document.getElementById('ethanTaskRadio') && document.getElementById('ethanTaskRadio').checked;

        if (isEthanTask) {
            allData = allData.filter(row => {
                // End Time Filter: exclude rows where End Time is blank / empty
                const endTime = String(row.EndTime !== undefined && row.EndTime !== null ? row.EndTime : "").trim();
                if (!endTime || endTime === "null" || endTime === "undefined" || endTime === "--" || endTime === "#N/A") {
                    return false;
                }
                return true;
            });
        }
        
        console.log(`[Task Exporter] Filtering completed. Total records after filter: ${allData.length}`);

        if (allData.length === 0) {
            showStatus(`Query finished. 0 records found for selected filters.`, "orange");
            return;
        }

        if (!abortExport) showStatus(`Sorting and Mapping ${allData.length} records...`, "orange");

        allData.sort((a, b) => {
            const timeA = new Date(a.StartTime ? a.StartTime.replace(' ', 'T') : 0).getTime();
            const timeB = new Date(b.StartTime ? b.StartTime.replace(' ', 'T') : 0).getTime();
            return timeA - timeB;
        });

        const keyMapStandard = {
            "Work Order": "MfgOrderName",
            "Mfg Line": "MfgLineName",
            "Traveler Card": "TravelerCard", 
            "Container": "ContainerName",
            "Lot Qty": "Qty", 
            "Order Qty": "OrderQty",
            "Spec": "SpecName",
            "Task": "TaskListName",
            "JobFlag": "JobFlag", 
            "Employee": "EmployeeName",
            "FullName": "FullName",
            "Start time": "StartTime",
            "Pause Time": "PauseTime",
            "End Time": "EndTime",
            "Processing Time": "ProcessingTime",
            "Workstation": "ResourceName", 
            "Unit CT": "UnitCT",
            "Product": "ProductName",
            "Product Des": "ProductDes",
            "Serial Number": "ES_PrimarySerialNumber",
            "CoWorker": "CoWorker",
            "CoResource": "CoResource"
        };

        const keyMapEthan = {
            "Work Order": "MfgOrderName",
            "Mfg Line": "MfgLineName",
            "Traveler Card": "TravelerCard", 
            "Container": "ContainerName",
            "Lot Qty": "Qty", 
            "Order Qty": "OrderQty",
            "Spec": "SpecName",
            "Task": "TaskListName",
            "JobFlag": "JobFlag", 
            "Employee": "EmployeeName",
            "FullName": "FullName",
            "Start time": "StartTime",
            "Pause Time": "PauseTime",
            "End Time": "EndTime",
            "Processing Time": "ProcessingTime",
            "Workstation": "ResourceName", 
            "Unit CT": "UnitCT",
            "Actual CT": "Actual CT",     // Column R
            "Standard CT": "Standard CT", // Column S
            "Product": "ProductName",
            "Product Des": "ProductDes",
            "Serial Number": "ES_PrimarySerialNumber",
            "CoWorker": "CoWorker",
            "CoResource": "CoResource"
        };

        const activeKeyMap = isEthanTask ? keyMapEthan : keyMapStandard;

        const mappedData = allData.map(row => {
            let newRow = {};
            let safeTraveler = row["TravelerCard"] || row["TraverlerCard"] || ""; 

            for (const [humanKey, dbKey] of Object.entries(activeKeyMap)) {
                if (humanKey === "Traveler Card") {
                    newRow[humanKey] = safeTraveler;
                } else if (humanKey === "Actual CT" || humanKey === "Standard CT") {
                    newRow[humanKey] = ""; // Generated as Excel formulas in exportToExcel / openpyxl
                } else {
                    newRow[humanKey] = row[dbKey] !== undefined && row[dbKey] !== null ? row[dbKey] : "";
                }
            }
            return newRow;
        });

        if (action === 'excel') {
            const sheetTabName = isEthanTask ? "Raw Data" : "Task Data";
            const exportFileName = isEthanTask ? "Ethan Task Report1.xlsx" : `BizLink_TaskReport_${Date.now()}.xlsx`;

            let finalDataToExport = mappedData;
            if (isEthanTask) {
                const packingRowsData = allData.filter(r => {
                    const taskStr = String(r.TaskListName || r.Task || r["Task"] || "").toUpperCase();
                    const endTime = String(r.EndTime || r["End Time"] || "").trim();
                    const hasEndTime = endTime !== "" && endTime !== "null" && endTime !== "undefined" && endTime !== "--" && endTime !== "#N/A";
                    return taskStr.includes("PACKING") && hasEndTime;
                });
                const uniqueWOs = [...new Set(packingRowsData.map(r => String(r.MfgOrderName || r["Work Order"] || "").trim()).filter(Boolean))];
                if (uniqueWOs.length > 0) {
                    showStatus(`Fetching full lifetime history for ${uniqueWOs.length} Work Order(s) with Task PACKING and End Time for Raw Data...`, "orange");
                    let fullHistData = [];
                    const batchSize = 20;
                    for (let i = 0; i < uniqueWOs.length; i += batchSize) {
                        if (abortExport) break;
                        const woBatch = uniqueWOs.slice(i, i + batchSize);
                        showStatus(`Fetching full history (${i + 1}-${Math.min(i + batchSize, uniqueWOs.length)} of ${uniqueWOs.length} WOs)...`, "orange");
                        await delay(200);
                        try {
                            const batchResult = await fetchFromAPI(token, "", "", woBatch);
                            if (Array.isArray(batchResult)) fullHistData = fullHistData.concat(batchResult);
                        } catch (err) {
                            console.warn(`Failed to fetch history for WOs`, err);
                        }
                    }

                    if (includeAllLines) {
                        fullHistData = fullHistData.filter(row => {
                            if (!row.MfgLineName) return false;
                            const lineName = String(row.MfgLineName).trim();
                            if (baseMfgLine === 'ALL') {
                                return lineName.includes('3060') || lineName.includes('3070');
                            } else {
                                const targetMatch = lineName.includes(baseMfgLine);
                                const otherLine = baseMfgLine === '3070' ? '3060' : '3070';
                                return targetMatch && !lineName.includes(otherLine);
                            }
                        });
                    } else if (selectedLines.length > 0) {
                        fullHistData = fullHistData.filter(row => {
                            if (!row.MfgLineName) return false;
                            const lineName = String(row.MfgLineName);
                            return selectedLines.some(line => lineName.includes(line));
                        });
                    }

                    fullHistData.sort((a, b) => {
                        const woA = String(a.MfgOrderName || a["Work Order"] || "").trim();
                        const woB = String(b.MfgOrderName || b["Work Order"] || "").trim();
                        if (woA !== woB) {
                            return woA.localeCompare(woB, undefined, { numeric: true, sensitivity: 'base' });
                        }
                        const timeA = new Date(a.StartTime ? a.StartTime.replace(' ', 'T') : 0).getTime();
                        const timeB = new Date(b.StartTime ? b.StartTime.replace(' ', 'T') : 0).getTime();
                        return timeA - timeB;
                    });

                    // Map fullHistData to keyMapEthan so Raw Data contains full lifetime history
                    finalDataToExport = fullHistData.map(row => {
                        let newRow = {};
                        let safeTraveler = row["TravelerCard"] || row["TraverlerCard"] || ""; 

                        for (const [humanKey, dbKey] of Object.entries(keyMapEthan)) {
                            if (humanKey === "Traveler Card") {
                                newRow[humanKey] = safeTraveler;
                            } else if (humanKey === "Actual CT" || humanKey === "Standard CT") {
                                newRow[humanKey] = ""; // Generated as Excel formulas in exportToExcel
                            } else {
                                newRow[humanKey] = row[dbKey] !== undefined && row[dbKey] !== null ? row[dbKey] : "";
                            }
                        }
                        return newRow;
                    });
                }
            }

            await exportToExcel(finalDataToExport, sheetTabName, exportFileName, Object.keys(activeKeyMap), isEthanTask);
            showStatus(`Excel successfully downloaded! (${finalDataToExport.length} rows in Raw Data)`, "green");
        } 
        else if (action === 'copy') {
            const headers = Object.keys(activeKeyMap);
            let clipboardString = headers.join("\t") + "\n";
            mappedData.forEach(row => {
                let rowVals = headers.map(h => row[h]);
                clipboardString += rowVals.join("\t") + "\n";
            });

            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(clipboardString);
            } else {
                const textArea = document.createElement("textarea");
                textArea.value = clipboardString;
                textArea.style.position = "fixed";
                textArea.style.left = "-999999px";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            showStatus(`Success! ${allData.length} records copied to clipboard.`, "green");
        }

    } catch (error) {
        console.error(error);
        showStatus(error.message, "red");
    } finally {
        dlBtn.style.display = 'block';
        copyBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        dlBtn.innerText = "📥 Generate & Download .XLSX";
        copyBtn.innerText = "📋 Copy Data to Clipboard";
    }
}

function showStatus(msg, color) {
    const el = document.getElementById('statusMessage');
    el.innerText = msg;
    el.style.color = "white";
    if (color === "red") el.style.backgroundColor = "#ff4d4f";
    if (color === "green") el.style.backgroundColor = "#52c41a";
    if (color === "orange") el.style.backgroundColor = "#faad14";
}

// ==========================================
// 5. SYNCHRONIZED HISTORY LOGGER
// ==========================================
async function flushHistoryQueue() {
    if (historyQueue.length === 0) return;
    const logsToSend = [...historyQueue];
    historyQueue = [];
    
    try {
        await fetch(`${NODE_BACKEND_URL}/api/history/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ logs: logsToSend })
        });
    } catch(e) {
        historyQueue.push(...logsToSend);
    }
}

async function getHistory() {
    let startVal = document.getElementById('histStart').value;
    let endVal = document.getElementById('histEnd').value;
    
    if(!startVal || !endVal) return alert("Please select both a Start and End Date/Time window.");

    const checkboxes = document.querySelectorAll('.urgent-checkbox:checked');
    if (checkboxes.length === 0) return alert("Select at least one checked Work Order context tracking node on the left.");
    
    const selectedWOs = Array.from(checkboxes).map(cb => cb.value);
    const currentPcts = {};
    selectedWOs.forEach(wo => {
        const pctCell = document.getElementById(`urgent-pct-${wo}`);
        currentPcts[wo] = pctCell ? (parseFloat(pctCell.innerText) || 0) : 0;
    });

    const tbody = document.getElementById("historyBody");
    tbody.innerHTML = "<tr><td colspan='4'>Calculating performance progression delta...</td></tr>";

    try {
        const response = await fetch(`${NODE_BACKEND_URL}/api/history/compare`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate: startVal, endDate: endVal, wos: selectedWOs, currentPcts: currentPcts })
        });
        
        const data = await response.json();
        tbody.innerHTML = "";

        if (data.length === 0) {
            tbody.innerHTML = "<tr><td colspan='4'>No productivity intervals captured inside specified query boundaries.</td></tr>";
            return;
        }

        let hasBaselines = false;
        data.forEach(row => {
            const tr = document.createElement("tr");
            const numericIncrease = parseFloat(row.increase.toFixed(2));
            const increaseColor = numericIncrease > 0 ? '#52c41a' : (numericIncrease < 0 ? 'red' : '#333');
            const sign = numericIncrease > 0 ? "+" : "";
            let displayWo = row.isBaseline ? `${row.wo_number}*` : row.wo_number;

            tr.innerHTML = `
                <td style="font-weight: bold; color: #1890ff;">${displayWo}</td>
                <td>${row.startPct.toFixed(2)}%</td>
                <td>${row.endPct.toFixed(2)}%</td>
                <td style="color: ${increaseColor}; font-weight: bold;">${sign}${numericIncrease.toFixed(2)}%</td>
            `;
            tbody.appendChild(tr);
        });

        if (hasBaselines) {
            const trNote = document.createElement("tr");
            trNote.innerHTML = `<td colspan="4" style="text-align:left; font-size: 11px; color: #888; background: #fdfdfd; padding: 10px;">
                * Work Order was added to the database AFTER your Start Date. Its earliest recorded data was used.
            </td>`;
            tbody.appendChild(trNote);
        }
    } catch(err) {
        tbody.innerHTML = "<tr><td colspan='4' style='color:red;'>Error fetching database historical logs.</td></tr>";
    }
}

// ==========================================
// 🚨 AI ASSISTANT CHATBOT LOGIC
// ==========================================

// --- State Memory Engine for Undo/Redo ---
function saveState() {
    undoStack.push({
        wos: [...urgentWOs],
        sort: currentSortMode
    });
    redoStack = []; 
}

async function applyState(state) {
    isDeletingWOs = true;
    let added = state.wos.filter(w => !urgentWOs.includes(w));
    let removed = urgentWOs.filter(w => !state.wos.includes(w));

    urgentWOs = [...state.wos];
    currentSortMode = state.sort;

    try {
        if (added.length > 0) {
            await fetch(`${NODE_BACKEND_URL}/api/urgent-wos/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wos: added, list_type: currentSearchMode }) }).catch(()=>{});
        }
        if (removed.length > 0) {
            await fetch(`${NODE_BACKEND_URL}/api/urgent-wos/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wos: removed, clear_all: window.urgentWOs.length === 0, list_type: currentSearchMode }) }).catch(()=>{});
        }

        await fetch(`${NODE_BACKEND_URL}/api/urgent-wos/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderedWOs: window.urgentWOs, list_type: currentSearchMode }) }).catch(()=>{});
    } finally {
        setTimeout(() => {
            isDeletingWOs = false;
            syncUrgentRack();
        }, 1000);
    }

    sortUrgentWOs();
}

function toggleChatbot() {
    const win = document.getElementById('chatbot-window');
    // Flip between hidden and visible (flex allows the chat layout to work)
    if (win.style.display === 'none' || win.style.display === '') {
        win.style.display = 'flex';
    } else {
        win.style.display = 'none';
    }
}

function handleChatKeyPress(event) {
    if (event.key === 'Enter') handleSendChat();
}

function sendQuickReply(text) {
    document.getElementById('chatInput').value = text;
    handleSendChat();
}

function handleSendChat() {
    const inputEl = document.getElementById('chatInput');
    const text = inputEl.value.trim();
    if (!text) return;

    appendChatMessage('user', text);
    inputEl.value = '';

    processChatCommand(text);
}

function appendChatMessage(sender, text) {
    const chatMessages = document.getElementById('chatMessages');
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    msgDiv.innerText = text;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight; 
}

function processChatCommand(text) {
    const lowerText = text.toLowerCase();
    let botResponse = "";

    // 1. IDENTITY & GREETINGS
    if (lowerText.includes('who are you') || lowerText.includes('what do you do') || lowerText.includes('hello')) {
        botResponse = "I am the BizLink AI Assistant! 🤖 I can help you search for Work Orders, sort your rack by urgency or completion, delete unwanted Work Orders, manage visibility toggles, and even undo/redo my actions. How can I help you today?";
    }
    
    // 2. UNDO / REDO
    else if (lowerText === 'undo' || lowerText.includes('undo that')) {
        if (undoStack.length > 0) {
            let currentState = { wos: [...urgentWOs], sort: currentSortMode };
            redoStack.push(currentState);
            let prevState = undoStack.pop();
            applyState(prevState);
            botResponse = "↩️ I have undone your last action.";
        } else {
            botResponse = "There is nothing to undo right now.";
        }
    }
    else if (lowerText === 'redo' || lowerText.includes('redo that')) {
        if (redoStack.length > 0) {
            let currentState = { wos: [...urgentWOs], sort: currentSortMode };
            undoStack.push(currentState);
            let nextState = redoStack.pop();
            applyState(nextState);
            botResponse = "↪️ I have redone your last undone action.";
        } else {
            botResponse = "There is nothing to redo right now.";
        }
    }

    // 3. DELETE WORK ORDERS
    else if (lowerText.includes('delete') || lowerText.includes('remove')) {
        let wosFound = text.match(/\d{7,}/g);
        if (wosFound && wosFound.length > 0) {
            let wosToRemove = wosFound.filter(wo => urgentWOs.includes(wo));
            
            if (wosToRemove.length > 0) {
                saveState();
                isDeletingWOs = true;
                urgentWOs = urgentWOs.filter(wo => !wosToRemove.includes(wo));
                const isAllDeleted = urgentWOs.length === 0;
                
                fetch(`${NODE_BACKEND_URL}/api/urgent-wos/remove`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ wos: wosToRemove, clear_all: isAllDeleted, list_type: currentSearchMode })
                }).then(() => {
                    if (isAllDeleted) {
                        return fetch(`${NODE_BACKEND_URL}/api/urgent-wos/reorder`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ orderedWOs: [], list_type: currentSearchMode })
                        });
                    }
                }).finally(() => {
                    setTimeout(() => {
                        isDeletingWOs = false;
                        syncUrgentRack();
                    }, 1000);
                });
                
                initUrgentRackTable();
                updateMainViews();
                botResponse = `🗑️ I have successfully removed ${wosToRemove.length} Work Order(s) from the rack!`;
            } else {
                botResponse = "I couldn't find those specific Work Orders on the rack to remove.";
            }
        } else {
            botResponse = "Please specify the exact 7+ digit Work Order number(s) you want me to delete (e.g., 'delete 4010745571').";
        }
    }

    // 4. SELECT MOST / LEAST URGENT
    else if ((lowerText.includes('urgent') || lowerText.includes('date') || lowerText.includes('target')) && lowerText.includes('select')) {
        if (urgentWOs.length === 0) {
            botResponse = "There are no Work Orders to analyze!";
        } else {
            let targetWO = null;
            let isLeast = lowerText.includes('least');
            let targetDate = isLeast ? -Infinity : Infinity;

            urgentWOs.forEach(wo => {
                let dateVal = woDates[wo];
                if (dateVal && dateVal > 0) {
                    if (isLeast) {
                        if (dateVal > targetDate) { targetDate = dateVal; targetWO = wo; }
                    } else {
                        if (dateVal < targetDate) { targetDate = dateVal; targetWO = wo; }
                    }
                }
            });

            if (targetWO) {
                document.querySelectorAll('.urgent-checkbox').forEach(cb => cb.checked = false);
                let checkbox = document.querySelector(`.urgent-checkbox[value="${targetWO}"]`);
                if (checkbox) checkbox.checked = true;
                
                updateMainViews();
                let wording = isLeast ? "least urgent" : "most urgent";
                
                const d = new Date(targetDate);
                let dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
                
                botResponse = `📅 I selected WO ${targetWO}! It is the ${wording} with a Target Date of ${dateStr}.`;
            } else {
                botResponse = "I couldn't find valid target dates for the current Work Orders.";
            }
        }
    }

    // 5. FIND MOST / LEAST TOTAL TIME
    else if (lowerText.includes('totaltime') || lowerText.includes('total time')) {
        if (urgentWOs.length === 0) {
            botResponse = "There are no Work Orders on the rack for me to analyze yet!";
        } else {
            let targetWO = null;
            let isFindingLeast = lowerText.includes('least') || lowerText.includes('lowest');
            let targetTime = isFindingLeast ? Infinity : -1;

            urgentWOs.forEach(wo => {
                const data = globalDataCache[wo] || [];
                let wTotalTime = 0;
                
                data.forEach(row => {
                    if (row.MfgLineName && String(row.MfgLineName).includes("WH")) {
                        let isCompleted = false;
                        if (row.ContainerStatus && String(row.ContainerStatus).toLowerCase().includes('completed')) {
                            isCompleted = true;
                        } else if (row.SpecName && String(row.SpecName).includes("Line WH")) {
                            isCompleted = true;
                        }

                        if (!isCompleted) {
                            let orderQty = parseFloat(row.OrderQty) || 0;
                            let manTime = parseFloat(row.ManTime) || 0;
                            wTotalTime += (orderQty * manTime);
                        }
                    }
                });

                if (isFindingLeast) {
                    if (wTotalTime < targetTime) { targetTime = wTotalTime; targetWO = wo; }
                } else {
                    if (wTotalTime > targetTime) { targetTime = wTotalTime; targetWO = wo; }
                }
            });

            if (targetWO) {
                document.querySelectorAll('.urgent-checkbox').forEach(cb => cb.checked = false);
                let checkbox = document.querySelector(`.urgent-checkbox[value="${targetWO}"]`);
                if (checkbox) checkbox.checked = true;
                
                updateMainViews();
                let wording = isFindingLeast ? "least" : "most";
                botResponse = `⏱️ I analyzed the rack and selected WO ${targetWO}! It has the ${wording} TotalTime at ${targetTime.toFixed(2)} hours.`;
            } else {
                botResponse = "I couldn't calculate the TotalTime for the current Work Orders.";
            }
        }
    }

    // 6. TOGGLE VISIBILITY FOR WH, BB (BI), SI
    else if (lowerText.includes('show') || lowerText.includes('only') || lowerText.includes('and')) {
        let lines = [];
        if (lowerText.includes('wh')) lines.push('WH');
        if (lowerText.includes('bb') || lowerText.includes('bi')) lines.push('BB');
        if (lowerText.includes('si')) lines.push('SI');

        if (lines.length > 0) {
            activeLines = lines;
            document.querySelectorAll('.btn-toggle').forEach(btn => {
                if (activeLines.includes(btn.innerText)) btn.classList.add('active');
                else btn.classList.remove('active');
            });
            updateMainViews();
            
            // Re-map 'BB' back to 'BI' for the response if the user used it
            let displayLines = activeLines.map(l => l === 'BB' && lowerText.includes('bi') ? 'BI (BB)' : l);
            botResponse = `✅ I updated the summary to show: ${displayLines.join(', ')}.`;
        } else {
            botResponse = "I didn't recognize which lines you wanted to show. Try saying 'show WH and SI' or 'show BI only'.";
        }
    }

    // 7. SORTING (Highest / Completion)
    else if (lowerText.includes('highest') || lowerText.includes('completion')) {
        saveState();
        currentSortMode = 'completion';
        sortUrgentWOs();
        botResponse = "✅ I have rearranged the rack from Highest Completion Percentage to lowest!";
    }
    
    // 8. SORTING (Urgent / Target Date)
    else if (lowerText.includes('urgent') || lowerText.includes('date') || lowerText.includes('target')) {
        saveState();
        currentSortMode = 'date';
        sortUrgentWOs();
        botResponse = "✅ I have reorganized the rack by Target Date (Most urgent to least urgent).";
    }
    
    // 9. DEFAULT ADD / SEARCH
    else {
        let wosFound = text.match(/\d{7,}/g);
        if (wosFound && wosFound.length > 0) {
            saveState();
            document.getElementById('searchInput').value = wosFound.join(', ');
            searchContainer(); 
            botResponse = `🔍 I am searching the MES database for ${wosFound.length} Work Order(s). They will appear on the left panel shortly!`;
        } else {
            botResponse = "I'm sorry, I didn't quite catch that! You can ask me to rank by urgency, remove a WO, select the one with the most TotalTime, toggle lines, or just type a WO number to add it.";
        }
    }

    setTimeout(() => {
        appendChatMessage('bot', botResponse);
    }, 600);
}

// =========================================================
// 🌐 OVERALL WO STATUS - DATE FORMAT & COLLECT DATA SYNC
// =========================================================

function updateOverallDatesText() {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    const formattedFuture = futureDate.toLocaleDateString('en-US', options);
    const container = document.getElementById('overallEndDateText');
    if (container) {
        container.innerHTML = `End: <strong>${formattedFuture} (+30 Days)</strong>`;
    }
}

function toggleMfgLineFilter(btn) {
    const isActive = btn.classList.contains('active');
    const line = btn.dataset.line;
    if (isActive) {
        btn.classList.remove('active');
        btn.style.opacity = '0.5';
        btn.style.background = '#f5f5f5';
        btn.style.border = '1px solid #d9d9d9';
        btn.style.color = '#888';
        btn.innerHTML = `✗ ${line}`;
    } else {
        btn.classList.add('active');
        btn.style.opacity = '1';
        if (line === '3070_WH') {
            btn.style.background = '#fff2e8';
            btn.style.border = '1px solid #ffbb96';
            btn.style.color = '#fa541c';
        } else if (line === '3070_BB') {
            btn.style.background = '#e6f7ff';
            btn.style.border = '1px solid #91d5ff';
            btn.style.color = '#1890ff';
        } else if (line === '3070_SI') {
            btn.style.background = '#f6ffed';
            btn.style.border = '1px solid #b7eb8f';
            btn.style.color = '#52c41a';
        }
        btn.innerHTML = `✓ ${line}`;
    }
}

async function triggerCollectAllWOData() {
    await collectAllWOData(false);
}

async function collectAllWOData(isSilent = false, forcedLines = null) {
    const btn = document.getElementById('collectAllWoBtn');
    const overlay = document.getElementById('overallLoadingOverlay');
    const progressText = document.getElementById('overallLoadingProgress');
    const progressBar = document.getElementById('overallLoadingBar');
    const statusText = document.getElementById('overallSyncMessage');

    // Retrieve active Manufacturing Line filters, or use forced lines if provided (e.g. for hourly auto-sync)
    let selectedLines = [];
    if (forcedLines) {
        selectedLines = forcedLines;
    } else {
        const activePills = Array.from(document.querySelectorAll('.mfg-line-pill.active'));
        selectedLines = activePills.map(pill => pill.dataset.line);
    }
    
    if (selectedLines.length === 0) {
        showStatus("Please select at least one Manufacturing Line to collect data.", "orange");
        return;
    }

    if (!isSilent) {
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
        }
        if (progressText) progressText.innerText = "Initializing connection to MES database...";
        if (progressBar) progressBar.style.width = '10%';
    }
    
    if (statusText) statusText.innerText = "Syncing... ⏳";

    try {
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 30);
        const yyyy = futureDate.getFullYear();
        const mm = String(futureDate.getMonth() + 1).padStart(2, '0');
        const dd = String(futureDate.getDate()).padStart(2, '0');
        const endDateStr = `${yyyy}-${mm}-${dd}`;

        // Compute dynamic StartDateStart guaranteed to encompass active 2025/2026 WOs (minimum 2025-01-01)
        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - 365);
        const pYyyy = pastDate.getFullYear();
        const pMm = String(pastDate.getMonth() + 1).padStart(2, '0');
        const pDd = String(pastDate.getDate()).padStart(2, '0');
        const computedStartDate = `${pYyyy}-${pMm}-${pDd}`;
        const startDateStr = computedStartDate < "2025-01-01" ? computedStartDate : "2025-01-01";

        let tokenToUse = globalAuthToken || (document.getElementById('authToken') ? document.getElementById('authToken').value.trim() : "");
        if (tokenToUse && !tokenToUse.toLowerCase().startsWith('bearer ')) {
            tokenToUse = `Bearer ${tokenToUse}`;
        }
        const payload = {
            "page": 1,
            "rows": 100000,
            "sort": "",
            "order": "desc",
            "wheres": "[]",
            "MfgOrderName": "",
            "StartDateStart": startDateStr,
            "StartDateEnd": endDateStr,
            "mes_token": tokenToUse
        };

        if (!isSilent && progressText) {
            progressText.innerText = `Querying detailed records for lines: ${selectedLines.join(', ')}...`;
        }
        if (!isSilent && progressBar) {
            progressBar.style.width = '40%';
        }

        let attemptData = [];
        let maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(MES_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (response.status === 429) {
                    console.warn(`[collectAllWOData] 429 Rate limited. Retrying attempt ${attempt}/${maxRetries} in 2s...`);
                    if (!isSilent && progressText) progressText.innerText = `Rate limited (429). Retrying attempt ${attempt}/${maxRetries}...`;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }

                if (response.ok) {
                    const rawResponse = await response.json();
                    if (Array.isArray(rawResponse)) {
                        attemptData = rawResponse;
                    } else if (rawResponse.rows && Array.isArray(rawResponse.rows)) {
                        attemptData = rawResponse.rows;
                    } else if (rawResponse.RTDAT && Array.isArray(rawResponse.RTDAT)) {
                        attemptData = rawResponse.RTDAT;
                    } else if (rawResponse.result) {
                        if (Array.isArray(rawResponse.result)) {
                            attemptData = rawResponse.result;
                        } else if (rawResponse.result.rows && Array.isArray(rawResponse.result.rows)) {
                            attemptData = rawResponse.result.rows;
                        } else if (rawResponse.result.RTDAT && Array.isArray(rawResponse.result.RTDAT)) {
                            attemptData = rawResponse.result.RTDAT;
                        }
                    }

                    if (attemptData.length > 0) break;
                } else {
                    let errMsg = `MES Server returned status ${response.status}`;
                    try {
                        const errData = await response.json();
                        if (errData && errData.error) errMsg = errData.error;
                    } catch (e) {}
                    if (attempt === maxRetries) throw new Error(errMsg);
                }
            } catch (fetchErr) {
                console.warn(`[collectAllWOData] Fetch attempt ${attempt}/${maxRetries} error:`, fetchErr);
                if (attempt === maxRetries && attemptData.length === 0) throw fetchErr;
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        // Fallback Attempt if 0 records returned: broaden start date to 2024-01-01
        if (attemptData.length === 0) {
            console.warn("[collectAllWOData] Primary query returned 0 rows. Attempting fallback query with 2024-01-01...");
            payload.StartDateStart = "2024-01-01";
            try {
                const fbResponse = await fetch(MES_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (fbResponse.ok) {
                    const fbRaw = await fbResponse.json();
                    if (Array.isArray(fbRaw)) attemptData = fbRaw;
                    else if (fbRaw.rows && Array.isArray(fbRaw.rows)) attemptData = fbRaw.rows;
                    else if (fbRaw.RTDAT && Array.isArray(fbRaw.RTDAT)) attemptData = fbRaw.RTDAT;
                }
            } catch (fbErr) {
                console.warn("[collectAllWOData] Fallback query failed:", fbErr);
            }
        }

        // Apply Manufacturing Line filters dynamically, and exclude "Line WH" SpecName! (Case-Insensitive & Cache-Proof!)
        let data = attemptData.filter(row => {
            const line = String(row.MfgLineName || row.mfgLineName || "").trim();
            const matchesLine = selectedLines.some(selected => line.toLowerCase().includes(selected.toLowerCase()));
            
            // Read and normalize SpecName case-insensitively, stripping ALL non-alphanumeric characters (including hidden unicode or non-breaking spaces!)
            const specNameRaw = String(row.SpecName || row.specName || row.specname || row.SPECNAME || "");
            const specNameClean = specNameRaw.toLowerCase().replace(/[^a-z0-9]/gi, '');
            const isNotLineWH = specNameClean !== "linewh";
            
            return matchesLine && isNotLineWH;
        });
        
        console.log(`[Filter] Retrieved ${attemptData.length} total rows. Filtered down to ${data.length} matching lines: ${selectedLines.join(', ')}`);

        if (data.length === 0) {
            throw new Error("MES server returned 0 rows for bulk date query. Please verify connection/token.");
        }

        if (!isSilent && progressText) progressText.innerText = `Retrieved ${data.length} records. Formatting spreadsheet cells...`;
        if (!isSilent && progressBar) progressBar.style.width = '75%';

        // Prepare 2D array matching the columns of WO Detailed Status
        let sheetRows = [colKeys];
        data.forEach(row => {
            sheetRows.push(colKeys.map(key => {
                let val = row[key];
                if (key === "TravelerCard") val = row["TravelerCard"] || row["TraverlerCard"];
                return val !== undefined && val !== null ? String(val).trim() : "";
            }));
        });

        if (!isSilent && progressText) progressText.innerText = `Uploading ${data.length} rows of data to Google Sheets...`;
        if (!isSilent && progressBar) progressBar.style.width = '90%';

        const syncPayload = {
            sync_type: "sync_overall_status",
            records: sheetRows
        };

        await fetch(OVERALL_STATUS_WEBHOOK, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(syncPayload)
        });

        if (!isSilent && progressBar) progressBar.style.width = '100%';
        if (!isSilent && progressText) progressText.innerText = `Successfully updated Sheet1 with ${data.length} records!`;

        // Reload the iframe to show the updated sheet after Google Apps Script finishes processing
        const iframe = document.getElementById('overallSpreadsheetIframe');
        if (iframe) {
            setTimeout(() => {
                let baseUrl = OVERALL_SHEET_URL || "https://docs.google.com/spreadsheets/d/1oNuj3v3-KVyXDayxjPHYMhW6GJXBUoBwwVo__u0HLzI/edit";
                if (!baseUrl.includes('gid=')) baseUrl += '?gid=0';
                iframe.src = `${baseUrl}#gid=0&_t=${Date.now()}`;
            }, 1200);
        }

        if (statusText) {
            const nowTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            statusText.innerText = `Last synced: ${nowTime}${isSilent ? ' (Auto)' : ''} ✅`;
            statusText.style.color = '#52c41a';
        }

        // Restart the countdown timer so that we count down from 1 hour again!
        startOverallSyncCountdown();

        if (!isSilent) {
            setTimeout(() => {
                if (overlay) {
                    overlay.style.opacity = '0';
                    setTimeout(() => {
                        overlay.style.display = 'none';
                        overlay.style.opacity = '1';
                    }, 300);
                }
                showStatus(`Successfully synchronized ${data.length} records to Overall WO Status Sheet!`, "green");
            }, 1500);
        }

    } catch (err) {
        console.error("Failed to collect all WO data:", err);
        if (statusText) statusText.innerText = "Sync failed ❌";
        if (!isSilent) {
            if (overlay) overlay.style.display = 'none';
            showStatus("Failed to retrieve overall WO status data from MES server.", "red");
        }
    }
}

// ==========================================
// ⏱️ OVERALL WO STATUS COUNTDOWN TIMER LOGIC
// ==========================================

function updateCountdownDisplay() {
    const totalSecs = Math.max(0, countdownSecondsLeft);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const formattedTime = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    
    const valEl = document.getElementById('overallCountdownVal');
    if (valEl) {
        valEl.innerText = formattedTime;
    } else {
        const parentEl = document.getElementById('overallCountdown');
        if (parentEl) {
            parentEl.innerHTML = `⏱️ Next Auto-Update: <strong id="overallCountdownVal" style="color: #722ed1;">${formattedTime}</strong>`;
        }
    }
}

let currentSpreadsheetZoom = parseFloat(localStorage.getItem('overall_spreadsheet_zoom')) || 0.75;

function setSpreadsheetZoom(scaleVal) {
    currentSpreadsheetZoom = Math.min(Math.max(scaleVal, 0.4), 1.2);
    const iframe = document.getElementById('overallSpreadsheetIframe');
    const zoomText = document.getElementById('spreadsheetZoomText');
    if (iframe) {
        const dimensionPercent = (100 / currentSpreadsheetZoom).toFixed(2);
        iframe.style.width = `${dimensionPercent}%`;
        iframe.style.height = `${dimensionPercent}%`;
        iframe.style.transform = `scale(${currentSpreadsheetZoom})`;
        iframe.style.transformOrigin = '0 0';
    }
    if (zoomText) {
        zoomText.innerText = `${Math.round(currentSpreadsheetZoom * 100)}%`;
    }
    try {
        localStorage.setItem('overall_spreadsheet_zoom', currentSpreadsheetZoom);
    } catch(e) {}
}

function adjustSpreadsheetZoom(delta) {
    setSpreadsheetZoom(currentSpreadsheetZoom + delta);
}

document.addEventListener('DOMContentLoaded', () => {
    setSpreadsheetZoom(currentSpreadsheetZoom);
});

function handleIntervalChange(val) {
    const mins = parseInt(val, 10) || 30;
    currentIntervalMinutes = mins;
    countdownSecondsLeft = mins * 60;
    
    const sel = document.getElementById('intervalSelect');
    if (sel && sel.value !== String(mins)) {
        sel.value = String(mins);
    }
    
    console.log(`[Auto-Sync] Interval changed to ${mins} minute(s). Countdown set to ${countdownSecondsLeft}s.`);
    updateCountdownDisplay();
}

function resetOverallSyncCountdown() {
    countdownSecondsLeft = currentIntervalMinutes * 60;
    updateCountdownDisplay();
}

function startOverallSyncCountdown() {
    resetOverallSyncCountdown();
}

// Master persistent 1-second ticker loop (singleton)
if (!window.masterSyncTimer) {
    window.masterSyncTimer = setInterval(async () => {
        if (countdownSecondsLeft > 0) {
            countdownSecondsLeft--;
        }
        
        updateCountdownDisplay();
        
        if (countdownSecondsLeft <= 0 && !isAutoSyncing) {
            isAutoSyncing = true;
            console.log(`[Auto-Sync] ${currentIntervalMinutes}-minute window expired. Triggering automated client-side data collection...`);
            
            const syncMsg = document.getElementById('overallSyncMessage');
            if (syncMsg) {
                syncMsg.innerText = "Auto-Syncing... ⏳";
                syncMsg.style.color = "#722ed1";
            }
            
            // Reset countdown immediately for next cycle
            countdownSecondsLeft = currentIntervalMinutes * 60;
            updateCountdownDisplay();
            
            try {
                await collectAllWOData(true, ['3070_WH']);
                console.log("[Auto-Sync] Automated client-side data collection completed successfully!");
            } catch (err) {
                console.error("[Auto-Sync] Error during automated client-side sync:", err);
                if (syncMsg) {
                    syncMsg.innerText = "Auto-Sync failed ❌";
                    syncMsg.style.color = "#ff4d4f";
                }
            } finally {
                isAutoSyncing = false;
            }
        }
    }, 1000);
}

function toggleIntervalDropdown(event) { handleIntervalChange(currentIntervalMinutes); }
function changeSyncInterval(mins, label, event) { handleIntervalChange(mins); }

// Auto-start countdown immediately
try { startOverallSyncCountdown(); } catch(e) {}

/*
// ==========================================
// 📡 LIVE ASSEMBLY QUERY INTEGRATION (DISABLED / COMMENTED OUT)
// ==========================================

// Global variable to store last queried live assembly data for exporting
let lastQueriedLiveAssemblyData = [];

async function queryLiveAssembly() {
    const name = document.getElementById('liveParamName').value.trim();
    const location = document.getElementById('liveParamLocation').value;
    const dataNo = document.getElementById('liveParamDataNo').value.trim();
    const factory = document.getElementById('liveParamFactory').value.trim();
    const section = document.getElementById('liveParamSection').value.trim();
    const algorithm = document.getElementById('liveParamAlgorithm').value.trim();

    const statusDiv = document.getElementById('liveQueryStatus');
    const tableContainer = document.getElementById('liveTableContainer');
    const tableBody = document.getElementById('liveAssemblyBody');
    const exportBtn = document.getElementById('liveExportBtn');

    // Reset view states
    statusDiv.style.display = 'block';
    statusDiv.style.backgroundColor = '#e6f7ff';
    statusDiv.style.color = '#1890ff';
    statusDiv.style.border = '1px solid #91d5ff';
    statusDiv.innerText = '📡 Querying live database... Please wait.';
    tableContainer.style.display = 'none';
    exportBtn.style.display = 'none';
    tableBody.innerHTML = '';
    lastQueriedLiveAssemblyData = [];

    const payload = {
        name: name,
        location: location,
        dataNo: dataNo,
        factory: factory,
        section: section,
        algorithm: algorithm
    };

    try {
        const response = await fetch('/api/assembly-live-query', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            let errorText = 'API error occurred';
            try {
                const errData = await response.json();
                errorText = errData.error || errorText;
            } catch(e) {}
            throw new Error(errorText);
        }

        const resData = await response.json();
        
        // Structure check: The response should contain a 'data' array
        if (!resData || !resData.data || !Array.isArray(resData.data) || resData.data.length === 0) {
            statusDiv.style.backgroundColor = '#fff2e8';
            statusDiv.style.color = '#fa8c16';
            statusDiv.style.border = '1px solid #ffd591';
            statusDiv.innerText = '⚠️ API returned successfully but no assembly records match your parameters.';
            return;
        }

        const dataRows = resData.data;
        lastQueriedLiveAssemblyData = dataRows; // Save reference for XLSX export

        // Render table rows
        let rowsHtml = '';
        dataRows.forEach(row => {
            // Row expected format: ["11A", "Progress", "4010773881", "23.53%"]
            const workstation = row[0] || '';
            const status = row[1] || '';
            const details = row[2] || '';
            const pct = row[3] || '';

            // Color-code the status badges
            let statusBadgeStyle = 'padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase;';
            if (status.toLowerCase().includes('progress')) {
                statusBadgeStyle += 'background-color: #e6f7ff; color: #1890ff; border: 1px solid #91d5ff;';
            } else if (status.toLowerCase().includes('available')) {
                statusBadgeStyle += 'background-color: #f6ffed; color: #52c41a; border: 1px solid #b7eb8f;';
            } else if (status.toLowerCase().includes('occupied')) {
                statusBadgeStyle += 'background-color: #fff2e8; color: #fa8c16; border: 1px solid #ffd591;';
            } else {
                statusBadgeStyle += 'background-color: #f5f5f5; color: #555; border: 1px solid #d9d9d9;';
            }

            rowsHtml += `
                <tr>
                    <td style="padding: 12px 10px; border-bottom: 1px solid #e8e8e8; font-weight: 600; color: #001529;">${workstation}</td>
                    <td style="padding: 12px 10px; border-bottom: 1px solid #e8e8e8;"><span style="${statusBadgeStyle}">${status}</span></td>
                    <td style="padding: 12px 10px; border-bottom: 1px solid #e8e8e8; font-family: monospace; font-size: 13px;">${details || '-'}</td>
                    <td style="padding: 12px 10px; border-bottom: 1px solid #e8e8e8; font-weight: bold; color: #555;">${pct || '-'}</td>
                </tr>
            `;
        });

        tableBody.innerHTML = rowsHtml;
        tableContainer.style.display = 'block';
        exportBtn.style.display = 'inline-block';

        statusDiv.style.backgroundColor = '#f6ffed';
        statusDiv.style.color = '#52c41a';
        statusDiv.style.border = '1px solid #b7eb8f';
        statusDiv.innerText = `✅ Successfully retrieved ${dataRows.length} assembly workstation records.`;

    } catch (err) {
        statusDiv.style.backgroundColor = '#fff1f0';
        statusDiv.style.color = '#ff4d4f';
        statusDiv.style.border = '1px solid #ffccc7';
        statusDiv.innerText = `❌ Error: ${err.message}`;
    }
}

async function exportLiveAssemblyToExcel() {
    if (!lastQueriedLiveAssemblyData || lastQueriedLiveAssemblyData.length === 0) {
        alert('No live assembly records available to export. Please query data first!');
        return;
    }

    try {
        // Construct array-of-arrays representation
        const headers = ["Workstation", "Status", "Work Order / Details", "Completion Percentage"];
        const rows = [headers];

        lastQueriedLiveAssemblyData.forEach(row => {
            rows.push([
                row[0] || '',
                row[1] || '',
                row[2] || '',
                row[3] || ''
            ]);
        });

        const locationVal = document.getElementById('liveParamLocation').value;
        await exportToExcel(rows, "Live Assembly", `Live_Assembly_${locationVal}_${Date.now()}.xlsx`);
    } catch (e) {
        alert(`Failed to export to Excel: ${e.message}`);
    }
}
*/

// 🚀 IMMEDIATE DOMContentLoaded INITIALIZER
document.addEventListener('DOMContentLoaded', function() {
    console.log("[App Init] Local application initialized. Starting countdown timer and main views...");
    
    // Enable horizontal mouse wheel scrolling on top navigation bar
    const topTabs = document.querySelector('.top-tabs');
    if (topTabs) {
        topTabs.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0) {
                e.preventDefault();
                topTabs.scrollLeft += e.deltaY;
            }
        }, { passive: false });
    }

    try {
        startOverallSyncCountdown();
    } catch (err) {
        console.warn("[App Init] Countdown timer start error:", err);
    }
    try {
        updateMainViews();
    } catch (err) {
        console.warn("[App Init] Main views update error:", err);
    }
});

// Trigger immediately if document is already ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    try {
        startOverallSyncCountdown();
    } catch (e) {}
}
