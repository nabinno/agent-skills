// cb-bridge: helper for the agent-skills `cb` wrapper.
//
// CDP has no notion of Chrome profiles' names or of tab groups, so `cb`
// attaches to this service worker over CDP (Runtime.evaluate) and calls the
// functions on `globalThis.cbBridge`. One instance runs per Chrome profile it
// is loaded into; each instance only sees its own profile's tabs.
//
// This extension has no UI, no content scripts, no host permissions and makes
// no network requests. It never reads page contents.

const ADOPTED_KEY = "adopted"; // storage.session: { [tabId]: rootGroupId }

// --- popup adoption ---------------------------------------------------------
// Tabs/popups opened *from* a grouped tab (e.g. OAuth login popups) are not
// always placed in the group (popup windows cannot hold groups). Remember
// their root group so `cb` can treat them as in scope.

async function getAdopted() {
  return (await chrome.storage.session.get(ADOPTED_KEY))[ADOPTED_KEY] ?? {};
}

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId === undefined) return;
  let opener;
  try {
    opener = await chrome.tabs.get(tab.openerTabId);
  } catch {
    return;
  }
  const adopted = await getAdopted();
  const root = opener.groupId !== -1 ? opener.groupId : adopted[opener.id];
  if (root === undefined || root === -1) return;
  adopted[tab.id] = root;
  await chrome.storage.session.set({ [ADOPTED_KEY]: adopted });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const adopted = await getAdopted();
  if (!(tabId in adopted)) return;
  delete adopted[tabId];
  await chrome.storage.session.set({ [ADOPTED_KEY]: adopted });
});

// --- keep the worker reachable ---------------------------------------------
// MV3 workers stop after ~30s idle and then don't appear as CDP targets, so
// `cb` could not reach them. A cheap extension API call every 20s keeps the
// worker alive while the browser runs.
setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
chrome.runtime.onStartup.addListener(() => {});
chrome.runtime.onInstalled.addListener(() => {});

// --- API used by cb ---------------------------------------------------------

const tabView = (t) => ({
  tabId: t.id,
  windowId: t.windowId,
  groupId: t.groupId,
  index: t.index,
  active: t.active,
  url: t.url ?? "",
  title: t.title ?? "",
});

globalThis.cbBridge = {
  version: chrome.runtime.getManifest().version,

  // Identifies which profile this instance runs in (matched against Chrome's
  // Local State by cb). Returns "" if the profile is not signed in.
  async info() {
    const u = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    return { email: u.email ?? "", version: this.version };
  },

  // All groups and all tabs of this profile.
  async snapshot() {
    const [groups, tabs] = await Promise.all([
      chrome.tabGroups.query({}),
      chrome.tabs.query({}),
    ]);
    return {
      groups: groups.map((g) => ({
        groupId: g.id,
        title: g.title ?? "",
        color: g.color,
        windowId: g.windowId,
      })),
      tabs: tabs.map(tabView),
      adopted: await getAdopted(),
    };
  },

  // Create a background tab at `url` inside group `groupId`, or inside a new
  // group titled `title` when groupId is null: in the last focused window, or
  // in a new unfocused window when newWindow is set.
  async createTab({ url, groupId = null, title = "", color = "grey", newWindow = false }) {
    let windowId, tab;
    if (groupId !== null) {
      windowId = (await chrome.tabGroups.get(groupId)).windowId;
    } else if (newWindow) {
      const w = await chrome.windows.create({ url, focused: false, type: "normal" });
      windowId = w.id;
      tab = w.tabs[0];
    } else {
      windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
    }
    tab ??= await chrome.tabs.create({ windowId, url, active: false });
    if (groupId !== null) {
      await chrome.tabs.group({ groupId, tabIds: [tab.id] });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title, color });
    }
    return { tabId: tab.id, groupId };
  },

  // Make a tab the active tab of its window (does not focus the window).
  // Only used by `cb <session> show`, on the user's request.
  async activateTab(tabId) {
    await chrome.tabs.update(tabId, { active: true });
    return true;
  },

  async closeTabs(tabIds) {
    await chrome.tabs.remove(tabIds);
    return true;
  },
};
