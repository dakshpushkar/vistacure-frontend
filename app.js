const state = {
  screen: "login",
  token: localStorage.getItem("vistacure_token") || "",
  user: null,
  users: [],
  pin: "",
  pickedUser: null,
  dash: null,
  routes: [],
  partyQuery: "",
  partyRoute: "",
  partySort: "due",
  parties: [],
  productQuery: "",
  products: [],
  draft: null,
  partyView: null,
  history: "app",
  bills: [],
  billScope: "today",
  bill: null,
  saved: null,
  report: null,
  reportPeriod: "month",
  calMonth: "",
  calOpen: false,
  reportAnchor: "",
  reportUser: "",
  productView: null,
  queued: JSON.parse(localStorage.getItem("vistacure_queue") || "[]").length,
  saving: false,
  voidOpen: false,
  correctOpen: false,
  billEdit: false,
  requests: [],
  team: [],
  activity: [],
  lang: localStorage.getItem("vistacure_lang") === "hi" ? "hi" : "en",
  navHidden: false,
  offline: false,
};

const $ = (html) => html;
const appEl = () => document.getElementById("app");

function asset(file) {
  return new URL(file, document.baseURI).href;
}

function apiUrl(path) {
  const base = String(window.VISTACURE_API_BASE || "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return base + (path.charAt(0) === "/" ? path : "/" + path);
}

function roleLabel(role) {
  if (role === "super") return t("roleSuper");
  if (role === "admin") return t("roleAdmin");
  if (role === "manager") return t("roleManager");
  return t("roleMr");
}

function isOffice(user) {
  const role = user && user.role;
  return role === "super" || role === "admin";
}

function leads(user) {
  return isOffice(user) || (user && user.role === "manager");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function inr(value) {
  const number = Number(value || 0);
  const abs = Math.abs(number);
  const hasPaise = Math.round(abs * 100) % 100 !== 0;
  const text = abs.toLocaleString("en-IN", {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return (number < 0 ? "-" : "") + "₹" + text;
}

function reportMoney(value) {
  return inr(value);
}

function isoDate(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function todayISO() {
  return isoDate(new Date());
}

function dueClass(value) {
  const number = Number(value || 0);
  if (number > 0) return "due";
  if (number < 0) return "advance";
  return "ok";
}

function dueText(value) {
  const number = Number(value || 0);
  if (number < 0) return t("advance") + " " + inr(Math.abs(number));
  return inr(number);
}

function qtyText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(Math.round(number * 1000) / 1000);
}

function whenLabel(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso).slice(0, 10);
  return date.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function kindLabel(bill) {
  if (bill.voided) return t("voided");
  if (bill.status === "ordered") return t("order");
  if (bill.status === "cancelled") return t("orderCancelled");
  if (bill.kind === "payment") return t("payment");
  if (bill.kind === "import") return t("oldBook");
  return t("supply");
}

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function readCache(path) {
  try {
    const all = JSON.parse(localStorage.getItem("vistacure_cache") || "{}");
    const hit = all[path];
    if (!hit || Date.now() - hit.at > 7 * 24 * 60 * 60 * 1000) return null;
    return hit.data;
  } catch (error) {
    return null;
  }
}

function writeCache(path, data) {
  try {
    const stored = data && data.signature ? Object.assign({}, data, { signature: "" }) : data;
    const all = JSON.parse(localStorage.getItem("vistacure_cache") || "{}");
    all[path] = { at: Date.now(), data: stored };
    const keys = Object.keys(all).sort((a, b) => all[a].at - all[b].at);
    keys.slice(0, Math.max(0, keys.length - 30)).forEach((key) => { delete all[key]; });
    localStorage.setItem("vistacure_cache", JSON.stringify(all));
  } catch (error) { /* the phone is full; the live book still works */ }
}

function readThrough(path, apply, active) {
  const cached = readCache(path);
  if (cached) apply(cached);
  const request = api(path);
  const gate = cached
    ? Promise.race([
      request,
      new Promise((_, reject) => setTimeout(() => {
        const slow = new Error(t("usingPhone"));
        slow.slow = true;
        slow.offline = true;
        reject(slow);
      }, 3500)),
    ])
    : request;
  const done = gate.then((data) => {
    writeCache(path, data);
    apply(data);
    settleNet(true);
    if (active()) render(true);
  }).catch((error) => {
    if (error.slow) {
      state.offline = true;
      if (active()) render(true);
      request.then((data) => {
        writeCache(path, data);
        apply(data);
        settleNet(true);
        if (active()) render(true);
      }).catch(() => {});
      return;
    }
    if (error.status === 401) {
      logout();
      return;
    }
    if (cached) {
      state.offline = true;
      if (active()) render(true);
      return;
    }
    toast(error.offline ? t("offline") : (error.message || t("failed")));
  });
  return cached ? Promise.resolve() : done;
}

async function api(path, options = {}) {
  const headers = { "X-Lang": state.lang || "en", ...(options.body ? { "Content-Type": "application/json" } : {}) };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    const offline = new Error(t("offline"));
    offline.offline = true;
    throw offline;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || t("failed"));
    error.status = response.status;
    throw error;
  }
  return data;
}

function paintNet() {
  const net = document.getElementById("netbar");
  if (!net) return;
  const show = !!(state.user && (state.offline || navigator.onLine === false));
  net.classList.toggle("show", show);
  net.textContent = show ? t("usingPhone") : "";
  document.body.classList.toggle("offline", show);
}

function settleNet(arrived) {
  const wasDown = state.offline;
  state.offline = navigator.onLine === false || !arrived;
  paintNet();
  if (wasDown && !state.offline) toast(t("backOnline"));
}

function enqueue(path, body) {
  const items = JSON.parse(localStorage.getItem("vistacure_queue") || "[]");
  items.push({ path, body });
  localStorage.setItem("vistacure_queue", JSON.stringify(items));
  state.queued = items.length;
}

async function flushQueue() {
  const items = JSON.parse(localStorage.getItem("vistacure_queue") || "[]");
  if (!items.length) return 0;
  const left = [];
  let sent = 0;
  for (let index = 0; index < items.length; index += 1) {
    try {
      await api(items[index].path, { method: "POST", body: items[index].body });
      sent += 1;
    } catch (error) {
      if (error.offline || (error.status || 0) >= 500) {
        left.push(...items.slice(index));
        break;
      }
      toast(error.message || t("oneFailed"));
    }
  }
  localStorage.setItem("vistacure_queue", JSON.stringify(left));
  state.queued = left.length;
  if (sent) toast(t("sentN", { n: sent }));
  return sent;
}

function go(screen, patch = {}, replace = false) {
  state.navHidden = false;
  state.screen = screen;
  Object.assign(state, patch);
  const url = "#" + screen;
  if (replace) history.replaceState({ screen }, "", url);
  else history.pushState({ screen }, "", url);
  render(false);
  window.scrollTo(0, 0);
}

function saleTotal(lines) {
  return Math.round((lines || []).reduce((sum, line) => {
    const qty = Number(line.qty) || 0;
    const rate = line.rate === "" || line.rate == null ? 0 : Number(line.rate) || 0;
    return sum + qty * rate;
  }, 0) * 100) / 100;
}

function paymentValue() {
  const input = document.getElementById("pay");
  const raw = input ? input.value : (state.draft ? state.draft.payment : 0);
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 100) / 100;
}

function render(keepScroll) {
  const active = document.activeElement;
  const focusId = active && active.id;
  const caret = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
  const previous = document.querySelector(".content, .wrap, .login");
  const scroll = previous ? previous.scrollTop : 0;
  document.body.style.overflow = state.calOpen ? "hidden" : "";
  document.body.classList.toggle("role-admin", isOffice(state.user));
  paintNet();
  appEl().innerHTML = screenHtml();
  const next = focusId && document.getElementById(focusId);
  if (next) {
    next.focus();
    if (caret != null && next.setSelectionRange) {
      try { next.setSelectionRange(caret, caret); } catch (error) { /* date inputs */ }
    }
  }
  const scroller = document.querySelector(".content, .wrap, .login");
  if (keepScroll && scroller) scroller.scrollTop = scroll;
  mount();
  keepPeriodChip();
}

function keepPeriodChip() {
  if (state.screen !== "reports") return;
  const row = document.querySelector(".chips.periods");
  const chip = row && row.querySelector(".chip.on");
  if (!row || !chip) return;
  const rowBox = row.getBoundingClientRect();
  const chipBox = chip.getBoundingClientRect();
  const shift = chipBox.left - rowBox.left - (rowBox.width - chipBox.width) / 2;
  row.scrollLeft += shift;
}

function screenHtml() {
  if (!state.user && state.screen !== "login") return loginHtml();
  switch (state.screen) {
    case "home": return homeHtml();
    case "parties": return partiesHtml();
    case "party": return partyHtml();
    case "bill": return billHtml();
    case "sign": return signHtml();
    case "done": return doneHtml();
    case "bills": return billsHtml();
    case "billview": return billViewHtml();
    case "reports": return reportsHtml();
    case "products": return productsHtml();
    case "product": return productHtml();
    case "more": return moreHtml();
    case "people": return peopleHtml();
    case "activity": return activityHtml();
    case "requests": return requestsHtml();
    default: return loginHtml();
  }
}

function paintPin() {
  document.querySelectorAll(".pin-dots i").forEach((dot, index) => {
    dot.classList.toggle("fill", index < state.pin.length);
  });
}

function loginHtml() {
  const dots = [0, 1, 2, 3].map((index) => `<i class="${index < state.pin.length ? "fill" : ""}"></i>`).join("");
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"].map((key) => (
    key === "" ? "<span></span>" : `<button type="button" data-act="digit" data-key="${key}">${key}</button>`
  )).join("");
  return `
    <section class="login">
      <img class="login-logo" src="${asset("logo.png")}" alt="Vistacure Biotech">
      <div class="login-card">
        <h1>${STR.en.enterPin}</h1>
        <p class="sub">${STR.en.pinOpens}</p>
        <div class="pin-dots">${dots}</div>
        <div class="pad-keys">${keys}</div>
      </div>
    </section>`;
}

function navHtml() {
  const admin = leads(state.user);
  const items = admin
    ? [["home", "navHome", "home"], ["parties", "navDues", "dues"], ["reports", "navReports", "reports"], ["more", "navMore", "more"]]
    : [["home", "navHome", "home"], ["parties", "navParties", "parties"], ["bills", "navBills", "bills"], ["more", "navMore", "more"]];
  return `<nav class="tabbar${state.navHidden ? " is-hidden" : ""}" id="tabbar">${items.map(([screen, key, icon]) => `
    <button class="tab ${state.screen === screen ? "on" : ""}" data-act="go" data-screen="${screen}">
      <span class="tab-ico">${ICONS[icon]}</span><span>${t(key)}</span>
    </button>`).join("")}</nav>`;
}

