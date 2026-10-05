import { sendDueReminders } from "../../lib/reminders.mjs";

// Runs every day at 05:00 UTC, which is 09:00 in Dubai.
export default async () => {
  const result = await sendDueReminders();
  console.log(JSON.stringify(result));
};

export const config = {
  schedule: "0 5 * * *",
};
