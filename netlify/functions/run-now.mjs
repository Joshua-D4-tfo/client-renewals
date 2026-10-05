import { sendDueReminders, isAuthorised } from "../../lib/reminders.mjs";

// Manual trigger used by the "Run reminder check" button on the dashboard.
// It follows exactly the same rules as the daily job, so nothing is sent twice.
export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  if (!isAuthorised(req)) {
    return Response.json({ error: "The password is incorrect." }, { status: 401 });
  }

  try {
    return Response.json(await sendDueReminders());
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const config = {
  path: "/api/run-now",
};