function homeHtml() {
  const dash = state.dash || { today: {}, month: {}, due_total: 0, by_mr: [], top_due: [], recent: [], open_orders: 0 };
  const queue = state.queued ? `<button class="note" data-act="flush" style="width:100%;text-align:left">${t("queue", { n: state.queued })}</button>` : "";
  return `
    <section class="hero">
      <div class="hero-row"><img class="brand-logo" src="${asset("logo-mark.png")}" alt="Vistacure">${langSwitch()}</div>
      <h1>${t("hello", { name: esc(state.user.name) })}</h1>
      <p class="hero-sub">${t("monthBook", { month: dash.month.label || "" })}</p>
      <div class="hero-stats">
        <div><span>${t("todaySale")}</span><strong>${inr(dash.today.sale)}</strong></div>
        <div><span>${t("todayColl")}</span><strong>${inr(dash.today.collection)}</strong></div>
        <div><span>${t("monthSale")}</span><strong>${inr(dash.month.sale)}</strong></div>
        <div><span>${t("monthColl")}</span><strong>${inr(dash.month.collection)}</strong></div>
      </div>
    </section>
    <div class="wrap">
      ${queue}
      <div class="ledger-card">
        <span class="ledger-kicker">${t("totalDue")}</span>
        <div class="big-due ${dueClass(dash.due_total)}">${dueText(dash.due_total)}</div>
        <div class="ledger-pay"><span class="ledger-kicker">${t("totalPaid")}</span><strong>${inr(dash.paid_total || 0)}</strong></div>
        ${dash.open_orders ? `<button class="ghost" data-act="open-orders">${t("openOrders", { n: dash.open_orders })}</button>` : ""}
        ${isOffice(state.user) && dash.pending_edits ? `<button class="ghost" data-act="go" data-screen="requests">${t("pendingN", { n: dash.pending_edits })}</button>` : ""}
      </div>
      <div class="stack">
        <button class="primary" data-act="new-bill">${t("newBill")}<small>${t("newBillSub")}</small></button>
        <button class="secondary" data-act="new-payment">${t("payOnly")}<small>${t("payOnlySub")}</small></button>
      </div>
      <div class="card" style="margin-top:12px">
        <h2>${t("fieldTeam")}</h2>
        ${(dash.by_mr || []).map((mr) => `
          <div class="list-btn">
            <div><strong>${esc(mr.name)}</strong><div class="sub">${t("todayLine", { sale: inr(mr.today_sale), pay: inr(mr.today_collection) })}</div></div>
            <div style="text-align:right"><div class="ok">${inr(mr.month_collection)}</div><div class="sub">${t("monthCollShort")}</div></div>
          </div>`).join("")}
      </div>
      <div class="card">
        <h2>${t("topDue")}</h2>
        ${(dash.top_due || []).map(partyRow).join("") || `<p class="sub">${t("noParty")}</p>`}
      </div>
      <div class="card">
        <h2>${t("newEntries")}</h2>
        ${(dash.recent || []).map(billRow).join("") || `<p class="sub">${t("noNew")}</p>`}
      </div>
    </div>
    ${navHtml()}`;
}

function partyRow(party, act) {
  const action = typeof act === "string" ? act : "open-party";
  return `
    <button class="list-btn" data-act="${action}" data-id="${party.id}">
      <div><strong>${esc(party.name)}</strong><div class="sub">${esc(party.route || party.kind || "")}</div></div>
      <div class="${dueClass(party.due)}">${dueText(party.due)}</div>
    </button>`;
}

function sheetDate(iso) {
  if (!iso) return "";
  const day = String(iso).slice(0, 10);
  const date = new Date(day + "T12:00:00");
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(state.lang === "en" ? "en-IN" : "hi-IN", { day: "numeric", month: "short", year: "numeric" });
}

function billRow(bill) {
  if (bill.source === "sheet") return sheetRow(bill);
  const tag = bill.voided ? "dead" : bill.status === "ordered" ? "warn" : "";
  return `
    <button class="list-btn" data-act="open-bill" data-id="${bill.id}">
      <div>
        <strong>${esc(bill.party_name)}</strong>
        <div class="sub">${esc(bill.bill_no)} · ${esc(whenLabel(bill.created_at))} · ${esc(bill.entered_by || "")}</div>
      </div>
      <div style="text-align:right">
        <div>${bill.kind === "payment" ? inr(bill.payment_amount) : inr(bill.sale_total)}</div>
        <span class="tag ${tag}">${kindLabel(bill)}</span>
      </div>
    </button>`;
}

function sheetRow(bill) {
  const lines = bill.lines || [];
  const opening = lines.some((line) => String(line.product_name || "").toLowerCase().startsWith("opening"));
  const sale = Number(bill.sale_total) || 0;
  const pay = Number(bill.payment_amount) || 0;
  let kind = t("saleLabel");
  if (opening && pay) kind = t("openingWord") + " · " + t("payment");
  else if (opening) kind = t("openingWord");
  else if (sale && pay) kind = t("saleAndPay");
  else if (pay) kind = t("payment");
  const detail = lines
    .filter((line) => !String(line.product_name || "").toLowerCase().startsWith("opening"))
    .map((line) => `${line.product_name} · ${qtyText(line.qty)} × ${inr(line.rate)}`)
    .join(", ");
  const amounts = [];
  if (opening) amounts.push(`<div>${t("openingWord")} ${inr(sale)}</div>`);
  else if (sale) amounts.push(`<div>${t("saleLabel")} ${inr(sale)}</div>`);
  if (pay) amounts.push(`<div class="ok">${t("payment")} ${inr(pay)}</div>`);
  if (!amounts.length) amounts.push(`<div>${inr(0)}</div>`);
  return `
    <button class="list-btn sheet-row" data-act="open-bill" data-id="${bill.id}">
      <div>
        <strong>${esc(sheetDate(bill.supplied_at || bill.created_at))} · ${esc(kind)}</strong>
        ${detail ? `<div class="sub">${esc(detail)}</div>` : ""}
        <div class="sub">${esc(bill.entered_by || t("oldBook"))}${bill.note ? " · " + esc(bill.note) : ""}</div>
      </div>
      <div class="sheet-amt">${amounts.join("")}</div>
    </button>`;
}

function partiesHtml() {
  const chips = ['<button class="chip ' + (state.partyRoute === "" ? "on" : "") + '" data-act="route" data-route="">' + t("all") + "</button>"]
    .concat((state.routes || []).map((route) => `<button class="chip ${state.partyRoute === route ? "on" : ""}" data-act="route" data-route="${esc(route)}">${esc(route)}</button>`))
    .join("");
  return `
    <div class="top"><div><h1>${leads(state.user) ? t("navDues") : t("navParties")}</h1></div></div>
    <div class="wrap">
      <input id="party-q" class="search" placeholder="${esc(t("searchName"))}" value="${esc(state.partyQuery)}">
      <div style="height:8px"></div>
      <div class="chips">
        <button class="chip ${state.partySort === "due" ? "on" : ""}" data-act="sort" data-sort="due">${t("sortDue")}</button>
        <button class="chip ${state.partySort === "name" ? "on" : ""}" data-act="sort" data-sort="name">${t("sortName")}</button>
      </div>
      <div class="chips" style="margin-top:8px">${chips}</div>
      <button class="secondary" data-act="add-party-open" style="margin:16px 0">${t("addParty")}</button>
      ${state.showPartyForm ? `<div class="card">${partyFormHtml()}</div>` : ""}
      <div class="card">${state.parties.map(partyRow).join("") || `<p class="sub">${t("noneFound")}</p>`}</div>
    </div>
    ${navHtml()}`;
}

function partyFormHtml() {
  const routes = (state.routes || []).map((route) => `<option value="${esc(route)}">${esc(route)}</option>`).join("");
  return `
    <div style="margin-top:10px">
      <input id="new-name" class="field" placeholder="${esc(t("partyName"))}">
      <div class="two" style="margin-top:8px">
        <select id="new-kind" class="field">
          <option value="store">${t("store")}</option>
          <option value="doctor">${t("doctor")}</option>
          <option value="hospital">${t("hospital")}</option>
        </select>
        <select id="new-route" class="field"><option value="">${t("route")}</option>${routes}</select>
      </div>
      <input id="new-phone" class="field" style="margin-top:8px" inputmode="tel" placeholder="${esc(t("waOptional"))}">
      <button class="primary" style="margin-top:8px" data-act="add-party-save">${t("save")}</button>
    </div>`;
}

function partyHtml() {
  const party = state.partyView && state.partyView.party;
  if (!party) return `<div class="wrap"><p>${t("loading")}</p></div>${navHtml()}`;
  const admin = isOffice(state.user);
  const bills = (state.partyView.bills || []).map(billRow).join("");
  const editor = admin ? `
        <label class="lbl">${t("partyName")}</label>
        <input id="party-name" class="field" value="${esc(party.name)}" maxlength="80">
        <label class="lbl">${t("route")}</label>
        <input id="party-route" class="field" value="${esc(party.route || "")}" maxlength="60">
        <label class="lbl">${t("waNumber")}</label>
        <input id="phone" class="field" value="${esc(party.phone || "")}" inputmode="tel" placeholder="${esc(t("digits"))}">
        <button class="primary" style="margin-top:8px" data-act="save-party">${t("saveCorrection")}</button>
      ` : `
        <button class="secondary" data-act="toggle-correct">${t("askAdmin")}</button>
        ${state.correctOpen ? `
          <label class="lbl">${t("partyName")}</label>
          <input id="party-name" class="field" value="${esc(party.name)}" maxlength="80">
          <label class="lbl">${t("route")}</label>
          <input id="party-route" class="field" value="${esc(party.route || "")}" maxlength="60">
          <label class="lbl">${t("waNumber")}</label>
          <input id="phone" class="field" value="${esc(party.phone || "")}" inputmode="tel">
          <label class="lbl">${t("askWhy")}</label>
          <input id="correct-reason" class="field" maxlength="300">
          <button class="primary" style="margin-top:8px" data-act="request-party">${t("sendRequest")}</button>
        ` : ""}
      `;
  return `
    <div class="top"><button class="back" data-act="back">←</button><div><h1>${esc(party.name)}</h1><small>${esc(party.route || "")}</small></div></div>
    <div class="wrap">
      <div class="card">
        <span class="muted">${t("dueWithOld")}</span>
        <div class="big-due ${dueClass(party.due)}">${dueText(party.due)}</div>
        <div class="two">
          <button class="primary" data-act="bill-this">${t("billSupply")}</button>
          <button class="secondary" data-act="pay-this">${t("payment")}</button>
        </div>
        ${editor}
      </div>
      <div class="chips party-switch">
        <button class="chip ${state.history === "app" ? "on" : ""}" data-act="history" data-history="app">${t("newEntries")}</button>
        <button class="chip ${state.history === "old" ? "on" : ""}" data-act="history" data-history="old">${t("oldBookCount", { n: state.partyView.old_count || 0 })}</button>
      </div>
      <div class="card history-sum">
        <div><span>${t("oldSales")}</span><strong>${inr((state.partyView.totals || {}).sale || 0)}</strong></div>
        <div><span>${t("oldPays")}</span><strong class="ok">${inr((state.partyView.totals || {}).payment || 0)}</strong></div>
        ${(state.partyView.totals || {}).opening ? `<p class="sub">${t("openingWord")} ${inr(state.partyView.totals.opening)}</p>` : ""}
      </div>
      <div class="card">${bills || `<p class="sub">${t("emptyList")}</p>`}</div>
    </div>
    ${navHtml()}`;
}

