import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(
  join(__dirname, "../pawzochat/web/static/modules/moments_unread.js"),
).href;
const {
  getMomentsUnreadAuthors,
  initMomentsUnread,
  markMomentsRead,
  recordUnreadMoment,
  subscribeMomentsUnread,
  unreadMomentAuthors,
} = await import(modUrl);

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

{
  const moments = [
    { author: "alice", author_label: "Alice", timestamp: "2026-08-25T12:00:00Z" },
    { author: "alice", author_label: "Alice", timestamp: "2026-08-25T11:00:00Z" },
    { author: "user", author_label: "我", timestamp: "2026-08-25T10:00:00Z" },
    { author: "bob", author_label: "Bob", timestamp: "2026-08-25T09:00:00Z" },
    { author: "carol", author_label: "Carol", timestamp: "2026-08-25T08:00:00Z" },
    { author: "dave", author_label: "Dave", timestamp: "2026-08-25T07:00:00Z" },
  ];
  assert.deepEqual(
    unreadMomentAuthors(moments, "2026-08-25T06:00:00Z").map(item => item.author),
    ["alice", "bob", "carol"],
  );
  assert.deepEqual(unreadMomentAuthors(moments, "2026-08-25T12:00:00Z"), []);
  assert.deepEqual(
    unreadMomentAuthors([
      { author: "eve", timestamp: "2026-08-25T12:31:00+08:00" },
    ], "2026-08-25T04:30:00Z").map(item => item.author),
    ["eve"],
  );
}

{
  const storage = memoryStorage();
  const api = {
    get: async () => ({
      moments: [{ author: "alice", timestamp: "2026-08-25T12:00:00Z" }],
    }),
  };
  await initMomentsUnread(api, storage);
  assert.deepEqual(getMomentsUnreadAuthors(), []);
  assert.equal(storage.getItem("pawzochat.moments.last_read_at"), "2026-08-25T12:00:00Z");
}

{
  markMomentsRead("2026-08-25T12:00:00Z", memoryStorage());
  const moments = {
    first: { author: "alice", author_label: "Alice", timestamp: "2026-08-25T13:00:00Z" },
    second: { author: "bob", author_label: "Bob", timestamp: "2026-08-25T14:00:00Z" },
    newest: { author: "alice", author_label: "Alice", timestamp: "2026-08-25T15:00:00Z" },
  };
  const api = { get: async path => ({ moment: moments[path.split("/").pop()] }) };
  await recordUnreadMoment(api, "first");
  await recordUnreadMoment(api, "second");
  await recordUnreadMoment(api, "newest");
  assert.deepEqual(
    getMomentsUnreadAuthors().map(item => item.author),
    ["alice", "bob"],
  );
}

{
  const storage = memoryStorage({
    "pawzochat.moments.last_read_at": "2026-08-25T15:00:00Z",
  });
  markMomentsRead("2026-08-25T15:00:00Z", storage);
  const api = {
    get: async () => ({
      moment: { author: "alice", timestamp: "2026-08-25T14:00:00Z" },
    }),
  };
  await recordUnreadMoment(api, "delayed", { storage });
  assert.deepEqual(getMomentsUnreadAuthors(), []);
}

{
  const snapshots = [];
  const unsubscribe = subscribeMomentsUnread(authors => {
    snapshots.push(authors.map(item => item.author));
  });
  const api = {
    get: async () => ({
      moment: {
        author: "alice",
        author_label: "Alice",
        timestamp: "2026-08-25T16:00:00Z",
      },
    }),
  };
  await recordUnreadMoment(api, "new");
  markMomentsRead("2026-08-25T16:00:00Z", memoryStorage());
  unsubscribe();
  assert.deepEqual(snapshots.at(-1), []);
}

console.log("moments unread tests passed");