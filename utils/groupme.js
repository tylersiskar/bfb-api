import fetch from "node-fetch";

// Dev chat bot for cron/self-heal notifications (separate from league chat bot in GROUPME_BOT_ID)
const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID_DEV || "e92a725c167cdf60e08d1b5a1c";
const GROUPME_ACCESS_TOKEN = process.env.GROUPME_ACCESS_TOKEN;
const GROUPME_GROUP_ID = process.env.GROUPME_GROUP_ID;

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_MS = 15 * 1000; // 15 seconds

export async function sendGroupMe(text) {
  try {
    const res = await fetch("https://api.groupme.com/v3/bots/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_id: GROUPME_BOT_ID, text }),
    });
    if (!res.ok) console.error("GroupMe post failed:", res.status);
  } catch (err) {
    console.error("GroupMe post error:", err);
  }
}

export async function fetchRecentMessages(sinceTimestamp) {
  if (!GROUPME_ACCESS_TOKEN || !GROUPME_GROUP_ID) {
    console.error("Missing GROUPME_ACCESS_TOKEN or GROUPME_GROUP_ID");
    return [];
  }

  try {
    const res = await fetch(
      `https://api.groupme.com/v3/groups/${GROUPME_GROUP_ID}/messages?token=${GROUPME_ACCESS_TOKEN}&limit=20`,
    );
    if (!res.ok) {
      console.error("GroupMe fetch messages failed:", res.status);
      return [];
    }
    const data = await res.json();
    const messages = data.response?.messages ?? [];

    return messages.filter(
      (m) => m.sender_type !== "bot" && m.created_at > sinceTimestamp,
    );
  } catch (err) {
    console.error("GroupMe fetch messages error:", err);
    return [];
  }
}

export async function pollForApproval(sinceTimestamp) {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const messages = await fetchRecentMessages(sinceTimestamp);
    const approval = messages.find((m) => /^approve$/i.test(m.text?.trim()));

    if (approval) {
      return { approved: true, approver: approval.name };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return { approved: false };
}