function billHtml() {
  const draft = state.draft || { lines: [], kind: "supply" };
  if (!draft.party) {
    const chips = ['<button class="chip ' + (state.partyRoute === "" ? "on" : "") + '" data-act="route" data-route="">' + t("all") + "</button>"]
      .concat((state.routes || []).map((route) => `<button class="chip ${state.partyRoute === route ? "on" : ""}" data-act="route" data-route="${esc(route)}">${esc(route)}</button>`))
      .join("");
    return `
      <div class="top"><button class="back" data-act="back">←</button><div><h1>${draft.kind === "payment" ? t("whoPays") : t("chooseParty")}</h1><small>${draft.kind === "payment" ? t("whoPaysSub") : t("choosePartySub")}</small></div></div>
      <div class="wrap">
        <input id="party-q" class="search" placeholder="${esc(t("searchShort"))}" value="${esc(state.partyQuery)}">
        <div style="height:8px"></div>
        <div class="chips">${chips}</div>
        <div class="card">${(state.parties || []).map((party) => partyRow(party, "choose-party")).join("") || `<p class="sub">${t("searchOrAdd")}</p>`}
          <button class="secondary" data-act="add-party-open">${t("newParty")}</button>
          ${state.showPartyForm ? partyFormHtml() : ""}
        </div>
      </div>`;
  }
  const lines = draft.lines.map((line, index) => `
    <div class="line">
      <div>
        <strong>${esc(line.name)}</strong>
        <div class="sub" id="amt-${index}">${inr((Number(line.qty) || 0) * (Number(line.rate) || 0))}</div>
      </div>
      <div>
        <div class="qty">
          <button data-act="qty" data-i="${index}" data-dir="-1">−</button>
          <input id="qty-${index}" inputmode="decimal" value="${esc(qtyText(line.qty))}">
          <button data-act="qty" data-i="${index}" data-dir="1">+</button>
          <button data-act="remove-line" data-i="${index}">✕</button>
        </div>
        <input id="rate-${index}" class="rate" inputmode="decimal" data-i="${index}" value="${esc(line.rate)}" placeholder="${esc(t("rate"))}" style="margin-top:6px">
      </div>
    </div>`).join("");
  const query = state.productQuery.trim();
  const results = query
    ? ((state.products || []).map((product) => `<button class="list-btn" data-act="add-product" data-id="${product.id}"><div><strong>${esc(product.name)}</strong><div class="sub">${product.mrp ? "MRP " + inr(product.mrp) : esc(product.category || "")}</div></div></button>`).join("") || `<p class="sub">${t("noProduct")}</p>`)
    : `<p class="sub">${t("searchToAdd")}</p>`;
  return `
    <div class="top"><button class="back" data-act="change-party">←</button><div><h1>${esc(draft.party.name)}</h1><small class="${dueClass(draft.dueBefore)}">${t("dueWord")} ${dueText(draft.dueBefore || 0)}</small></div></div>
    <div class="wrap">
      <div class="kind-row">
        <button class="kind-btn ${draft.kind === "supply" ? "on" : ""}" data-act="kind" data-kind="supply">${t("supplyNow")}</button>
        <button class="kind-btn ${draft.kind === "order" ? "on" : ""}" data-act="kind" data-kind="order">${t("orderOnly")}</button>
      </div>
      <div class="card" id="bill-lines">
        <h2>${t("onBill")}</h2>
        ${lines || `<p class="sub">${t("addHint")}</p>`}
      </div>
      <input id="product-q" class="search bill-search" placeholder="${esc(t("searchProduct"))}" value="${esc(state.productQuery)}">
      <div class="card bill-results">${results}</div>
    </div>
    <div class="dock bill-dock">
      <div class="bill-total"><span>${t("total")}</span><strong id="foot-total">${inr(saleTotal(draft.lines))}</strong></div>
      <button class="primary" data-act="${draft.kind === "order" ? "save-order" : "to-sign"}">${draft.kind === "order" ? t("saveOrder") : t("payAndSign")}</button>
    </div>`;
}

function signHtml() {
  const draft = state.draft;
  if (!draft || !draft.party) return `<div class="wrap"><p>${t("chooseParty")}</p></div>`;
  const total = draft.orderId ? Number(draft.saleTotal || 0) : saleTotal(draft.lines);
  const isPayment = draft.kind === "payment";
  return `
    <div class="top"><button class="back" data-act="back">←</button><div><h1>${isPayment ? t("payment") : t("supply")}</h1><small>${esc(draft.party.name)}</small></div></div>
    <div class="wrap">
      <div class="card">
        <p class="note">${t("turnPhone")}</p>
        ${isPayment ? "" : `<div class="sub" style="margin-top:8px">${(draft.lines || []).map((line) => `${esc(line.name)} × ${qtyText(line.qty)} = ${inr((Number(line.qty)||0)*(Number(line.rate)||0))}`).join("<br>")}</div>`}
        <div class="calc" style="margin-top:12px">
          <div><span>${t("oldDue")}</span><b id="old-due">${dueText(draft.dueBefore || 0)}</b></div>
          <div><span>${isPayment ? t("goods") : t("todayGoods")}</span><b id="sale-now">${inr(total)}</b></div>
          <div><span>${t("todayPay")}</span><b id="pay-now">${inr(0)}</b></div>
          <div class="calc-total"><span>${t("newDue")}</span><b id="new-due" class="${dueClass(draft.dueBefore)}">${dueText((draft.dueBefore || 0) + (isPayment ? 0 : total))}</b></div>
        </div>
      </div>
      <label class="lbl">${t("howMuch")}</label>
      <input id="pay" class="field pay-input" inputmode="decimal" placeholder="0" value="${esc(draft.payment || "")}">
      <div class="two" style="margin-top:8px">
        <button class="chip ${draft.mode !== "UPI" ? "on" : ""}" data-act="mode" data-mode="Cash">Cash</button>
        <button class="chip ${draft.mode === "UPI" ? "on" : ""}" data-act="mode" data-mode="UPI">UPI</button>
      </div>
      <label class="lbl">${t("noteOptional")}</label>
      <input id="note" class="field" maxlength="300" placeholder="${esc(t("notePh"))}" value="${esc(draft.note || "")}">
      <label class="lbl">${t("signLabel")}</label>
      <button type="button" class="sign-open" data-act="open-sign">
        <img id="sign-preview" alt="" hidden>
        <span id="sign-open-label">${t("tapSign")}</span>
      </button>
    </div>
    <div class="sign-pop" id="sign-pop">
      <div class="sign-sheet">
        <h2>${t("signPop")}</h2>
        <div class="pad-wrap">
          <span class="pad-hint" id="pad-hint">${t("signHere")}</span>
          <canvas id="pad" class="pad"></canvas>
        </div>
        <div class="two" style="margin-top:12px">
          <button class="ghost" data-act="clear-sign">${t("clearSign")}</button>
          <button class="primary" data-act="close-sign">${t("signDone")}</button>
        </div>
      </div>
    </div>
    <div class="dock">
      <button class="primary" data-act="save-signed">${isPayment ? t("savePayment") : t("saveBill")}</button>
    </div>`;
}

function doneHtml() {
  const bill = state.saved;
  if (!bill) return `<div class="wrap"><p>${t("billMissing")}</p></div>`;
  return `
    <div class="wrap" style="padding-top:28px">
      <div class="card">
        <p class="eyebrow" style="color:var(--green)">${t("saved")}</p>
        <h2>${esc(bill.bill_no)}</h2>
        <p>${esc(bill.party_name)}</p>
        <div class="calc">
          <div><span>${t("goods")}</span><b>${inr(bill.sale_total)}</b></div>
          <div><span>${t("payment")}</span><b>${inr(bill.payment_amount)}</b></div>
          <div class="calc-total"><span>${t("dueAtSign")}</span><b class="${dueClass(bill.due_after)}">${bill.due_after == null ? "-" : dueText(bill.due_after)}</b></div>
        </div>
        ${bill.has_signature ? `<img class="sig-img" alt="signature" src="${bill.signature}">` : `<p class="sub">${t("orderLater")}</p>`}
      </div>
      ${bill.has_signature ? `<button class="primary" data-act="share">${t("sendWa")}</button>` : ""}
      <div style="height:8px"></div>
      <button class="secondary" data-act="again">${t("again")}</button>
      <div style="height:8px"></div>
      <button class="ghost" data-act="go" data-screen="home">${t("navHome")}</button>
    </div>`;
}

function billsHtml() {
  const scopes = [["today", "scopeToday"], ["month", "scopeMonth"], ["orders", "scopeOrders"], ["all", "scopeAll"]];
  return `
    <div class="top"><div><h1>${t("navBills")}</h1><small>${t("billsSub")}</small></div></div>
    <div class="wrap">
      <div class="chips">${scopes.map(([id, key]) => `<button class="chip ${state.billScope === id ? "on" : ""}" data-act="scope" data-scope="${id}">${t(key)}</button>`).join("")}</div>
      <div class="card" style="margin-top:10px">${(state.bills || []).map(billRow).join("") || `<p class="sub">${t("noBills")}</p>`}</div>
    </div>
    ${navHtml()}`;
}

function billEditHtml(bill, admin) {
  if (bill.voided) return "";
  const lines = (bill.lines || []).map((line) => `
    <div class="line">
      <div><strong>${esc(line.product_name)}</strong></div>
      <div class="qty">
        <input class="line-qty" data-id="${line.id}" inputmode="decimal" value="${esc(qtyText(line.qty))}">
        <input class="line-rate" data-id="${line.id}" inputmode="decimal" value="${esc(line.rate)}">
      </div>
    </div>`).join("");
  const fields = `
    ${lines || `<label class="lbl">${t("goods")}</label><input id="edit-sale" class="field" inputmode="decimal" value="${esc(bill.sale_total)}">`}
    <label class="lbl">${t("payment")}</label>
    <input id="edit-pay" class="field" inputmode="decimal" value="${esc(bill.payment_amount)}">
    <label class="lbl">${t("noteOptional")}</label>
    <input id="edit-note" class="field" maxlength="300" value="${esc(bill.note || "")}">
  `;
  if (admin) {
    return `<div style="height:8px"></div><button class="secondary" data-act="toggle-bill-edit">${t("correctBill")}</button>${state.billEdit ? `<div class="card">${fields}<button class="primary" style="margin-top:8px" data-act="save-bill">${t("saveCorrection")}</button></div>` : ""}`;
  }
  return `<div style="height:8px"></div><button class="secondary" data-act="toggle-bill-edit">${t("askAdmin")}</button>${state.billEdit ? `<div class="card">${fields}<label class="lbl">${t("askWhy")}</label><input id="correct-reason" class="field" maxlength="300"><button class="primary" style="margin-top:8px" data-act="request-bill">${t("sendRequest")}</button></div>` : ""}`;
}

function billPayloadFromForm() {
  const lines = [...document.querySelectorAll(".line-qty")].map((qtyInput) => ({
    id: Number(qtyInput.dataset.id),
    qty: qtyInput.value,
    rate: document.querySelector('.line-rate[data-id="' + qtyInput.dataset.id + '"]').value,
  }));
  const sale = document.getElementById("edit-sale");
  return {
    lines,
    payment: document.getElementById("edit-pay").value,
    note: document.getElementById("edit-note").value,
    sale_total: sale ? sale.value : undefined,
  };
}

function requestsHtml() {
  const admin = isOffice(state.user);
  const rows = state.requests || [];
  const items = rows.map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.payload || "{}"); } catch (error) { payload = {}; }
    const detail = row.kind === "party"
      ? [payload.name, payload.route, payload.phone].filter(Boolean).join(" · ")
      : [payload.payment != null && payload.payment !== "" ? `${t("payment")} ${payload.payment}` : "", payload.note || ""].filter(Boolean).join(" · ");
    return `
      <div class="approval-item">
        <strong>${row.kind === "party" ? t("partyName") : t("navBills")}</strong>
        <p class="sub">${t("requestBy", { name: esc(row.requested_name || "") })}</p>
        <p>${esc(row.reason || "")}</p>
        ${detail ? `<p class="sub">${esc(detail)}</p>` : ""}
        ${admin && row.status === "pending" ? `<div class="two" style="margin-top:12px"><button class="primary" data-act="approve-request" data-id="${row.id}">${t("approve")}</button><button class="danger" data-act="reject-request" data-id="${row.id}">${t("reject")}</button></div>` : `<p class="sub">${esc(row.status || "")}</p>`}
      </div>`;
  }).join("");
  return `
    <div class="top"><button class="back" data-act="go" data-screen="more">←</button><div><h1>${t("corrections")}</h1></div></div>
    <div class="wrap"><div class="card">${items || `<p class="sub">${t("noRequests")}</p>`}</div></div>
    ${navHtml()}`;
}

function billViewHtml() {
  const bill = state.bill;
  if (!bill) return `<div class="wrap"><p>${t("loading")}</p></div>`;
  const admin = isOffice(state.user);
  return `
    <div class="top"><button class="back" data-act="back">←</button><div><h1>${esc(bill.bill_no)}</h1><small>${esc(kindLabel(bill))} · ${esc(bill.entered_by || "")}</small></div></div>
    <div class="wrap">
      <div class="card">
        <button class="list-btn" data-act="open-party" data-id="${bill.party_id}"><strong>${esc(bill.party_name)}</strong><span class="sub">${esc(bill.route || "")}</span></button>
        ${(bill.lines || []).map((line) => `<div class="list-btn"><span>${esc(line.product_name)} × ${qtyText(line.qty)} × ${inr(line.rate)}</span><b>${inr(line.amount)}</b></div>`).join("")}
        <div class="calc" style="margin-top:8px">
          <div><span>${t("goods")}</span><b>${inr(bill.sale_total)}</b></div>
          <div><span>${t("payment")} ${esc(bill.payment_mode || "")}</span><b>${inr(bill.payment_amount)}</b></div>
          ${bill.due_before == null ? "" : `<div><span>${t("beforeSign")}</span><b>${dueText(bill.due_before)}</b></div>`}
          ${bill.due_after == null ? "" : `<div class="calc-total"><span>${t("dueAtSign")}</span><b class="${dueClass(bill.due_after)}">${dueText(bill.due_after)}</b></div>`}
        </div>
        ${bill.note ? `<p class="sub">${t("notePrefix", { text: esc(bill.note) })}</p>` : ""}
        ${bill.voided ? `<p class="note">${t("voidedLine", { reason: esc(bill.void_reason), by: esc(bill.voided_by || "") })}</p>` : ""}
        ${bill.signature ? `<img class="sig-img" alt="signature" src="${bill.signature}">` : (bill.has_signature ? `<p class="sub">${t("signOnNet")}</p>` : "")}
      </div>
      ${billEditHtml(bill, admin)}
      ${bill.status === "ordered" && !bill.voided ? `<button class="primary" data-act="supply-order">${t("supplySign")}</button><div style="height:12px"></div><button class="danger" data-act="cancel-order">${t("cancelOrder")}</button>` : ""}
      ${bill.signature ? `<div style="height:12px"></div><button class="secondary" data-act="share">${t("resend")}</button>` : ""}
      ${admin && bill.source === "app" && !bill.voided && bill.status !== "ordered" ? `<div style="height:8px"></div><button class="danger" data-act="void-open">${t("voidBill")}</button>` : ""}
      ${state.voidOpen ? `<div class="card"><label class="lbl">${t("voidWhy")}</label><input id="void-reason" class="field" maxlength="200"><button class="danger" style="margin-top:8px" data-act="void-save">${t("voidConfirm")}</button></div>` : ""}
    </div>`;
}

function calendarMonthDate(report) {
  if (state.calMonth) return new Date(state.calMonth + "-01T12:00:00");
  const today = todayISO();
  if (report && report.start && report.end && today >= report.start && today <= report.end) {
    return new Date(today.slice(0, 7) + "-01T12:00:00");
  }
  const raw = (report && report.start) || today;
  const date = new Date(String(raw).slice(0, 7) + "-01T12:00:00");
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function lastMonthAnchor() {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  return isoDate(date);
}

function reportCalendar(report) {
  const shown = calendarMonthDate(report);
  const year = shown.getFullYear();
  const month = shown.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const pad = shown.getDay();
  const lang = state.lang === "hi" ? "hi-IN" : "en-IN";
  const label = shown.toLocaleDateString(lang, { month: "long", year: "numeric" });
  const weekdays = state.lang === "hi"
    ? ["र", "सो", "मं", "बु", "गु", "शु", "श"]
    : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const busy = new Set((report.days || []).filter((day) => day.sale || day.collection).map((day) => day.day));
  const start = report.start || "";
  const end = report.end || "";
  const span = start && end ? Math.round((new Date(end + "T12:00:00") - new Date(start + "T12:00:00")) / 86400000) : 999;
  const markRange = span <= 100;
  const selected = state.reportPeriod === "day" ? String(state.reportAnchor || report.start || "").slice(0, 10) : "";
  const today = todayISO();
  let cells = weekdays.map((name) => `<span class="dow">${name}</span>`).join("");
  for (let blank = 0; blank < pad; blank += 1) cells += "<span></span>";
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    const classes = [
      selected === iso ? "on" : "",
      markRange && start && iso >= start && iso <= end && selected !== iso ? "in" : "",
      iso === today ? "today" : "",
    ].filter(Boolean).join(" ");
    cells += `<button type="button" class="${classes}" data-act="report-jump" data-period="day" data-anchor="${iso}">${day}${busy.has(iso) ? "<i></i>" : ""}</button>`;
  }
  const picked = state.reportPeriod === "day" && state.reportAnchor
    ? sheetDate(state.reportAnchor)
    : t("pickDate");
  const sheet = state.calOpen ? `
    <div class="cal-overlay" data-act="close-cal">
      <div class="cal-sheet" data-act="cal-sheet">
        <div class="cal-head">
          <button type="button" data-act="report-cal" data-dir="-1" aria-label="Previous">‹</button>
          <strong>${esc(label)}</strong>
          <button type="button" data-act="report-cal" data-dir="1" aria-label="Next">›</button>
        </div>
        <div class="cal-grid">${cells}</div>
      </div>
    </div>` : "";
  return `
    <button type="button" class="date-open" data-act="toggle-cal">${esc(picked)}</button>
    ${sheet}`;
}

function reportsHtml() {
  const report = state.report;
  if (!report) return `<div class="wrap"><p>${t("loading")}</p></div>${navHtml()}`;
  const period = state.reportPeriod || "month";
  const lastMonth = lastMonthAnchor();
  const lastOn = period === "month" && String(state.reportAnchor || "").slice(0, 7) === lastMonth.slice(0, 7);
  const maxPerson = Math.max(1, ...(report.people || []).map((person) => Math.max(person.sale, person.collection)));
  const people = (report.people || []).map((person) => `
    <${person.id ? "button" : "div"} class="person ${String(state.reportUser) === String(person.id) ? "on" : ""}" ${person.id ? `data-act="report-user" data-id="${person.id}"` : ""}>
      <strong>${esc(person.name || t("oldBook"))}</strong>
      <small>${reportMoney(person.sale)} ${t("saleWord")} · ${reportMoney(person.collection)} ${t("payWord")}</small>
      <div class="bar" style="margin-top:8px"><span style="width:${Math.max(person.collection ? 6 : 0, person.collection / maxPerson * 100)}%"></span></div>
    </${person.id ? "button" : "div"}>`).join("");
  const products = (report.products || []).map((item) => `
    <div class="list-btn"><div><strong>${esc(item.name)}</strong><div class="sub">${qtyText(item.qty)}</div></div><b>${reportMoney(item.amount)}</b></div>`).join("");
  const chosen = (report.people || []).find((person) => String(person.id) === String(state.reportUser));
  return `
    <div class="top"><div><h1>${t("navReports")}</h1><small>${esc(report.label || "")}${chosen ? " · " + esc(chosen.name) : ""}</small></div></div>
    <div class="wrap">
      <div class="chips periods">
        <button class="chip ${period === "day" && !state.reportAnchor ? "on" : ""}" data-act="report-jump" data-period="day" data-anchor="">${t("today")}</button>
        <button class="chip ${period === "week" && !state.reportAnchor ? "on" : ""}" data-act="report-jump" data-period="week" data-anchor="">${t("thisWeek")}</button>
        <button class="chip ${period === "month" && !state.reportAnchor ? "on" : ""}" data-act="report-jump" data-period="month" data-anchor="">${t("thisMonth")}</button>
        <button class="chip ${lastOn ? "on" : ""}" data-act="report-jump" data-period="month" data-anchor="${lastMonth}">${t("lastMonth")}</button>
        <button class="chip ${period === "quarter" && !state.reportAnchor ? "on" : ""}" data-act="report-jump" data-period="quarter" data-anchor="">${t("thisQuarter")}</button>
        <button class="chip ${period === "year" && !state.reportAnchor ? "on" : ""}" data-act="report-jump" data-period="year" data-anchor="">${t("thisYear")}</button>
        ${state.reportUser ? `<button class="chip on" data-act="report-user" data-id="">${t("allPeople")}</button>` : ""}
      </div>
      ${reportCalendar(report)}
      <div class="report-hero">
        <div class="report-sale"><span>${t("saleLabel")}</span><strong>${inr(report.sale)}</strong></div>
        <div class="report-pay"><span>${t("payment")}</span><strong class="ok">${inr(report.collection)}</strong></div>
      </div>
      <div class="card"><h2>${t("peopleReport")}</h2>${people || `<p class="sub">${t("noneFound")}</p>`}</div>
      ${products ? `<div class="card"><h2>${t("products")}</h2>${products}</div>` : ""}
    </div>
    ${navHtml()}`;
}

function productsHtml() {
  const admin = isOffice(state.user);
  const rows = (state.products || []).map((product) => `
    <button class="list-btn" data-act="open-product" data-id="${product.id}">
      <div><strong>${esc(product.name)}</strong><div class="sub">${t("sold")} ${qtyText(product.sold_qty || 0)} · ${inr(product.sold_amount || 0)}</div></div>
      <div style="text-align:right"><b>${product.left == null ? "—" : qtyText(product.left)}</b><div class="sub">${t("left")}${product.low ? " · " + t("lowStock") : ""}</div></div>
    </button>`).join("");
  return `
    <div class="top"><button class="back" data-act="go" data-screen="more">←</button><div><h1>${t("products")}</h1><small>${t("nameAndMrp")}</small></div></div>
    <div class="wrap">
      ${admin ? `<div class="card">
        <h2>${t("newProduct")}</h2>
        <label class="lbl">${t("personName")}</label>
        <input id="prod-name" class="field" maxlength="80">
        <div class="two" style="margin-top:12px">
          <div><label class="lbl">${t("buyPrice")}</label><input id="prod-buy" class="field" inputmode="decimal"></div>
          <div><label class="lbl">MRP</label><input id="prod-mrp" class="field" inputmode="decimal"></div>
        </div>
        <label class="lbl">${t("packWord")}</label>
        <input id="prod-pack" class="field" placeholder="Strip / File">
        <button class="primary" style="margin-top:16px" data-act="add-product-save">${t("add")}</button>
      </div>` : ""}
      <input id="catalog-q" class="search" placeholder="${esc(t("searchProduct"))}" value="${esc(state.productQuery)}">
      <div class="card" style="margin-top:16px">${rows || `<p class="sub">${t("noneFound")}</p>`}</div>
    </div>`;
}

function productHtml() {
  const view = state.productView;
  if (!view || !view.product) return `<div class="wrap"><p>${t("loading")}</p></div>`;
  const product = view.product;
  const admin = isOffice(state.user);
  const today = (() => {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  })();
  const prices = (view.prices || []).map((row) => `
    <div class="approval-item">
      <strong>${inr(row.buy_price)}</strong>
      <p class="sub">${row.effective_on < "2001-01-01" ? t("olderBills") : esc(row.effective_on)}${row.added_by ? " · " + esc(row.added_by) : ""}</p>
    </div>`).join("");
  const batches = (view.batches || []).map((batch) => `
    <div class="approval-item">
      <strong>${esc(batch.batch_no)}</strong>
      <p>${qtyText(batch.qty)}${batch.buy_price != null ? " · " + t("buyPrice") + " " + inr(batch.buy_price) : ""}${batch.mrp ? " · MRP " + inr(batch.mrp) : ""}</p>
      <p class="sub">${batch.note ? esc(batch.note) : ""}${batch.expiry ? (batch.note ? " · " : "") + esc(t("expiry")) + " " + esc(batch.expiry) : ""}</p>
    </div>`).join("");
  return `
    <div class="top"><button class="back" data-act="go" data-screen="products">←</button><div><h1>${esc(product.name)}</h1><small>${esc(product.pack || "")}</small></div></div>
    <div class="wrap">
      <div class="card">
        <span class="muted">${view.left == null ? t("sold") : t("left")}</span>
        <div class="big-due">${qtyText(view.left == null ? (view.sold_qty || 0) : view.left)}</div>
        <p class="sub">${view.left == null ? inr(view.sold_amount || 0) : t("sold") + " " + qtyText(view.sold_qty || 0) + " · " + inr(view.sold_amount || 0)}${product.buy_price != null ? " · " + t("buyPrice") + " " + inr(product.buy_price) : ""}${product.mrp ? " · MRP " + inr(product.mrp) : ""}</p>
        <p class="sub">${view.left == null ? t("leftUnknown") : (view.opening == null ? "" : t("openingStock") + " " + qtyText(view.opening) + " · " + t("stockIn") + " " + qtyText(view.received || 0))}${view.low ? " · " + t("lowStock") : ""}</p>
      </div>
      ${admin ? `<div class="card">
        <h2>${t("addStock")}</h2>
        <label class="lbl">${t("batchNo")}</label>
        <input id="batch-no" class="field" maxlength="40">
        <div class="two" style="margin-top:12px">
          <div><label class="lbl">${t("expiry")}</label><input id="batch-expiry" class="field" type="date"></div>
          <div><label class="lbl">${t("stockQty")}</label><input id="batch-qty" class="field" inputmode="decimal"></div>
        </div>
        <div class="two" style="margin-top:12px">
          <div><label class="lbl">${t("buyPrice")}</label><input id="batch-buy" class="field" inputmode="decimal" value="${product.buy_price || ""}"></div>
          <div><label class="lbl">MRP</label><input id="batch-mrp" class="field" inputmode="decimal" value="${product.mrp || ""}"></div>
        </div>
        <button class="primary" style="margin-top:16px" data-act="add-stock">${t("addStock")}</button>
      </div>
      <div class="card">
        <h2>${t("editProduct")}</h2>
        <label class="lbl">${t("personName")}</label>
        <input id="edit-name" class="field" maxlength="80" value="${esc(product.name)}">
        <label class="lbl">${t("packWord")}</label>
        <input id="edit-pack" class="field" maxlength="40" value="${esc(product.pack || "")}">
        <div class="two" style="margin-top:12px">
          <div><label class="lbl">${t("buyPrice")}</label><input id="buy-price" class="field" inputmode="decimal" value="${product.buy_price ?? ""}"></div>
          <div><label class="lbl">MRP</label><input id="edit-mrp" class="field" inputmode="decimal" value="${product.mrp ?? ""}"></div>
        </div>
        ${product.buy_price != null ? `<label class="lbl">${t("priceFrom")}</label><input id="price-from" class="field" type="date" value="${today}"><p class="sub">${t("priceFromNote")}</p>` : `<p class="sub">${t("firstPriceNote")}</p>`}
        <button class="primary" style="margin-top:16px" data-act="save-product">${t("save")}</button>
        <button class="danger" style="margin-top:12px" data-act="remove-product">${t("removeProduct")}</button>
      </div>
      ${prices ? `<div class="card"><h2>${t("priceHistory")}</h2>${prices}</div>` : ""}` : ""}
      <div class="card">${batches || `<p class="sub">${t("noBatch")}</p>`}</div>
    </div>`;
}

function moreHtml() {
  const role = state.user.role;
  const office = isOffice(state.user);
  const links = [];
  if (office) links.push(["people", "people", "peopleHint"], ["activity", "activity", "activityHint"]);
  links.push(["requests", "corrections", "correctionsHint"]);
  if (office) links.push(["products", "stockMenu", "stockHint"]);
  if (office || role === "manager") links.push(["bills", "allNewBills", "billsHint"]);
  const menu = links.map(([screen, key, hint]) => `
    <button class="list-btn" data-act="go" data-screen="${screen}"><div><strong>${t(key)}</strong><div class="sub">${t(hint)}</div></div><span aria-hidden="true">›</span></button>`).join("");
  const initial = String(state.user.name || "?").trim().charAt(0).toUpperCase() || "?";
  return `
    <div class="top"><div><h1>${t("navMore")}</h1></div>${langSwitch()}</div>
    <div class="wrap">
      <div class="card"><div class="profile"><div class="avatar">${esc(initial)}</div><div><strong>${esc(state.user.name)}</strong><span>${roleLabel(role)}</span></div></div></div>
      <div class="card">${menu}</div>
      <div class="card">
        <h2>${t("changePin")}</h2>
        <input id="old-pin" class="field" inputmode="numeric" maxlength="4" placeholder="${esc(t("oldPin"))}">
        <input id="new-pin" class="field" style="margin-top:12px" inputmode="numeric" maxlength="4" placeholder="${esc(t("newPin"))}">
        <button class="primary" style="margin-top:16px" data-act="change-pin">${t("savePin")}</button>
      </div>
      <div class="card">
        <h2>${t("homeScreen")}</h2>
        <p class="sub">${t("homeScreenHelp")}</p>
        <button class="ghost" style="margin-top:12px" data-act="install">${t("install")}</button>
      </div>
      <button class="danger" data-act="logout">${t("logout")}</button>
    </div>
    ${navHtml()}`;
}

function peopleHtml() {
  const viewer = state.user.role;
  const addChoices = viewer === "super" ? ["admin"] : ["mr", "manager"];
  const roleChips = (selected, choices) => `
    <div class="chips">
      ${choices.map((choice) => `<button type="button" class="chip ${selected === choice ? "on" : ""}" data-act="pick-role" data-role="${choice}">${roleLabel(choice)}</button>`).join("")}
    </div>`;
  const cards = (state.team || []).map((person) => {
    const locked = person.role === "super";
    const field = person.role === "mr" || person.role === "manager";
    const editable = !locked && (viewer === "super" ? !field : field);
    const choices = viewer === "super" ? ["admin", "manager", "mr"] : ["mr", "manager"];
    return `
    <div class="card" data-person="${person.id}">
      <h2>${esc(person.name)}</h2>
      ${locked ? `<p class="sub">${t("superStays")}</p>` : editable ? `
        ${roleChips(person.role, choices)}
        <label class="lbl">${t("newPinOptional")}</label>
        <input id="pin-${person.id}" class="field" inputmode="numeric" maxlength="4" autocomplete="off">
        <button class="primary" style="margin-top:16px" data-act="save-person" data-id="${person.id}">${t("savePerson")}</button>
      ` : `<p class="sub">${roleLabel(person.role)}</p>`}
    </div>`;
  }).join("");
  return `
    <div class="top"><button class="back" data-act="go" data-screen="more">←</button><div><h1>${t("people")}</h1><small>${t("peopleSub")}</small></div></div>
    <div class="wrap">
      <p class="note">${t("officeNote")}</p>
      <div style="height:16px"></div>
      <div class="card" data-person="new">
        <h2>${t("addPerson")}</h2>
        <label class="lbl">${t("personName")}</label>
        <input id="person-name" class="field" maxlength="40" autocomplete="off">
        ${roleChips(addChoices[0], addChoices)}
        <label class="lbl">${t("firstPin")}</label>
        <input id="person-pin" class="field" inputmode="numeric" maxlength="4" autocomplete="off">
        <button class="primary" style="margin-top:16px" data-act="add-person">${t("add")}</button>
      </div>
      ${cards}
    </div>`;
}

function activityHtml() {
  const labels = { party: t("actParty"), bill: t("actBill"), approve: t("actApprove"), reject: t("actReject"), void: t("actVoid"), person: t("actPerson"), role: t("actRole"), product: t("actProduct"), "product-edit": t("actProductEdit"), "product-remove": t("actProductRemove"), stock: t("actStock") };
  const rows = (state.activity || []).map((row) => {
    const when = row.created_at ? new Date(row.created_at).toLocaleString(state.lang === "en" ? "en-IN" : "hi-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
    return `<div class="approval-item"><strong>${esc(row.user_name || "")}</strong><p>${esc(labels[row.action] || row.action)}</p><p class="sub">${esc(row.detail || "")}</p><p class="sub">${esc(when)}</p></div>`;
  }).join("");
  return `
    <div class="top"><button class="back" data-act="go" data-screen="more">←</button><div><h1>${t("activity")}</h1></div></div>
    <div class="wrap"><div class="card">${rows || `<p class="sub">${t("activityEmpty")}</p>`}</div></div>`;
}

function mount() {
  updateTotals();
}

function openSign() {
  const pop = document.getElementById("sign-pop");
  const canvas = document.getElementById("pad");
  if (!pop || !canvas) return;
  pop.classList.add("on");
  document.body.style.overflow = "hidden";
  if (!canvas.dataset.ready) setupPad(canvas);
}

function closeSign() {
  const pop = document.getElementById("sign-pop");
  if (pop) pop.classList.remove("on");
  document.body.style.overflow = "";
  const canvas = document.getElementById("pad");
  const preview = document.getElementById("sign-preview");
  const label = document.getElementById("sign-open-label");
  if (canvas && preview && canvas.dataset.ink === "1") {
    preview.src = canvas.toDataURL("image/png");
    preview.hidden = false;
    if (label) label.hidden = true;
  }
}

function setupPad(canvas) {
  canvas.dataset.ready = "1";
  const scale = window.devicePixelRatio || 1;
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * scale));
    canvas.height = Math.max(1, Math.floor(rect.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.lineWidth = 3.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#14221c";
  };
  resize();
  const ctx = () => canvas.getContext("2d");
  let drawing = false;
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    const source = event.touches ? event.touches[0] : event;
    return [source.clientX - rect.left, source.clientY - rect.top];
  };
  const start = (event) => {
    drawing = true;
    canvas.dataset.ink = "1";
    const hint = document.getElementById("pad-hint");
    if (hint) hint.style.display = "none";
    const [x, y] = point(event);
    ctx().beginPath();
    ctx().moveTo(x, y);
    event.preventDefault();
  };
  const move = (event) => {
    if (!drawing) return;
    const [x, y] = point(event);
    ctx().lineTo(x, y);
    ctx().stroke();
    event.preventDefault();
  };
  const end = () => { drawing = false; };
  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.clearPad = () => {
    const rect = canvas.getBoundingClientRect();
    ctx().clearRect(0, 0, rect.width, rect.height);
    canvas.dataset.ink = "";
    const hint = document.getElementById("pad-hint");
    if (hint) hint.style.display = "";
  };
}

function padHasInk(canvas) {
  if (!canvas || canvas.dataset.ink !== "1") return false;
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let index = 3; index < data.length; index += 16) {
    if (data[index] > 20) count += 1;
    if (count > 8) return true;
  }
  return false;
}

function updateTotals() {
  if (!state.draft || state.screen !== "sign") {
    const foot = document.getElementById("foot-total");
    if (foot && state.draft) foot.textContent = inr(saleTotal(state.draft.lines));
    return;
  }
  const draft = state.draft;
  const total = draft.orderId ? Number(draft.saleTotal || 0) : saleTotal(draft.lines);
  const pay = paymentValue();
  const base = Number(draft.dueBefore || 0);
  const next = Math.round((base + (draft.kind === "payment" ? 0 : total) - pay) * 100) / 100;
  const payNow = document.getElementById("pay-now");
  const saleNow = document.getElementById("sale-now");
  const neu = document.getElementById("new-due");
  if (payNow) payNow.textContent = inr(pay);
  if (saleNow) saleNow.textContent = inr(draft.kind === "payment" ? 0 : total);
  if (neu) {
    neu.textContent = dueText(next);
    neu.className = dueClass(next);
  }
}

function linesLookValid(lines) {
  if (!lines.length) {
    toast(t("addProduct"));
    return false;
  }
  for (const line of lines) {
    if (!(Number(line.qty) > 0)) {
      toast(t("enterQty"));
      return false;
    }
    if (line.rate === "" || line.rate == null || Number(line.rate) < 0 || Number.isNaN(Number(line.rate))) {
      toast(t("enterRate", { name: line.name }));
      return false;
    }
  }
  return true;
}

function readLinesFromDom() {
  if (!state.draft) return;
  state.draft.lines.forEach((line, index) => {
    const qty = document.getElementById("qty-" + index);
    const rate = document.getElementById("rate-" + index);
    if (qty) line.qty = qty.value;
    if (rate) line.rate = rate.value;
  });
  const note = document.getElementById("note");
  const pay = document.getElementById("pay");
  if (note) state.draft.note = note.value;
  if (pay) state.draft.payment = pay.value;
}

function billPayload(kind, signature) {
  const draft = state.draft;
  const lines = (draft.lines || []).map((line) => ({
    product_id: line.product_id,
    name: line.name,
    qty: Number(line.qty),
    rate: Number(line.rate),
  }));
  return {
    kind,
    party_id: draft.party.id,
    lines,
    payment_amount: kind === "order" ? 0 : paymentValue(),
    payment_mode: draft.mode || "Cash",
    note: (document.getElementById("note") && document.getElementById("note").value) || draft.note || "",
    route: draft.party.route || "",
    signature: signature || "",
    signed_name: draft.party.name,
  };
}

function refreshDash() {
  return readThrough("/api/dashboard", (data) => {
    state.dash = data;
    state.routes = data.routes || state.routes;
  }, () => state.screen === "home");
}

function loadParties() {
  const path = `/api/parties?q=${encodeURIComponent(state.partyQuery)}&route=${encodeURIComponent(state.partyRoute)}&sort=${state.partySort}&limit=60`;
  return readThrough(path, (data) => {
    state.parties = data.parties || [];
    state.routes = data.routes || state.routes;
  }, () => state.screen === "parties" || (state.screen === "bill" && state.draft && !state.draft.party));
}

function loadProducts(catalog) {
  const useCatalog = catalog || state.screen === "products" || state.screen === "product";
  const path = "/api/products?q=" + encodeURIComponent(state.productQuery) + (useCatalog ? "&catalog=1" : "");
  return readThrough(path, (data) => {
    state.products = data.products || [];
  }, () => state.screen === "bill" || state.screen === "products");
}

function openParty(id, history) {
  state.history = history || state.history || "app";
  state.correctOpen = false;
  const path = `/api/parties/${id}?history=${state.history === "old" ? "old" : "app"}`;
  const cached = readCache(path);
  if (cached) state.partyView = cached;
  const task = readThrough(path, (data) => { state.partyView = data; }, () => state.screen === "party");
  if (cached) {
    if (state.screen === "party") render(true);
    else go("party");
    return task;
  }
  return task.then(() => { if (state.partyView) go("party"); });
}

function startDraft(party, kind) {
  state.draft = {
    party,
    dueBefore: party.due || 0,
    lastRates: (state.partyView && state.partyView.last_rates) || {},
    lines: [],
    kind,
    payment: "",
    mode: "Cash",
    note: "",
    orderId: null,
    saleTotal: 0,
  };
  state.productQuery = "";
  state.partyQuery = "";
  if (kind === "payment") go("sign");
  else go("bill");
}

async function selectParty(id) {
  const path = "/api/parties/" + id + "?history=app";
  const apply = (data) => {
    state.partyView = data;
    if (!state.draft) state.draft = { lines: [], kind: "supply", mode: "Cash", payment: "", note: "" };
    state.draft.party = data.party;
    state.draft.dueBefore = data.party.due || 0;
    state.draft.lastRates = data.last_rates || {};
  };
  const cached = readCache(path);
  if (cached) apply(cached);
  else {
    try {
      const data = await api(path);
      writeCache(path, data);
      apply(data);
    } catch (error) {
      toast(error.offline ? t("offline") : (error.message || t("failed")));
      return;
    }
  }
  if (cached) {
    api(path).then((data) => {
      writeCache(path, data);
      if (state.draft && state.draft.party && String(state.draft.party.id) === String(id)) apply(data);
    }).catch(() => {
      state.offline = true;
      render(true);
    });
  }
  if (state.draft.kind === "payment") {
    go("sign");
    return;
  }
  if (!cached) {
    state.products = [];
    state.productQuery = "";
  }
  render(false);
  loadProducts();
}

function addProduct(product) {
  readLinesFromDom();
  const existing = state.draft.lines.find((line) => line.product_id === product.id);
  if (existing) {
    existing.qty = (Number(existing.qty) || 0) + 1;
    state.draft.lines = [existing, ...state.draft.lines.filter((line) => line !== existing)];
  } else {
    const remembered = state.draft.lastRates[String(product.id)] ?? state.draft.lastRates[product.name];
    const rate = remembered != null ? remembered : (product.mrp != null ? product.mrp : "");
    state.draft.lines.unshift({ product_id: product.id, name: product.name, qty: 1, rate });
  }
  state.productQuery = "";
  render(false);
  window.scrollTo(0, 0);
}

async function saveSigned() {
  if (state.saving) return;
  const draft = state.draft;
  if (!draft || !draft.party) return;
  readLinesFromDom();
  if (draft.kind !== "payment" && !draft.orderId && !linesLookValid(draft.lines)) return;
  const pay = paymentValue();
  if (draft.kind === "payment" && pay <= 0) {
    toast(t("enterPay"));
    return;
  }
  const canvas = document.getElementById("pad");
  if (!padHasInk(canvas)) {
    toast(t("needSign"));
    return;
  }
  const signature = canvas.toDataURL("image/png");
  const path = draft.orderId ? `/api/bills/${draft.orderId}/supply` : "/api/bills";
  const body = draft.orderId ? {
    payment_amount: pay,
    payment_mode: draft.mode || "Cash",
    note: (document.getElementById("note") || {}).value || "",
    signature,
    signed_name: draft.party.name,
  } : billPayload(draft.kind, signature);
  state.saving = true;
  try {
    const bill = await api(path, { method: "POST", body });
    state.saved = bill;
    state.saving = false;
    go("done");
    refreshDash();
  } catch (error) {
    state.saving = false;
    if (error.offline) {
      enqueue(path, body);
      toast(t("savedOffline"));
      go("home");
    } else toast(error.message);
  }
}

async function saveOrder() {
  if (state.saving) return;
  readLinesFromDom();
  if (!linesLookValid(state.draft.lines)) return;
  const body = billPayload("order", "");
  state.saving = true;
  try {
    state.saved = await api("/api/bills", { method: "POST", body });
    state.saving = false;
    go("done");
  } catch (error) {
    state.saving = false;
    if (error.offline) {
      enqueue("/api/bills", body);
      toast(t("orderOffline"));
      go("home");
    } else toast(error.message);
  }
}

async function shareBill(bill) {
  const lines = (bill.lines || []).map((line) => `${line.product_name} x ${qtyText(line.qty)} = ${inr(line.amount)}`).join("\n");
  const caption = [
    "Vistacure Biotech Pvt. Ltd.",
    t("navBills") + " " + bill.bill_no,
    t("partyWord") + ": " + bill.party_name,
    lines,
    t("total") + ": " + inr(bill.sale_total),
    t("todayPay") + ": " + inr(bill.payment_amount) + (bill.payment_mode ? " (" + bill.payment_mode + ")" : ""),
    bill.due_after == null ? "" : t("dueWord") + ": " + dueText(bill.due_after),
    "MR: " + (bill.entered_by || ""),
  ].filter(Boolean).join("\n");
  const canvas = await receiptCanvas(bill);
  canvas.toBlob(async (blob) => {
    const file = new File([blob], bill.bill_no + ".png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: bill.bill_no, text: caption });
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = bill.bill_no + ".png";
    link.click();
    const phone = String(bill.party_phone || "").replace(/\D/g, "");
    const wa = "https://wa.me/" + (phone.length >= 10 ? "91" + phone.slice(-10) : "") + "?text=" + encodeURIComponent(caption);
    window.open(wa, "_blank");
  }, "image/png");
}

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function receiptCanvas(bill) {
  const width = 800;
  const lines = bill.lines || [];
  const signature = await loadImage(bill.signature);
  const logo = await loadImage(asset("logo.png"));
  const logoW = 220;
  const logoH = logo ? Math.round(logoW * logo.height / logo.width) : 0;
  const top = logo ? 24 + logoH + 36 : 120;
  const height = top + 250 + lines.length * 42 + (signature ? 220 : 40);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  if (logo) {
    ctx.drawImage(logo, 36, 20, logoW, logoH);
    ctx.fillStyle = "#0e6b45";
    ctx.fillRect(36, 24 + logoH + 8, 120, 4);
  } else {
    ctx.fillStyle = "#0e6b45";
    ctx.font = "700 32px sans-serif";
    ctx.fillText("Vistacure Biotech Pvt. Ltd.", 36, 46);
  }
  ctx.fillStyle = "#14221c";
  ctx.font = "700 26px sans-serif";
  let y = top;
  ctx.fillText(bill.bill_no + "   " + whenLabel(bill.supplied_at || bill.created_at), 36, y);
  y += 40;
  ctx.font = "22px sans-serif";
  ctx.fillText(t("partyWord") + ": " + bill.party_name, 36, y);
  y += 32;
  ctx.fillText("MR: " + (bill.entered_by || "-") + (bill.route ? "   " + t("route") + ": " + bill.route : ""), 36, y);
  y += 36;
  ctx.strokeStyle = "#d5e3db";
  ctx.beginPath();
  ctx.moveTo(36, y);
  ctx.lineTo(width - 36, y);
  ctx.stroke();
  y += 34;
  lines.forEach((line) => {
    ctx.fillStyle = "#14221c";
    ctx.font = "22px sans-serif";
    ctx.fillText(line.product_name, 36, y);
    ctx.textAlign = "right";
    ctx.fillText(qtyText(line.qty) + " × " + inr(line.rate) + " = " + inr(line.amount), width - 36, y);
    ctx.textAlign = "left";
    y += 40;
  });
  y += 8;
  const rows = [
    [t("goods"), inr(bill.sale_total)],
    [t("payment"), inr(bill.payment_amount)],
    [t("dueAtSign"), bill.due_after == null ? "-" : dueText(bill.due_after)],
  ];
  rows.forEach((row, index) => {
    ctx.font = index === 2 ? "700 26px sans-serif" : "22px sans-serif";
    ctx.fillText(row[0], 36, y);
    ctx.textAlign = "right";
    ctx.fillText(row[1], width - 36, y);
    ctx.textAlign = "left";
    y += 36;
  });
  if (bill.voided) {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-0.4);
    ctx.strokeStyle = "rgba(159,18,57,0.8)";
    ctx.lineWidth = 6;
    ctx.font = "700 80px sans-serif";
    ctx.strokeText(t("voided"), -110, 0);
    ctx.restore();
  }
  if (signature) {
    y += 10;
    ctx.font = "18px sans-serif";
    ctx.fillStyle = "#5d6d64";
    ctx.fillText(t("signature"), 36, y);
    ctx.drawImage(signature, 36, y + 8, 360, 140);
  }
  return canvas;
}

let partyTimer;
let productTimer;
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event;
});

document.getElementById("app").addEventListener("click", async (event) => {
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;
  try {
    if (act === "lang") {
      state.lang = target.dataset.lang === "en" ? "en" : "hi";
      localStorage.setItem("vistacure_lang", state.lang);
      document.documentElement.lang = state.lang === "en" ? "en-IN" : "hi";
      render(true);
    } else if (act === "pick-user") {
      state.pickedUser = Number(target.dataset.id);
      state.pin = "";
      render(false);
    } else if (act === "digit") {
      const key = target.dataset.key;
      if (key === "⌫") state.pin = state.pin.slice(0, -1);
      else if (state.pin.length < 4) state.pin += key;
      paintPin();
      if (state.pin.length === 4) {
        const data = await api("/api/login", { method: "POST", body: { pin: state.pin } });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem("vistacure_token", data.token);
        localStorage.setItem("vistacure_user", JSON.stringify(data.user));
        state.pin = "";
        await flushQueue();
        await refreshDash();
        go("home", {}, true);
      }
    } else if (act === "go") {
      const screen = target.dataset.screen;
      if (screen === "parties") await loadParties();
      if (screen === "bills") await loadBillList();
      if (screen === "reports") await loadReport();
      if (screen === "products") {
        state.productQuery = "";
        await loadProducts(true);
      }
      if (screen === "home") await refreshDash();
      if (screen === "requests") await loadRequests();
      if (screen === "people") await loadTeam();
      if (screen === "activity") await loadActivity();
      go(screen);
    } else if (act === "back") {
      history.back();
    } else if (act === "new-bill") {
      state.draft = { party: null, lines: [], kind: "supply", mode: "Cash", payment: "", note: "" };
      state.partyQuery = "";
      state.showPartyForm = false;
      await loadParties();
      go("bill");
    } else if (act === "new-payment") {
      state.draft = { party: null, lines: [], kind: "payment", mode: "Cash", payment: "", note: "" };
      state.partyQuery = "";
      await loadParties();
      go("bill");
    } else if (act === "choose-party") {
      await selectParty(target.dataset.id);
    } else if (act === "open-party") {
      await openParty(target.dataset.id, "app");
    } else if (act === "open-bill") {
      const path = "/api/bills/" + target.dataset.id;
      const cached = readCache(path);
      state.voidOpen = false;
      if (cached) {
        state.bill = cached;
        go("billview");
      }
      await readThrough(path, (data) => { state.bill = data; }, () => state.screen === "billview" && String(state.bill && state.bill.id) === String(target.dataset.id));
      if (!cached && state.bill) go("billview");
    } else if (act === "route") {
      state.partyRoute = target.dataset.route;
      await loadParties();
    } else if (act === "sort") {
      state.partySort = target.dataset.sort;
      await loadParties();
    } else if (act === "add-party-open") {
      state.showPartyForm = !state.showPartyForm;
      render(true);
    } else if (act === "add-party-save") {
      const created = await api("/api/parties", {
        method: "POST",
        body: {
          name: document.getElementById("new-name").value,
          kind: document.getElementById("new-kind").value,
          route: document.getElementById("new-route").value,
          phone: document.getElementById("new-phone").value,
        },
      });
      state.showPartyForm = false;
      toast(created.existed ? t("partyExists") : t("partyAdded"));
      if (state.screen === "bill") await selectParty(created.id);
      else await loadParties();
    } else if (act === "bill-this") {
      startDraft(state.partyView.party, "supply");
      loadProducts();
    } else if (act === "pay-this") {
      startDraft(state.partyView.party, "payment");
    } else if (act === "toggle-correct" || act === "toggle-bill-edit") {
      if (act === "toggle-correct") state.correctOpen = !state.correctOpen;
      else state.billEdit = !state.billEdit;
      render(true);
    } else if (act === "save-party") {
      const id = state.partyView.party.id;
      await api("/api/parties/" + id, {
        method: "POST",
        body: {
          name: document.getElementById("party-name").value,
          route: document.getElementById("party-route").value,
          phone: document.getElementById("phone").value,
        },
      });
      toast(t("nameSaved"));
      await openParty(id, state.history);
    } else if (act === "request-party") {
      await api("/api/requests", {
        method: "POST",
        body: {
          kind: "party",
          target_id: state.partyView.party.id,
          reason: document.getElementById("correct-reason").value,
          payload: {
            name: document.getElementById("party-name").value,
            route: document.getElementById("party-route").value,
            phone: document.getElementById("phone").value,
          },
        },
      });
      state.correctOpen = false;
      toast(t("requestSent"));
      render(true);
    } else if (act === "save-bill") {
      state.bill = await api("/api/bills/" + state.bill.id + "/edit", { method: "POST", body: billPayloadFromForm() });
      state.billEdit = false;
      toast(t("nameSaved"));
      render(false);
    } else if (act === "request-bill") {
      await api("/api/requests", {
        method: "POST",
        body: {
          kind: "bill",
          target_id: state.bill.id,
          reason: document.getElementById("correct-reason").value,
          payload: billPayloadFromForm(),
        },
      });
      state.billEdit = false;
      toast(t("requestSent"));
      render(true);
    } else if (act === "approve-request" || act === "reject-request") {
      const decision = act === "approve-request" ? "approve" : "reject";
      await api("/api/requests/" + target.dataset.id + "/" + decision, { method: "POST", body: {} });
      state.requests = (await api("/api/requests")).requests || [];
      toast(t(decision === "approve" ? "approve" : "reject"));
      render(false);
    } else if (act === "history") {
      await openParty(state.partyView.party.id, target.dataset.history);
    } else if (act === "open-party-row") {
      await selectParty(target.dataset.id);
    } else if (act === "kind") {
      readLinesFromDom();
      state.draft.kind = target.dataset.kind;
      render(true);
    } else if (act === "add-product") {
      const product = state.products.find((item) => String(item.id) === target.dataset.id);
      if (product) addProduct(product);
    } else if (act === "qty") {
      readLinesFromDom();
      const line = state.draft.lines[Number(target.dataset.i)];
      const next = Math.round(((Number(line.qty) || 0) + Number(target.dataset.dir)) * 1000) / 1000;
      line.qty = next > 0 ? next : line.qty;
      render(true);
    } else if (act === "remove-line") {
      readLinesFromDom();
      state.draft.lines.splice(Number(target.dataset.i), 1);
      render(true);
    } else if (act === "change-party") {
      state.draft.party = null;
      state.draft.lines = [];
      await loadParties();
      render(false);
    } else if (act === "to-sign") {
      readLinesFromDom();
      if (!linesLookValid(state.draft.lines)) return;
      go("sign");
    } else if (act === "save-order") {
      await saveOrder();
    } else if (act === "mode") {
      state.draft.mode = target.dataset.mode;
      document.querySelectorAll("[data-act=mode]").forEach((button) => {
        button.classList.toggle("on", button.dataset.mode === state.draft.mode);
      });
    } else if (act === "open-sign") {
      openSign();
    } else if (act === "close-sign") {
      closeSign();
    } else if (act === "clear-sign") {
      const canvas = document.getElementById("pad");
      if (canvas && canvas.clearPad) canvas.clearPad();
      const preview = document.getElementById("sign-preview");
      const label = document.getElementById("sign-open-label");
      if (preview) preview.hidden = true;
      if (label) label.hidden = false;
    } else if (act === "save-signed") {
      await saveSigned();
    } else if (act === "share") {
      shareBill(state.saved || state.bill);
    } else if (act === "again") {
      const party = state.partyView && state.partyView.party && state.partyView.party.id === state.saved.party_id
        ? { ...state.partyView.party, due: state.saved.due_after }
        : { id: state.saved.party_id, name: state.saved.party_name, route: state.saved.route, due: state.saved.due_after, phone: state.saved.party_phone };
      startDraft(party, "supply");
      loadProducts();
    } else if (act === "scope") {
      state.billScope = target.dataset.scope;
      await loadBillList();
      render(false);
    } else if (act === "supply-order") {
      const bill = state.bill;
      state.draft = {
        party: { id: bill.party_id, name: bill.party_name, route: bill.route, phone: bill.party_phone, due: 0 },
        dueBefore: 0,
        lines: bill.lines.map((line) => ({ product_id: line.product_id, name: line.product_name, qty: line.qty, rate: line.rate })),
        kind: "supply",
        payment: "",
        mode: "Cash",
        note: bill.note || "",
        orderId: bill.id,
        saleTotal: bill.sale_total,
      };
      const fresh = await api("/api/parties/" + bill.party_id + "?history=app");
      state.draft.dueBefore = fresh.party.due;
      state.draft.party.due = fresh.party.due;
      go("sign");
    } else if (act === "cancel-order") {
      state.bill = await api("/api/bills/" + state.bill.id + "/cancel", { method: "POST", body: {} });
      toast(t("orderCancelledToast"));
      render(false);
    } else if (act === "void-open") {
      state.voidOpen = true;
      render(true);
    } else if (act === "void-save") {
      const reason = document.getElementById("void-reason").value.trim();
      state.bill = await api("/api/bills/" + state.bill.id + "/void", { method: "POST", body: { reason } });
      state.voidOpen = false;
      toast(t("billVoided"));
      render(false);
    } else if (act === "flush") {
      await flushQueue();
      await refreshDash();
      render(false);
    } else if (act === "open-orders") {
      state.billScope = "orders";
      await loadBillList();
      go("bills");
    } else if (act === "toggle-cal") {
      state.calOpen = !state.calOpen;
      if (state.calOpen && !state.calMonth) state.calMonth = todayISO().slice(0, 7);
      render(true);
    } else if (act === "close-cal") {
      state.calOpen = false;
      render(true);
    } else if (act === "cal-sheet") {
      return;
    } else if (act === "report-jump") {
      state.reportPeriod = target.dataset.period || "month";
      state.reportAnchor = target.dataset.anchor || "";
      state.calMonth = state.reportAnchor ? String(state.reportAnchor).slice(0, 7) : "";
      state.calOpen = false;
      await loadReport();
      if (state.screen !== "reports") go("reports");
      else render(true);
    } else if (act === "report-cal") {
      const dir = Number(target.dataset.dir) || 0;
      const base = calendarMonthDate(state.report);
      base.setMonth(base.getMonth() + dir);
      state.calMonth = base.getFullYear() + "-" + String(base.getMonth() + 1).padStart(2, "0");
      render(true);
    } else if (act === "report-user") {
      state.reportUser = state.reportUser === target.dataset.id ? "" : (target.dataset.id || "");
      await loadReport();
      render(true);
    } else if (act === "open-product") {
      await openProduct(target.dataset.id);
    } else if (act === "save-product") {
      const from = document.getElementById("price-from");
      await api("/api/products/" + state.productView.product.id, {
        method: "POST",
        body: {
          name: document.getElementById("edit-name").value,
          pack: document.getElementById("edit-pack").value,
          mrp: document.getElementById("edit-mrp").value,
          buy_price: document.getElementById("buy-price").value,
          effective_on: from ? from.value : "",
        },
      });
      toast(t("productSaved"));
      await openProduct(state.productView.product.id);
    } else if (act === "remove-product") {
      const product = state.productView.product;
      if (!window.confirm(t("removeAsk", { name: product.name }))) return;
      await api("/api/products/" + product.id, { method: "POST", body: { remove: true } });
      toast(t("productRemoved"));
      state.productQuery = "";
      await loadProducts(true);
      go("products");
    } else if (act === "add-stock") {
      await api("/api/products/" + state.productView.product.id + "/stock", {
        method: "POST",
        body: {
          batch_no: document.getElementById("batch-no").value,
          expiry: document.getElementById("batch-expiry").value,
          qty: document.getElementById("batch-qty").value,
          mrp: document.getElementById("batch-mrp").value,
          buy_price: document.getElementById("batch-buy").value,
        },
      });
      toast(t("stockAdded"));
      await openProduct(state.productView.product.id);
    } else if (act === "add-product-save") {
      await api("/api/products", {
        method: "POST",
        body: {
          name: document.getElementById("prod-name").value,
          mrp: document.getElementById("prod-mrp").value,
          buy_price: document.getElementById("prod-buy").value,
          pack: document.getElementById("prod-pack").value,
        },
      });
      toast(t("productAdded"));
      state.productQuery = "";
      await loadProducts();
    } else if (act === "pick-role") {
      const box = target.closest("[data-person]");
      if (!box) return;
      box.querySelectorAll("[data-act=pick-role]").forEach((el) => el.classList.toggle("on", el === target));
    } else if (act === "add-person") {
      const box = document.querySelector('[data-person="new"]');
      const roleBtn = box && box.querySelector("[data-act=pick-role].on");
      const created = await api("/api/users", {
        method: "POST",
        body: {
          name: document.getElementById("person-name").value,
          role: roleBtn ? roleBtn.dataset.role : "mr",
          pin: document.getElementById("person-pin").value,
        },
      });
      toast(t("personAdded", { name: created.name }));
      await loadTeam();
      render(true);
    } else if (act === "save-person") {
      const box = target.closest("[data-person]");
      const roleBtn = box && box.querySelector("[data-act=pick-role].on");
      const pinBox = document.getElementById("pin-" + target.dataset.id);
      const saved = await api("/api/users/" + target.dataset.id, {
        method: "POST",
        body: { role: roleBtn ? roleBtn.dataset.role : "mr", pin: pinBox ? pinBox.value : "" },
      });
      if (state.user && String(state.user.id) === String(saved.id)) {
        state.user.role = saved.role;
        localStorage.setItem("vistacure_user", JSON.stringify(state.user));
      }
      toast(t("personSaved"));
      await loadTeam();
      render(true);
    } else if (act === "change-pin") {
      await api("/api/pin", { method: "POST", body: { old: document.getElementById("old-pin").value, new: document.getElementById("new-pin").value } });
      toast(t("pinChanged"));
    } else if (act === "install") {
      if (!deferredPrompt) toast(t("installHint"));
      else {
        deferredPrompt.prompt();
        deferredPrompt = null;
      }
    } else if (act === "logout") {
      logout();
    }
  } catch (error) {
    if (act === "digit") {
      state.pin = "";
      paintPin();
    }
    toast(error.message || t("failed"));
  }
});

document.getElementById("app").addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "party-q") {
    state.partyQuery = target.value;
    clearTimeout(partyTimer);
    partyTimer = setTimeout(loadParties, 180);
  } else if (target.id === "catalog-q") {
    state.productQuery = target.value;
    loadProducts();
  } else if (target.id === "product-q") {
    state.productQuery = target.value;
    clearTimeout(productTimer);
    productTimer = setTimeout(loadProducts, 180);
  } else if (target.id === "pay") {
    if (state.draft) state.draft.payment = target.value;
    updateTotals();
  } else if (target.id && target.id.startsWith("rate-")) {
    const index = Number(target.id.slice(5));
    state.draft.lines[index].rate = target.value;
    const amount = document.getElementById("amt-" + index);
    const line = state.draft.lines[index];
    if (amount) amount.textContent = inr((Number(line.qty) || 0) * (Number(line.rate) || 0));
    updateTotals();
  } else if (target.id && target.id.startsWith("qty-")) {
    const index = Number(target.id.slice(4));
    state.draft.lines[index].qty = target.value;
    const amount = document.getElementById("amt-" + index);
    const line = state.draft.lines[index];
    if (amount) amount.textContent = inr((Number(line.qty) || 0) * (Number(line.rate) || 0));
    updateTotals();
  } else if (target.id === "note" && state.draft) {
    state.draft.note = target.value;
  }
});

function loadBillList() {
  return readThrough("/api/bills?scope=" + state.billScope, (data) => {
    state.bills = data.bills || [];
  }, () => state.screen === "bills");
}

function loadReport() {
  const query = new URLSearchParams({
    period: state.reportPeriod || "month",
    anchor: state.reportAnchor || "",
    user: state.reportUser || "",
  });
  return readThrough("/api/reports?" + query.toString(), (data) => { state.report = data; }, () => state.screen === "reports");
}

function openProduct(id) {
  const path = "/api/products/" + id;
  const cached = readCache(path);
  if (cached) state.productView = cached;
  const task = readThrough(path, (data) => { state.productView = data; }, () => state.screen === "product");
  if (cached) {
    if (state.screen === "product") render(true);
    else go("product");
    return task;
  }
  return task.then(() => { if (state.productView) go("product"); });
}

function loadRequests() {
  return readThrough("/api/requests", (data) => { state.requests = data.requests || []; }, () => state.screen === "requests");
}

function loadTeam() {
  return readThrough("/api/users", (data) => { state.team = data.users || []; }, () => state.screen === "people");
}

function loadActivity() {
  return readThrough("/api/activity", (data) => { state.activity = data.activity || []; }, () => state.screen === "activity");
}

function logout() {
  const token = state.token;
  state.token = "";
  state.user = null;
  localStorage.removeItem("vistacure_token");
  localStorage.removeItem("vistacure_user");
  if (token) fetch(apiUrl("/api/logout"), { method: "POST", headers: { Authorization: "Bearer " + token } }).catch(() => {});
  go("login", {}, true);
}

window.addEventListener("popstate", (event) => {
  const screen = (event.state && event.state.screen) || (state.user ? "home" : "login");
  state.screen = screen;
  render(false);
});

let lastScrollY = 0;
window.addEventListener("scroll", () => {
  const bar = document.getElementById("tabbar");
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  if (!bar) {
    lastScrollY = y;
    return;
  }
  const delta = y - lastScrollY;
  if (y < 16) state.navHidden = false;
  else if (delta > 10) state.navHidden = true;
  else if (delta < -10) state.navHidden = false;
  bar.classList.toggle("is-hidden", state.navHidden);
  lastScrollY = y;
}, { passive: true });

async function boot() {
  document.documentElement.lang = state.lang === "en" ? "en-IN" : "hi";
  if ("serviceWorker" in navigator) navigator.serviceWorker.register(new URL("sw.js", document.baseURI)).catch(() => {});
  window.addEventListener("online", () => {
    state.offline = false;
    paintNet();
    flushQueue().then(() => refreshDash());
  });
  window.addEventListener("offline", () => {
    state.offline = true;
    if (state.user) render(true);
    else paintNet();
  });
  if (!state.token) {
    render(false);
    return;
  }
  const savedUser = JSON.parse(localStorage.getItem("vistacure_user") || "null");
  const savedDash = readCache("/api/dashboard");
  if (savedUser && savedDash) {
    state.user = savedUser;
    state.dash = savedDash;
    state.routes = savedDash.routes || state.routes;
    go("home", {}, true);
  }
  try {
    state.user = await api("/api/me");
    localStorage.setItem("vistacure_user", JSON.stringify(state.user));
    await flushQueue();
    await refreshDash();
    if (state.screen !== "home") go("home", {}, true);
    else render(true);
  } catch (error) {
    if (error.status === 401) logout();
    else {
      state.user = savedUser;
      if (savedDash) {
        state.dash = savedDash;
        state.routes = savedDash.routes || state.routes;
      }
      if (state.user) {
        state.offline = true;
        if (state.screen !== "home") go("home", {}, true);
        else render(true);
      } else render(false);
    }
  }
}

boot();
